# Internal Plugin Platform regression fixtures

The packages in this directory are CLI/runtime regression inputs. They preserve
older and edge-case shapes needed by internal tests and are **not canonical
external authoring templates**. In particular, do not copy their entrypoint,
handler-reference, or older development conventions into a new plugin.

Create the current minimal external package with:

```bash
happier plugins create my-plugin --id com.example.my-plugin
cd my-plugin
happier plugins dev
happier plugins author build .
happier plugins test .
happier plugins pack .
```

Focused typecheck diagnostics remain available through
`happier plugins author typecheck .`.

The canonical external source of truth is the generated
`.happier-plugin/plugin.json`. It is cold JSON with current daemon and
development entrypoints and manifest-declared contribution ids. Executable
binding happens through a named `activate(api: PluginApi)` export.

For UI templates, use the supported scaffold command:

```bash
happier plugins scaffold ./my-plugin \
  --id com.example.my-plugin \
  --name "My plugin" \
  --ui reactNative
```

Use `--ui hostedWeb` for an isolated web surface. Canonical author guidance is
in `apps/docs/content/docs/plugins/` and `packages/plugin-sdk/README.md`.
