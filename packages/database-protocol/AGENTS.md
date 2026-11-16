# Database protocol

Follow the [protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution).
This package owns versioned database business operands and results. Identity,
routing, mutation and runtime-union envelopes are closed, including nested objects.
SQL compilation, decoding, access decisions and execution belong to their runtime
owners; do not add a parallel parser, permission decider or connection lifecycle here.
