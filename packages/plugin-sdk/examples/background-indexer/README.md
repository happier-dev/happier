# Background Indexer

This maintained reference plugin uses only public Plugin SDK imports. Its cold
manifest declares one daemon-local `workspace-index` database and one
generation-scoped `workspace-indexer` background service. The runner opens the
database through `context.services.storage.daemon.database(...)`, writes an
index heartbeat, and verifies it with a bounded query.

It intentionally has no scheduler, worker, host import, or private database
driver access. The host owns database path derivation, migration safety,
currentness, cancellation, quotas, and close/reload behavior.

Run the normal external-author commands from this directory:

```sh
happier plugins author typecheck .
happier plugins test .
happier plugins pack .
```

The source workload measurement is gated by
`HAPPIER_RUN_DAEMON_DATABASE_WORKLOAD=1` in the CLI database owner test. Packed
install/restart/reload and Windows/Linux/macOS evidence remain separate live
product gates.
