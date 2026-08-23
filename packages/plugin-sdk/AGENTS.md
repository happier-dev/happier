# Plugin SDK package instructions

- `*.public.ts` files and the package `exports` map own public exports. Do not add public exports through ad hoc barrels or host-private paths.
- `API.md`, `api-surface.json`, `api-declarations.md`, and `capability-matrix.json` are generated artifacts. Never hand-edit them; run declaration preparation before their census or declaration checks.
- Package API compatibility and the host/runtime ABI are separate contracts. Follow `docs/compatibility.md` for protocol evolution and use the generated package reports for package-SemVer decisions.
- Do not add aliases for names that have never been published.
