<!-- EDISON:GENERATED id=task-blocked platform=cursor -->

# edison.task-blocked

Lists todo tasks that are blocked by unmet `depends_on` prerequisites,
and explains which dependency is blocking and its current state.

## Usage

```bash
edison task blocked
```


## When to use

- You expected a task to show up in `task ready` but it doesn't
- You want an explanation for dependency blocking

## Related
- /edison.task-ready
- /edison.task-status
