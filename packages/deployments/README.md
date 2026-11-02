# `@happier-dev/deployments`

The client-side read owner for Happier Deployments, used by the CLI and the UI.
It provides the v1 deployment read controller
(`createDeploymentReadControllerV1`), observation demand tracking, and the
deployment store projection that the controller maintains.

It also exposes `createDeploymentTargetCatalogV1` for admitted normalized target
descriptors. The catalog distinguishes host and plugin contribution sources;
manifest admission and executable-role custody remain with their existing owners.

Wire and stored shapes come from `@happier-dev/deployment-protocol`. This package
consumes them and does not define them.

Current development source also owns inert stored-template preparation through
`prepareDeploymentTemplateInstantiationV1`. It composes admitted parsed Compose
and descriptor data into a candidate and binding/generation plan. It performs no
secret creation, content write or native effect; the existing Actions own those
steps. See [deployment ownership](../../docs/deployment.md#public-deployment-contracts-03-development)
for the integration and availability boundary.
