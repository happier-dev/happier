// This wrapper exists because some integrations (notably the Claude Agent SDK)
// treat `.js` as a script entrypoint and will spawn it via Node, while `.cjs`
// may be treated as an executable and fail with EACCES in sandboxed test runs.
//
// Note: `packages/tests` is ESM ("type": "module"), so this file must use `import`.
import './fake-claude-code-cli.cjs';
