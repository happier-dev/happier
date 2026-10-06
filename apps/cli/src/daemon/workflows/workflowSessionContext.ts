import axios from 'axios';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { readSessionWorkStatePrimaryItemV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import { SessionTurnInitiatorV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT } from '@happier-dev/protocol/actions/actionSpecs';
import { WorkflowSessionContextGoalV1Schema, WorkflowSessionContextV1Schema } from '@happier-dev/protocol/workflows/workflowSessionContextV1';
import type { WorkflowSessionContextV1 } from '@happier-dev/protocol/workflows';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionTurnsProjection } from '@/session/transport/http/sessionsHttp';
import { WorkflowInputResolutionError, type WorkflowValueResolutionRuntime } from './input';

type ContextReaderParams = Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  /** Origin from the immutable accepted snapshot, never the step conversation. */
  originSessionId: string | undefined;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>;

/** The server reconciles cumulative and delta observations; the daemon never accumulates usage. */
async function readUsage(params: ContextReaderParams, sessionId: string, startMs: number | undefined): Promise<WorkflowSessionContextV1['usage']> {
  if (startMs === undefined) return { kind: 'unavailable' };
  const path = '/v2/usage/query';
  const body: UsageAnalyticsQueryRequest = UsageAnalyticsQueryRequestSchema.parse({
    filters: { sessionIds: [sessionId] }, dateRange: { startMs }, includeSeries: false,
  });
  const headers = params.resolveAuthorizationHeaders?.({ method: 'POST', path, body })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.credentials.token}` });
  if (!headers) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
  const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
  });
  if (response.status !== 200) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
  const query = UsageAnalyticsQueryResponseSchema.parse(response.data);
  return query.totals.eventCount === 0 ? { kind: 'unavailable' }
    : { kind: 'accounted', tokensUsed: query.totals.tokens.total };
}

/** Authorized canonical Session/usage readers, refreshed for each preparation or condition evaluation. */
export function createProductionWorkflowSessionContextReader(params: ContextReaderParams): Required<Pick<WorkflowValueResolutionRuntime,
  'resolveSessionContext' | 'resolveSessionContextField'>> {
  const read = async (recentTurns: number, includeUsage = true): Promise<WorkflowSessionContextV1> => {
    try {
      params.signal?.throwIfAborted();
      if (!params.originSessionId) throw new WorkflowInputResolutionError('invalid_reference_scope');
      const target = await resolveSessionTransportContext({ credentials: params.credentials, idOrPrefix: params.originSessionId,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      });
      if (!target.ok || target.sessionId !== params.originSessionId) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
      const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
        rawSession: target.rawSession, accountEncryptionMode: target.accountEncryptionCurrentness.mode });
      if (!metadata || metadata.machineId !== params.machineId) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
      const workState = readSessionWorkStateV1FromMetadata(metadata);
      const goalItem = workState ? readSessionWorkStatePrimaryItemV1(workState.items.filter((item) => item.kind === 'goal'), workState.primaryItemId) : null;
      // Project known goal fields through the existing owner schema and exclude native usage.
      const goal = goalItem ? WorkflowSessionContextGoalV1Schema.strip().parse({ ...goalItem,
        ...(goalItem.goalCapabilities ? { goalCapabilities: WorkflowSessionContextGoalV1Schema.shape.goalCapabilities.unwrap().strip().parse(goalItem.goalCapabilities) } : {}),
      }) : undefined;
      const usage = includeUsage ? await readUsage(params, target.sessionId, goal?.startedAt ?? goal?.createdAt)
        : { kind: 'unavailable' as const };
      const turns: WorkflowSessionContextV1['turns'] = [];
      let truncated = false;
      if (recentTurns > 0) {
        const projection = await fetchSessionTurnsProjection({ token: params.credentials.token, sessionId: target.sessionId,
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        });
        if (!projection) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
        // A committed Turn may contain several user/assistant rows, or tools only.
        // Select Turn records first, then join the canonical transcript within their anchors.
        const selected = projection.turns.filter((turn) => turn.status !== 'in_progress')
          .sort((left, right) => left.startedAt - right.startedAt).slice(-recentTurns).map((turn) => {
            const initiator = SessionTurnInitiatorV1Schema.safeParse(turn.initiator);
            const anchors = turn.transcriptAnchors;
            const exactSeqs = [...(anchors?.userMessageSeqs ?? []),
              ...(anchors?.startUserMessageSeq !== undefined ? [anchors.startUserMessageSeq] : []),
              ...(anchors?.finalAssistantMessageSeq != null ? [anchors.finalAssistantMessageSeq] : [])];
            const startSeq = anchors?.startSeqInclusive ?? (exactSeqs.length ? Math.min(...exactSeqs) : undefined);
            const endSeq = anchors?.endSeqInclusive ?? anchors?.finalAssistantMessageSeq;
            if (!initiator.success || !anchors || startSeq === undefined || endSeq == null || endSeq < startSeq) {
              throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
            }
            return { initiator: initiator.data, exactSeqs, startSeq, endSeq, parts: [] as { seq: number; text: string }[] };
          });
        const oldestStartSeq = selected.length ? Math.min(...selected.map((turn) => turn.startSeq)) : null;
        let cursor: string | null = null;
        let scannedBefore: number | null = null;
        let covered = selected.length === 0;
        while (!covered) {
          const page: Awaited<ReturnType<typeof getSessionTranscript>> = await getSessionTranscript({ credentials: params.credentials, idOrPrefix: target.sessionId,
            limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT, direction: 'before', cursor,
            roles: ['user', 'assistant'], maxCharsPerMessage: null,
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
          });
          if (!page.ok) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
          for (const item of page.items) {
            if (item.role !== 'user' && item.role !== 'assistant') continue;
            const turn = selected.find((candidate) => {
              return item.seq !== undefined && (candidate.exactSeqs.includes(item.seq)
                || (item.seq >= candidate.startSeq && item.seq <= candidate.endSeq));
            });
            if (!turn) continue;
            if (item.seq === undefined || item.text === undefined) throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
            turn.parts.push({ seq: item.seq, text: item.text });
            truncated ||= item.truncated === true;
          }
          scannedBefore = page.nextCursor === null ? null : Number(page.nextCursor);
          covered = !page.hasMore || (scannedBefore !== null && oldestStartSeq !== null && scannedBefore <= oldestStartSeq);
          truncated ||= page.diagnostics.scanLimitReached;
          if (covered || page.diagnostics.scanLimitReached || page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        for (const turn of selected) {
          // A scan-limited page cannot establish an unvisited older empty turn.
          if (!covered && turn.parts.length === 0 && (scannedBefore === null || turn.startSeq < scannedBefore)) continue;
          turns.push({ initiator: turn.initiator, text: turn.parts.sort((left, right) => left.seq - right.seq)
            .map((part) => part.text).join('\n\n') });
        }
      }
      params.signal?.throwIfAborted();
      return WorkflowSessionContextV1Schema.parse({ ...(goal ? { goal } : {}), usage, turns, truncated });
    } catch (error) {
      if (params.signal?.aborted || error instanceof WorkflowInputResolutionError) throw error;
      throw new WorkflowInputResolutionError('workflow_session_context_unavailable');
    }
  };
  return {
    resolveSessionContext: read,
    resolveSessionContextField: async (field) => {
      const context = await read(0, field === 'usage.tokensUsed');
      const value = field === 'goal.tokenBudget' ? context.goal?.tokenBudget
        : context.usage.kind === 'accounted' ? context.usage.tokensUsed : undefined;
      if (value === undefined || value === null) throw new WorkflowInputResolutionError('missing_reference');
      return value;
    },
  };
}
