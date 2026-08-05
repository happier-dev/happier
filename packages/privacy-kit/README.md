# Privacy Kit (Happier workspace)

This private workspace contains the supported subset of `privacy-kit@0.0.25` used by Happier's relay and test tooling:

- persistent and ephemeral Ed25519 tokens;
- Base64 and hexadecimal encoding;
- deterministic secure-key derivation;
- the `KeyTree` encryption API used by relay storage.

The token implementation uses standards-compliant Base64URL JWK fields across Node and Bun. It also exposes a narrowly scoped, read-only resolver for tokens historically signed by Happier's Bun 1.3.5 seed-retry workaround.

This package is not published independently; it is built as part of the Happier workspace and bundled into relay artifacts. See [UPSTREAM.md](./UPSTREAM.md) for provenance and modifications.

## License

MIT
