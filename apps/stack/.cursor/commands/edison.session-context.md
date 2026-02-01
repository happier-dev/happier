<!-- EDISON:GENERATED id=session-context platform=cursor -->

# edison.session-context

Prints a small, deterministic context refresher intended for:
- Claude Code hooks (SessionStart/PreCompact/UserPromptSubmit)
- Quick in-chat refresh without running full `session next`

## Usage

```bash
edison session context
```


## When to use

- After context compaction
- When you want a quick refresh without full orchestration output

## Related
- /edison.session-next
- /edison.session-status
