/**
 * Host policy bounds for daemon-local plugin SQLite databases. They are not an
 * author declaration: the daemon resolves one trusted-plugin allocation and
 * reports it through the existing database capability projection.
 *
 * These evidence-backed Preview defaults were measured with the approved
 * Background Indexer workload at 50,000 and 500,000 indexed records. They are
 * not API-frozen: the remaining compiled-runtime, platform/lifecycle, and
 * agreed event-loop-budget plan gates still apply. The operation bounds reuse
 * the existing daemon-database host profile, and the protocol ceiling prevents
 * a future host-specific resolver from silently increasing this allocation.
 */
export const PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 = Object.freeze({
  maximumDatabaseBytes: 128 * 1024 * 1024,
  maximumInputBytes: 16 * 1024,
  maximumResultBytes: 16 * 1024,
  maximumResultRows: 100,
  maximumAffectedRows: 1_000,
  maximumElapsedMs: 5_000,
});

export const PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1 =
  PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumDatabaseBytes;
