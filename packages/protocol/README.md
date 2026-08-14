# @happier-dev/protocol

Shared cross-package contracts between Happier CLI and Happier app.

This package is intentionally small and should only contain stable protocol-level
types/constants that both sides need (e.g. RPC result shapes, error codes).

## Protocol evolution

Apply the [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
to every shared wire, persisted, Host Event, and public SDK projection. In this
package, preserve known-field strictness; keep identity, authority, routing,
mutation, executable-declaration, runtime-union, and stable Host Event envelopes
closed; and make nested-object policy explicit through the owning schema. The
doctrine decides compatibility and wire-epoch policy; this package applies it at
the schema/normalizer owner and does not introduce a second parser or JSON Schema
definition.

Feature business protocols belong in independently publishable
`@happier-dev/<feature>-protocol` packages, not in this generic host ABI. Their
package README and `AGENTS.md` link to the doctrine and name their domain owner.

## Tools V2 Meta Envelope

- Canonical key: `_happier`
- Legacy key (temporary back-compat): `_happy`
- If both keys are present on the same payload, `_happier` is authoritative.
