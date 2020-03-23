var items = [
    1, 2, 3, 4, 5, 6, 7, 8
]

<div class="row">

    {% for item in items %}
    <div class="col-md-3">{{ item }}</div>

        <!-- if last column in row -->
        {% if forloop.counter | divisibleby:"4" and not forloop.last %}
        </div><div class="row">
        {% endif %}

    {% endfor %}

</div>
