# Protocol package instructions

Follow the repository [protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
for every wire, persisted, Host Event, or public SDK projection change. Apply it
at the owning schema/normalizer: recursively classify material objects and keep
identity, authority, routing, mutation, executable-declaration, runtime-union,
and stable Host Event envelopes closed.

Do not introduce a parallel parser, handwritten JSON Schema, compatibility
adapter, or feature-business package here. Independently published feature
protocols own their business schemas in `@happier-dev/<feature>-protocol`; their
README and nearest `AGENTS.md` link to the doctrine instead of copying it.
