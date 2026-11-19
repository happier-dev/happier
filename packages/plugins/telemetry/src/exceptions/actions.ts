import {
  PluginError,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1, TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1, TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1, databaseActionMetadata } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { localCaptureBackground } from '../background.js';
import { telemetryPartition } from '../telemetry/assignments.js';
import { readExceptionIssueWriter } from './collectorIssues.js';
import type { ExceptionIssueRow } from './issueWriter.js';
import {
  exceptionIssueTransitionInputSchema,
  exceptionIssueTransitionResultSchema,
  exceptionIssuesRefreshInputSchema,
  exceptionIssuesRefreshResultSchema,
  exceptionOccurrencesReadInputSchema,
  exceptionOccurrencesReadResultSchema,
} from './contracts.js';

export {
  exceptionIssueTransitionInputSchema,
  exceptionIssueTransitionResultSchema,
  exceptionIssuesRefreshInputSchema,
  exceptionIssuesRefreshResultSchema,
  exceptionOccurrencesReadInputSchema,
  exceptionOccurrencesReadResultSchema,
};

type Id =
  | typeof TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1
  | typeof TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1
  | typeof TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1;
function metadata(id: Id) {
  const declaration = databaseActionMetadata[id];
  return {
    ...declaration,
    scopes: ['global', 'machine'] as const,
    surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const,
    execution: { target: 'daemon' as const },
  };
}

/**
 * R16 decides, once per request, that this principal may read the
 * Environment's telemetry on this collector. D34: the same principals may change
 * a native issue's lifecycle, always through the collector's single writer.
 */
async function admit(
  input: Readonly<{ serverId: string; environmentId: string }>,
  context: PluginInvocationContext,
) {
  const admitTelemetryRead =
    context.services.deploymentDatabases?.admitTelemetryRead;
  if (!admitTelemetryRead)
    throw new PluginError({ code: 'deployment_target_role_unavailable' });
  const admitted = await admitTelemetryRead({
    serverId: input.serverId,
    environmentId: input.environmentId,
  });
  return {
    admitted,
    environment: {
      partition: telemetryPartition(input.environmentId),
      environmentId: input.environmentId,
    },
  };
}

function writer() {
  const current = readExceptionIssueWriter();
  if (!current)
    throw new PluginError({
      code: 'telemetry_issue_writer_unavailable',
      message: 'This collector has no Account storage for native issues.',
    });
  return current;
}

function summary(row: ExceptionIssueRow) {
  const value = row.value;
  return {
    issueId: row.rowId,
    revision: row.revision,
    status: value.status,
    ...(value.regressed ? { regressed: true as const } : {}),
    count: value.count,
    lastSeenAtMs: value.lastSeenAtMs,
    asOfMs: value.asOfMs,
  };
}

export const exceptionActions = {
  [databaseActionLocalIdV1(TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1)]:
    {
      ...metadata(TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1),
      inputSchema: exceptionOccurrencesReadInputSchema,
      resultSchema: exceptionOccurrencesReadResultSchema,
      async run(value: unknown, context: PluginInvocationContext) {
        const input = exceptionOccurrencesReadInputSchema.parse(value);
        const { admitted, environment: selected } = await admit(input, context);
        if (admitted.capabilities.exceptions !== true)
          return { status: 'disabled' as const };
        const runtime = localCaptureBackground.readRuntime();
        if (!runtime) throw new PluginError({ code: 'collector_unavailable' });
        const items = await runtime.store.exceptionOccurrences({
          worktree: selected.partition,
          fingerprint: input.fingerprint,
          limit: input.page.limit,
          before: input.page.before,
        });
        const last = items.at(-1);
        const window = input.window;
        if (window && window.until <= window.since) {
          throw new PluginError({ code: 'invalid_parameters', message: 'The trend window must end after it starts.' });
        }
        const trend = window ? await runtime.store.exceptionTrend({ worktree: selected.partition, fingerprint: input.fingerprint, ...window }) : undefined;
        let stacktrace: string | null | undefined;
        let sourceContext: string | null | undefined;
        if (input.occurrenceId !== undefined) {
          const detail = await runtime.store.detail(
            selected.partition,
            input.occurrenceId,
          );
          const exception =
            detail && typeof detail === 'object' && 'exception' in detail
              ? detail.exception
              : undefined;
          stacktrace =
            exception &&
            typeof exception === 'object' &&
            'stacktrace' in exception &&
            typeof exception.stacktrace === 'string'
              ? exception.stacktrace
              : null;
          sourceContext = exception && typeof exception === 'object' && 'sourceContext' in exception
            && typeof exception.sourceContext === 'string' ? exception.sourceContext : null;
        }
        return {
          status: 'ok' as const,
          // Partition and group key are collector-internal; the caller already named the group.
          items: items.map(({ worktree: _worktree, fingerprint: _fingerprint, ...item }) => item),
          ...(last && items.length === input.page.limit
            ? { nextCursor: { at: last.at, id: last.id } }
            : {}),
          ...(stacktrace === undefined ? {} : { stacktrace }),
          ...(sourceContext === undefined ? {} : { sourceContext }),
          ...(trend ? { trend: [...trend.buckets], requestsAffected: trend.requestsAffected } : {}),
        };
      },
    },
  [databaseActionLocalIdV1(TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1)]:
    {
      ...metadata(TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1),
      inputSchema: exceptionIssueTransitionInputSchema,
      resultSchema: exceptionIssueTransitionResultSchema,
      async run(value: unknown, context: PluginInvocationContext): Promise<ReturnType<typeof exceptionIssueTransitionResultSchema.parse>> {
        const input = exceptionIssueTransitionInputSchema.parse(value);
        const { environment: selected } = await admit(input, context);
        const outcome = await writer().transition({
          environment: selected,
          rowId: input.issueId,
          action: input.action,
          ...(input.version === undefined ? {} : { version: input.version }),
        });
        return outcome.kind === 'absent'
          ? { status: 'absent' as const }
          : { status: outcome.kind, issue: summary(outcome.row) };
      },
    },
  [databaseActionLocalIdV1(TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1)]: {
    ...metadata(TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1),
    inputSchema: exceptionIssuesRefreshInputSchema,
    resultSchema: exceptionIssuesRefreshResultSchema,
    async run(value: unknown, context: PluginInvocationContext): Promise<ReturnType<typeof exceptionIssuesRefreshResultSchema.parse>> {
      const input = exceptionIssuesRefreshInputSchema.parse(value);
      const { admitted, environment: selected } = await admit(input, context);
      if (admitted.capabilities.exceptions !== true)
        throw new PluginError({ code: 'telemetry_exceptions_disabled' });
      const current = writer();
      try {
        if (input.issueId !== undefined) {
          const row = await current.refresh({
            environment: selected,
            rowId: input.issueId,
          });
          return { projection: 'ready' as const, issue: summary(row) };
        }
        // Explicit recovery after Account storage was unavailable; retained groups replay idempotently.
        await current.replay(selected, PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows);
        return { projection: 'ready' as const };
      } catch (error) {
        const status = current.status();
        if (status.state === 'unavailable')
          return { projection: 'unavailable' as const, code: status.code };
        throw error;
      }
    },
  },
} satisfies Record<string, PluginActionDefinition>;
