# React Native Dev Hot Reload Plugin Example

Install with the public local-plugin install flow by pointing Happier at this
directory from a local development source. The example declares a development
React Native artifact with `devUrl`, explicit `modulePath`, and non-default
`exportName: "PluginPanel"`.

Manual QA path:

- Start a local Re.Pack/Metro dev server at the declared `devUrl`.
- Install this directory as a local plugin in a development build.
- Open the surface and verify edits reload through the dev URL.
- Stop the dev server and verify the typed server-down unavailable state.
- Introduce a syntax error and verify the typed compile-error state.

Expected screenshots:

- `plugins-rn-devhotreload-panel.png`
- `plugins-rn-devhotreload-server-down.png`
- `plugins-rn-devhotreload-compile-error.png`
