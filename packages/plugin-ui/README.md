# @happier-dev/plugin-ui

Host/runtime React primitives for Happier plugin UI. This package is an
internal workspace dependency for host rendering, portable components, host API
facades, compatibility checks, and package-local testing utilities. Plugin
authors should use `@happier-dev/plugin-sdk` for public UI contribution APIs.

## Plugin UI release posture

Current posture: **prepublish hold**.

This workspace package is intentionally still `private: true` and versioned
`0.0.0`. It is packability-ready for local dry-run validation, but external
publication requires an explicit product/release decision. Do not publish,
change versions, or remove the private posture as part of package-hardening
work.

Support policy while held:

- Supported host/runtime imports are the subpaths listed in
  `package.json#exports`.
- Descriptor builders, target helpers, internal source files, and app-private UI
  modules are not public plugin APIs.
- React remains a peer dependency supplied by the host workspace.
- `react-test-renderer` is optional and only needed for package-local testing
  helpers.

## Package surface

Use the root export for host/runtime primitives:

```ts
import { Panel, Text, createPluginSurfaceHostApi } from '@happier-dev/plugin-ui';
```

Subpath exports are available for narrower imports:

```ts
import { createPluginUiHostApiFacade } from '@happier-dev/plugin-ui/hostApi';
```

The package tarball should contain only compiled `dist` output, `package.json`,
and this README.
