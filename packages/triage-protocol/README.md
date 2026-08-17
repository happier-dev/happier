# `@happier-dev/triage-protocol`

`@happier-dev/triage-protocol` is the public, source-neutral V1 contract between
the `happier.triage` target and plugins that contribute Triage sources. It owns
the bounded schemas, contribution protocol, source-administration Action
reference, and conformance helpers needed to declare a source. It does not own
provider clients, credentials, source materialization, host registries, UI, or
persistence.

## Importing the contract

The package exposes only three entry points:

- `@happier-dev/triage-protocol` re-exports V1.
- `@happier-dev/triage-protocol/v1` exports the V1 schemas, types, contribution
  protocol, and source-administration Action reference.
- `@happier-dev/triage-protocol/testing/v1` exports fixtures and conformance
  assertions for source-plugin tests.

For a source plugin, import declarations from `/v1` and validate its manifest
declaration with the testing entry point:

```ts
import {
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import {
    checkTriageSourceContributionV1,
} from '@happier-dev/triage-protocol/testing/v1';
```

The conformance helper verifies the declared source contribution against the
public V1 contract. Installation, generation currentness, provider behavior,
and host admission remain owned by their existing host boundaries.

## Evolving the ABI

V1 is the only supported epoch. Keep shared source fields and schemas in this
package, and keep provider-specific implementation details in the contributing
plugin. Do not add `default`, `current`, `latest`, legacy, or compatibility
aliases. A breaking or independently-versioned shared contract requires a new
explicit versioned entry point rather than changing the V1 shape in place.
