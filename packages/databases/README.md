# Shared database dialects

Development package for shared SQL dialect rules used by deployments, the database workbench, insights and capture. Engine modules own statement boundaries, compilation, decoding and literal masking. Transports own connections and transactions; Actions own read/write admission.

PostgreSQL and MySQL connections live in the nonoptional `./connection/postgresql` and `./connection/mysql` exports. Native deployments and the optional workbench reuse those drivers, transaction and cancellation semantics; each demand or standalone Action owns its connection lifetime. Native deployments select their existing observed endpoint and dedicated credential through the deployment role owner.

PostgreSQL dump validation retains the incremental psql scanner used by native deployment restore. Query mode permits one SQL result and excludes client commands, COPY, binary and incomplete input.

Browser and native Console clients use `databaseStatementRangesV1(sql, engine, options?)` from `@happier-dev/databases/statements`. It projects the same native lexers without importing drivers or Node crypto; ranges use JavaScript string offsets and omit statement separators.

Workbench statement admission rejects transaction-control and mode changes that escape the caller's transaction. The credential role controls SQL scope; the URI-selected database is a default, and cross-database SQL follows the role's permissions. Native engine transaction and file modes enforce read/write effects. MySQL additionally rejects documented implicit-commit and non-rollbackable forms, following the [MySQL 8.4 transaction contract](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).

Console write batches and staged Apply use one transaction. PostgreSQL and SQLite provide atomic database changes; MySQL's rollback guarantee applies to transactional tables. Changes that triggers make to nontransactional MyISAM tables can survive rollback, even when the selected table uses InnoDB. See [MySQL's rollback limitation](https://dev.mysql.com/doc/refman/8.4/en/nontransactional-tables.html). Write-mode Analyze runs in a transaction that is rolled back, with the same MySQL limitation.

Normalization removes comments and replaces literal values and bind positions before hashing the resulting shape with SHA-256. MySQL consumers supply the observed `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES` session modes; PostgreSQL uses `standard_conforming_strings=on`, matching native deployment execution. An unsupported or incomplete lexical input throws a secret-free typed error; it must never fall back to publishing raw SQL.

`parseDatabaseConnectionUrl` returns private credentials and options. Only `maskDatabaseConnectionUrl` is suitable for a displayed address: it removes user information and fragments and redacts every query value. `withDatabaseConnectionUrlOptions` lets driver adapters replace their owned options while preserving the remaining private connection material.
