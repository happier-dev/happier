# @happier-dev/protocol

Shared cross-package contracts between Happier CLI and Happier app.

This package is intentionally small and should only contain stable protocol-level
types/constants that both sides need (e.g. RPC result shapes, error codes).

## Tools V2 Meta Envelope

- Canonical key: `_happier`
- Legacy key (temporary back-compat): `_happy`
- If both keys are present on the same payload, `_happier` is authoritative.
