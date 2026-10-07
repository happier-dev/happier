# `@happier-dev/triage-protocol`

`@happier-dev/triage-protocol` is the public, source-neutral V1 contract between
the `happier.triage` target and plugins that contribute Triage sources. It owns
the bounded schemas, contribution protocol, the two caller-bound source Action
references — administration and its read counterpart — and the conformance
helpers needed to declare a source. It does not own provider clients,
credentials, source materialization, host registries, UI, or persistence.

## Importing the contract

The package exposes only three entry points:

- `@happier-dev/triage-protocol` re-exports V1.
- `@happier-dev/triage-protocol/v1` exports the V1 schemas, types, contribution
  protocol, and both source Action references:
  `TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1`, which creates, reconfigures,
  removes and reactivates a configured source instance, and
  `TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1`, which lists the instances the
  calling contribution already owns. Three of the administration arms name a
  `sourceInstanceId` the caller must already hold, so a Settings surface needs
  the read Action to reach them. Administration remains the only writer.
- `@happier-dev/triage-protocol/testing/v1` exports fixtures, conformance
  assertions, and the published byte-gate derivation
  (`buildMaximalSchemaValue`, `deriveMaximumEncodedBytes`,
  `deriveMaximumEncodedBytesByLabel`, `encodedJsonBytes`) for source-plugin
  tests.

For a source plugin, import declarations from `/v1` and validate its manifest
declaration with the testing entry point:

```ts
import {
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import {
    checkTriageSourceContributionV1,
} from '@happier-dev/triage-protocol/testing/v1';
```

A source Settings surface passes either ref to `hostApi.executeAction(...)`
unchanged. Neither request carries a source, plugin, or contribution identity:
the host stamps the caller, and the target resolves its admitted V1
contribution, so a caller reads and administers only its own instances.

The conformance helper verifies the declared source contribution against the
public V1 contract. Installation, generation currentness, provider behavior,
and host admission remain owned by their existing host boundaries.

Account-only sources use `TriageSourceConnectedAccountInputsV1` from `/v1`
for their Action input schemas. These canonical specializations preserve the
role fields and require a configured account in every instance-bearing arm.
Native-capable sources retain the generic role input and declare both account
and native-service selection paths. Conformance accepts only the published
generic schema or its account-only specialization.

## Optional pull-request status (development preview)

Sources may bind the safe `readPullRequestStatus` role for a declared
`pullRequest` workflow kind. It accepts the existing exact-instance
`TriageGetInputV1` and returns `TriagePullRequestStatusResultV1`: named checks,
nullable counts, review decisions and reviewer verbs, mergeability/blocker,
and head/base branches with optional diff counts. Unknown or partial reads
remain explicit; they are not zero checks or an approval. This detail read
cannot conclude entry absence or replace `get`/`scan` observations.

The Session tab requests it only when a PR is expanded, through Triage's own
safe Action and the source's existing admitted readers. Sources that leave
the optional role unbound continue to provide their existing entry details.

## Evolving the ABI

V1 is the only supported epoch. Keep shared source fields and schemas in this
package, and keep provider-specific implementation details in the contributing
plugin. Do not add `default`, `current`, `latest`, legacy, or compatibility
aliases. A breaking or independently-versioned shared contract requires a new
explicit versioned entry point rather than changing the V1 shape in place.
