# Descriptor-Only Plugin Example

Install with the public local-plugin install flow by pointing Happier at this
directory. The `.happier-plugin/plugin.json` manifest declares only host-rendered
settings descriptors and permission declarations; there is no web or native
runtime bundle.

Manual QA path:

- Install the plugin from this directory.
- Open plugin settings and verify the settings descriptor renders.
- Disable the plugin and verify permission grant/revoke controls are absent or inert.
- Re-enable the plugin and verify the optional permission can be reviewed.

Expected screenshots:

- `plugins-descriptor-settings.png`
- `plugins-descriptor-permissions-disabled.png`
