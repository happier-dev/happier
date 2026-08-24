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
happier plugins dev build .
happier plugins test .
happier plugins pack .
```

Focused typecheck diagnostics remain available through
`happier plugins dev typecheck .`.

The canonical external source of truth is the generated package's
`src/index.ts`: `definePlugin(...)` derives its named `manifest` and `activate`
exports there. Packing evaluates that declared source once, validates the
canonical projection, and writes `.happier-plugin/plugin.json` into the
archive. A newly generated code-defined package does not keep a competing
checked-in JSON manifest beside its source.

For UI templates, use the supported creation command:

```bash
happier plugins create ./my-plugin \
  --id com.example.my-plugin \
  --name "My plugin" \
  --ui reactNative
```

Use `--ui hostedWeb` for an isolated web surface. Canonical author guidance is
in `apps/docs/content/docs/plugins/` and `packages/plugin-sdk/README.md`.
