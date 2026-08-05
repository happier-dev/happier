# Upstream provenance

This private workspace package is derived from [`ex3ndr/privacy-kit`](https://github.com/ex3ndr/privacy-kit) at commit [`476fd33b16bb930fec5b52b13303fb919f30f6f3`](https://github.com/ex3ndr/privacy-kit/commit/476fd33b16bb930fec5b52b13303fb919f30f6f3), published as `privacy-kit@0.0.25`.

The upstream `package.json` and README declare the package to be MIT licensed. The upstream repository did not contain a standalone license file at the recorded commit, so this vendored package includes the standard MIT text with the upstream author's copyright notice.

Happier modifications include standards-compliant Base64URL encoding for Ed25519 JWK fields, deterministic read-only lookup of the historical Bun 1.3.5 fallback signing key, and runtime regression coverage for Node and Bun.

Only the upstream modules consumed by Happier are retained in this private workspace. This keeps the relay runtime dependency closure small and avoids taking ownership of unrelated experimental cryptography and enclave modules; the upstream commit above remains the source for comparing future updates.
