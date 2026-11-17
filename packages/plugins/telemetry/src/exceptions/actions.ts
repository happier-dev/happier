import {
  PluginError,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1,
  TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1,
  TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1,
  databaseActionLocalIdV1,
  databaseActionMetadata,
} from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { localCaptureBackground } from '../background.js';
import { telemetryPartition } from '../telemetry/assignments.js';
import { readExceptionIssueWriter } from './collectorIssues.js';
import type { ExceptionIssueRow } from './issueWriter.js';

const text = defineProtocolString({ minLength: 1 });
const time = defineProtocolNumber({ integer: true, minimum: 0 });
const environment = { serverId: text, environmentId: text };
const maybe = (schema: ReturnType<typeof defineProtocolString>) =>
  defineProtocolUnion([schema, defineProtocolLiteral(null)]).optional();

export const exceptionOccurrencesReadInputSchema = defineProtocolObject(
  {
    ...environment,
    fingerprint: text,
    page: defineProtocolObject(
      {
        limit: defineProtocolNumber({ integer: true, minimum: 1 }),
        before: defineProtocolObject(
          { at: time, id: text },
          { policy: 'closed' },
        ).optional(),
      },
      { policy: 'closed' },
    ),
    /** Demand one occurrence's redacted stack; list items never carry stacks. */
    occurrenceId: text.optional(),
  },
  { policy: 'closed' },
);
const occurrenceSchema = defineProtocolObject(
  {
    id: text,
    at: time,
    origin: defineProtocolUnion([
      defineProtocolLiteral('span'),
      defineProtocolLiteral('log'),
    ]),
    serviceName: maybe(defineProtocolString()),
    serviceVersion: maybe(defineProtocolString()),
    type: maybe(defineProtocolString()),
    message: maybe(defineProtocolString()),
    topFrame: maybe(defineProtocolString()),
    traceId: maybe(defineProtocolString()),
    spanId: maybe(defineProtocolString()),
    escaped: defineProtocolUnion([
      defineProtocolLiteral(true),
      defineProtocolLiteral(false),
    ]).optional(),
  },
  { policy: 'closed' },
);
export const exceptionOccurrencesReadResultSchema = defineProtocolUnion([
  defineProtocolObject(
    { status: defineProtocolLiteral('disabled') },
    { policy: 'closed' },
  ),
  defineProtocolObject(
    {
      status: defineProtocolLiteral('ok'),
      items: defineProtocolArray(occurrenceSchema),
      nextCursor: defineProtocolObject(
        { at: time, id: text },
        { policy: 'closed' },
      ).optional(),
      /** Redacted app text; consumers frame it as data, never as instructions. */
      stacktrace: maybe(defineProtocolString()),
    },
    { policy: 'closed' },
  ),
]);

const transitionAction = defineProtocolUnion([
  defineProtocolLiteral('resolve'),
  defineProtocolLiteral('reopen'),
  defineProtocolLiteral('ignore'),
  defineProtocolLiteral('unignore'),
]);
export const exceptionIssueTransitionInputSchema = defineProtocolObject(
  {
    ...environment,
    issueId: text,
    action: transitionAction,
    /** The fixed release, when the person names one on Resolve. */
    version: text.optional(),
  },
  { policy: 'closed' },
);
const issueSummarySchema = defineProtocolObject(
  {
    issueId: text,
    revision: time,
    status: defineProtocolUnion([
      defineProtocolLiteral('open'),
      defineProtocolLiteral('resolved'),
      defineProtocolLiteral('ignored'),
    ]),
    regressed: defineProtocolLiteral(true).optional(),
    count: time,
    lastSeenAtMs: time,
    asOfMs: time,
  },
  { policy: 'closed' },
);
export const exceptionIssueTransitionResultSchema = defineProtocolUnion([
  defineProtocolObject(
    { status: defineProtocolLiteral('absent') },
    { policy: 'closed' },
  ),
  defineProtocolObject(
    {
      status: defineProtocolUnion([
        defineProtocolLiteral('applied'),
        defineProtocolLiteral('unchanged'),
      ]),
      issue: issueSummarySchema,
    },
    { policy: 'closed' },
  ),
]);
export const exceptionIssuesRefreshInputSchema = defineProtocolObject(
  { ...environment, issueId: text.optional() },
  { policy: 'closed' },
);
export const exceptionIssuesRefreshResultSchema = defineProtocolObject(
  {
    projection: defineProtocolUnion([
      defineProtocolLiteral('ready'),
      defineProtocolLiteral('unavailable'),
    ]),
    code: text.optional(),
    issue: issueSummarySchema.optional(),
  },
  { policy: 'closed' },
);

type Id =
  | typeof TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1
  | typeof TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1
  | typeof TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1;
function metadata(id: Id) {
  const { agentDefault: _default, ...declaration } = databaseActionMetadata[id];
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
        let stacktrace: string | null | undefined;
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
        }
        return {
          status: 'ok' as const,
          // Partition and group key are collector-internal; the caller already named the group.
          items: items.map(({ worktree: _worktree, fingerprint: _fingerprint, ...item }) => item),
          ...(last && items.length === input.page.limit
            ? { nextCursor: { at: last.at, id: last.id } }
            : {}),
          ...(stacktrace === undefined ? {} : { stacktrace }),
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
