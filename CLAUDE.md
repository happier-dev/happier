# Claude Code

@AGENTS.md

## TypeScript commands

Follow the canonical TypeScript compiler-ownership rules in `AGENTS.md`. Use repository/package typecheck and build scripts; `yarn tsc ...` is safe from the repository root and every TypeScript-owning workspace, and delegates to the native compiler runner. For a direct ad hoc check, use `node scripts/workspaces/runTypeScriptCli.mjs ...`. Do not run bare `tsc`, `npx tsc`, `node_modules/.bin/tsc`, or `typescript/bin/tsc`: compilation must use the centrally resolved native TypeScript 7 compiler, while the `typescript` package remains TypeScript 5.9 only for programmatic API compatibility.
