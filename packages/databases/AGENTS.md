# Shared database dialects

This non-optional package owns database lexing, statement boundaries, SQL compilation, typed native decoding, connection URL parsing and secret-free normalization/masking. Keep transports, credentials, admission policy and optional plugin lifecycle at their existing owners. PostgreSQL query and dump admission share one incremental scanner; consumers must not introduce another lexer.
