# `@happier-dev/deployment-protocol`

Versioned, validator-neutral facts shared by Happier deployment targets and
consumer plugins. Import the deployment contract from
`@happier-dev/deployment-protocol/v1`. The base entry also includes PostgreSQL
role guard SQL used by deployment providers. Credential-free fixtures are
available from `@happier-dev/deployment-protocol/testing/v1`.

The package composes with the public `@happier-dev/plugin-sdk/protocol` seam.
Its named Receipt and Target Link Artifact readers use the same canonical
parsers as the SDK. They validate the Artifact identity, revision, kind and
body before returning the opened content. The host supplies the opened Artifact.

Host runtime, stored-content transports and secret grants belong to the host
deployment and Protocol owners. The read controller and host presentation
projections live in `@happier-dev/deployments`.

## Evolving the ABI

This is unreleased 0.3 developer-preview source. Follow the
[SDK protocol evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
for changes to the published contract.
