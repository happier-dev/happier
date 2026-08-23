# SDK package instructions

- `*.public.ts` files and the package `exports` map own public exports. Do not add public exports through ad hoc barrels or host-private paths.
- Generated API and declaration artifacts are never hand-edited. Run declaration preparation before the package's census or declaration checks.
- Package API compatibility and the host/runtime ABI are separate contracts. Follow `docs/compatibility.md` for protocol evolution and use generated package reports for package-SemVer decisions.
- Do not add aliases for names that have never been published.
