# Multi-Mode Fallback Plugin Example

Install with the public local-plugin install flow by pointing Happier at this
directory. One surface declares React Native primary, hostedWeb secondary, and
descriptor tertiary fallback. The Surface Registry runtime-mode decision chooses
the first runtime-compatible mode without changing plugin author code.

Manual QA path:

- Install the plugin from this directory.
- With RN available, verify the React Native `PluginPanel` renders.
- Remove RN capability and verify hostedWeb mounts.
- Remove RN and hostedWeb capability/static endpoint and verify the descriptor
  fallback mounts.
- Remove every declared mode and verify the typed unavailable state.

Expected screenshots:

- `plugins-fallback-rn.png`
- `plugins-fallback-hosted-web.png`
- `plugins-fallback-descriptor.png`
- `plugins-fallback-unavailable.png`
