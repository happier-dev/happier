# @happier-dev/voice-modelpacks

Host-agnostic installation and lifecycle logic for Happier voice model packs.

The package owns model-pack download, verification, URL policy, resource admission, and atomic installation behavior. Filesystem, network, and digest effects are supplied by the host.

Protocol owns the closed artifact-binding and promotion-intent schemas. In current development source, persisted promotion markers and daemon model-pack state use Protocol's stored-read projection to discard unknown fields recursively while retaining known-field validation. Incoming bindings and promotion inputs remain strict; recovery payloads stay opaque until their named owner reads them.

In current development source, configured manifest and asset URLs reject URL credentials, including credential query parameters. Trusted plugins can use HTTPS mirrors on public or private networks without a separate network-origin grant. The daemon follows server-issued signed HTTPS redirects without a custom download deadline or redirect-count cap; cancellation remains available throughout the transfer. Redirect queries stay in the transport request and are omitted from response metadata, persisted installation state and transport errors. Download requests carry no Authorization header. The shared URL policy owns this distinction; streaming size and SHA-256 checks still verify the downloaded content.
