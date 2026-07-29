# Claude Code for Happier Stack

Follow `apps/stack/AGENTS.md` and the repository root `AGENTS.md` for stack-specific and cross-repo instructions. Read either file only when its instructions are not already present in active context or may have changed.

Background subagents cannot prompt for missing tool permissions. If a tool call is denied because it is not allowed in `.claude/settings.json`, fail fast and report the exact tool, command, and missing permission. Do not retry permission-denied calls in a loop.
