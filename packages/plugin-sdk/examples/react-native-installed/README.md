# React Native Installed Artifact Plugin Example

Install with the public local-plugin install flow by pointing Happier at this
directory. The example declares an installed React Native artifact with explicit
`modulePath: "./PluginPanel"` and non-default `exportName: "PluginPanel"`.

Manual QA path:

- Install the plugin from this directory after placing the signed bundle at
  `dist/native/ios.bundle.js`.
- Open the example surface and verify `PluginPanel` renders.
- Revoke the artifact digest and verify the RN unavailable state renders and the
  materialized bundle is cleaned up.
- Change the export name to an unknown value and verify a typed unavailable state.

Expected screenshots:

- `plugins-rn-installed-panel.png`
- `plugins-rn-installed-bad-export.png`
- `plugins-rn-installed-revoked.png`
