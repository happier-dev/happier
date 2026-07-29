@../../AGENTS.md

# CLI Daemon Notes

This subdirectory owns the background daemon process, local HTTP control server, backend machine socket, session tracking, and daemon lifecycle state.

When editing daemon code:
- Reuse daemon-owned lifecycle/control helpers instead of adding ad hoc process management.
- Keep binary-safe runtime behavior: do not require system Node/package managers in first-party runtime paths.
- Treat process spawning, local HTTP auth, state-file compatibility, and session tracking as runtime behavior; use TDD for behavior changes.
- Run the CLI package test/typecheck lanes before handoff.
