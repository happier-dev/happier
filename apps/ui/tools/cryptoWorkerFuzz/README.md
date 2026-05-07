# Crypto Worker Malformed-Input Fuzz

Manual deterministic fuzz runner for native crypto worker wire-format inputs.

Run from the repository root:

```bash
node node_modules/tsx/dist/cli.mjs apps/ui/tools/cryptoWorkerFuzz/fuzzCryptoWorkerMalformedInputs.ts --iterations=128 --seed=1592639710
```

The runner checks data-key envelope v1, Secretbox JSON, and AES-GCM JSON decrypt semantics. It verifies malformed and wrong-key inputs return `null` per item, preserve batch length/order, and do not poison valid items that appear after invalid inputs.
