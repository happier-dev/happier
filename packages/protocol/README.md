# @happier-dev/protocol

Shared cross-package contracts between Happier CLI and Happier app.

This package is intentionally small and should only contain stable protocol-level
types/constants that both sides need (e.g. RPC result shapes, error codes).

## Module-level schemas

Declare top-level schemas through `lazySchema(() => ...)` (`src/lazySchema.ts`). Every
process that imports this package (each session runner, the daemon, the app) would
otherwise build all ~22k zod instances at startup, about 20 MB per runner, while it
only uses a few of them. `src/lazySchema.test.ts` fails on new eager declarations.
The CLI declares its own top-level schemas through the exported `lazySchema` as well
(guarded by `apps/cli/src/moduleLevelSchemas.policy.test.ts`).

## Tools V2 Meta Envelope

- Canonical key: `_happier`
- Legacy key (temporary back-compat): `_happy`
- If both keys are present on the same payload, `_happier` is authoritative.
