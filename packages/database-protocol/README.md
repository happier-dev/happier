# `@happier-dev/database-protocol`

Versioned database workbench business schemas shared by the workbench, engine
implementations, deployment transports, UI, CLI and plugin SDK projections.
This is unreleased 0.3 development source.

Import the current contract from `@happier-dev/database-protocol/v1`; the base
entrypoint exposes the same producers. Credential-free fixtures are available
from `@happier-dev/database-protocol/testing/v1`. The package contains no SQL,
driver, permission policy, credential acquisition, persistence or connection
lifecycle.

Targets identify existing worktree, deployment or Project Saved Secret owners.
They carry no connection URL. Operation inputs select one target, and may name
an existing demand `subscriptionId`; this is connection reuse context, never
an authorization grant. Access admission remains with the access owner and
the existing Action executor.

Target listing accepts a Project scope to include its existing manual associations
across worktrees on the selected installation. Connect still selects a concrete
worktree or Environment scope. Listing reads association metadata without opening
connections or acquiring Saved Secrets.

Integer, decimal and JSON values retain their original text. SQL NULL and JSON
null have different tags (`{ type: 'null' }` and `{ type: 'json', value: 'null' }`).
Rows and columns are ordered arrays so duplicate column labels and zero-row
metadata survive. A partial cell carries its encoding and byte range; incomplete
results carry a reason and a continuation when the executor can provide one.
Arbitrary SQL continuation is an explicit non-snapshot rerun operand. No output
allowance, shared model cap, retained cursor or retry policy is introduced.

Relation summaries can include the existing `size` measurement: total bytes,
heap/relation bytes, table bytes (including auxiliary storage), and index bytes
where the dialect supplies them. MySQL table sizes are estimates; per-index
bytes can remain unavailable. Missing measurements and row estimates are
unknown, not zero. Directory row counts are approximate catalog estimates.
PostgreSQL table statistics expose `lastAutovacuum` and `lastAutoanalyze` when
observed. A selected statement's buffer-hit ratio uses its hit/read counters;
missing counters or a zero denominator mean unknown, not a database-wide cache
measurement or index-removal advice.

Selected loaded rows can be exported through `database.rows.export` as CSV or
tagged JSON without another database read. The result carries the source
completeness and partial-cell ranges; selecting loaded rows does not establish
that the table or query is complete. CSV uses `\N` for SQL NULL and quotes an
empty string or literal `\N`. Tagged JSON preserves exact numeric text, SQL
NULL versus JSON null, binary encodings and duplicate column labels.

Telemetry detail bodies retain resource `service.version` and both deployment
environment conventions. `deploymentEnvironmentName` prefers
`deployment.environment.name`, falling back to legacy `deployment.environment`;
the legacy value remains separately available. Endpoint `errorRate` is the
observed `errorCount / requestCount`, or null without requests. Selected trace
reads expose duration-ranked observed child spans and log-to-trace/span links;
an unobserved parent or span remains unresolved. These projections reuse the
collector's existing detail storage and read Actions.

App LLM cost operands can be projected with `projectDatabaseCaptureUsageV1` for
the existing Usage cost, daily and breakdown renderers. Pass the catalog read
through `usage.prices.get`, the invoking viewer's `usageModelPriceOverridesV1`,
and the same hour/day granularity requested from the collector. The result's
`app_calls` subject must be selected exclusively from Agent usage by the host;
the projection never reads or writes Agent history. Pricing, currency facts,
unknown prices and catalog revision come from the shared Usage owner. Collector coverage remains
alongside the accounting response, so lost observations are not zero spend.
`projectDatabaseAppCostMetricSeriesV1` projects those same priced buckets for the
Telemetry Metric widget's LLM cost option. Its `DatabaseTelemetryMetricIntervalV1`
shape is shared with metric analysis and health-check trends. Missing cost has
no value; consumers preserve the associated Usage coverage.

## Evolving the ABI

Follow the [protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution).
Wire epoch **v1** is separate from package version **0.0.0**. Every structured
target, operation, result and nested metadata envelope is closed; unknown fields
are rejected rather than dropped or preserved. JSON Explain plans are JSON
payload data, not routing, authority or executable declarations.
Native/platform cause codes and contributed engine identities are strings owned
by their external producer, not extensions to the operation union.

New authority-bearing operation/target union members require a new epoch or the
doctrine's explicitly approved development direct cut. There is no historical
Database workbench writer or stored Database record to migrate in this initial
package. Supported deployment query callers migrate at their owning integration
boundary; this package does not add a legacy mapper. Package tests prove pure
schema contracts only, never execution, authorization or composed-flow behavior.
