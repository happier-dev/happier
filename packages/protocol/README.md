# @happier-dev/protocol

Shared cross-package contracts between Happier CLI and Happier app.

## Source-derived exports (0.3 development)

The generator derives exact package exports from the compiler's source inventory;
`export-aliases.json` owns renamed entrypoints and directory-index aliases.
Run `pnpm --filter @happier-dev/protocol generate:exports` after adding or moving
a public module, or let local workspace preparation refresh it before capture.
AUTO prepares the controller's map before synchronization; workers verify the
synchronized map without writing it.
Preparation uses the same atomic writer and leaves current maps untouched.
Commit the resulting map. CI and artifact/package publication verify it without
writing; explicit builds, typechecks and `check:exports` also reject stale output.
Do not hand-edit `package.json#exports`. Captured builds and Metro consume the map.

During source authoring, leave
`pnpm --filter @happier-dev/protocol generate:exports --watch` running to publish
added, moved and removed source leaves automatically. This development process
uses the existing source watcher and publication lock; stop it with Ctrl-C.
Configuration/alias edits use the one-shot command or restart the watcher.

Compiled implementation leaves are available through their source-relative
subpaths. Declaration inputs, tests, testkits and fixture directories stay private.
Exact entries preserve Metro's web/native selection and the source, declaration
and published JavaScript targets used by workspace and bundled hosts.

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

Wrap cross-module schema aliases in `lazyZodSchema(() => ImportedSchema)` (or re-export the binding directly) so initialization does not read an imported schema in a cycle; eager schema construction or parsing must use an independent leaf module.

## Tools V2 Meta Envelope

- Canonical key: `_happier`
- Legacy key (temporary back-compat): `_happy`
- If both keys are present on the same payload, `_happier` is authoritative.
