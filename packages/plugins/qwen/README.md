Qwen plugin package for the Stage E.3 thin ACP extraction pilot.

This package owns the Qwen agent definition and ACP backend activation through
`ctx.acp.defineAcpBackend(...)`. The former host-local Qwen backend and UI
provider owners have been folded into plugin metadata plus generated CLI/UI
projections.
