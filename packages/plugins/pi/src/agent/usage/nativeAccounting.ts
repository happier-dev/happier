import { isRecord, parseTimestampMs, readString } from '@happier-dev/plugin-sdk';
import { readAgentAccountingJsonlSource, type AgentAccountingJsonlState } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionsReadAccountingRequest } from '@happier-dev/plugin-sdk/sessions/external';
import { resolvePiExternalSessionSource } from '../externalSessions/source.js';
import { normalizePiPaidUsage } from './paidUsage.js';

export async function readPiNativeAccounting(request: AgentExternalSessionsReadAccountingRequest, env: NodeJS.ProcessEnv) {
  const source = resolvePiExternalSessionSource({ source: request.source, env });
  if (!source) return { ok: false as const, code: 'source_invalid' as const, message: 'Pi accounting source is invalid.' };
  return readAgentAccountingJsonlSource({ roots: [source.sessionsRoot], sourceKey: source.sessionsRoot, invocation: request,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    async projectRecord(record, previous, _filePath, _offset, context) {
      if (!isRecord(record)) return { state: previous, observations: [], incomplete: true };
      let state: AgentAccountingJsonlState = previous;
      if (record.type === 'session' && record.version === 3 && readString(record.id)) {
        state = { ...previous, sessionId: String(record.id) };
        const cwd = readString(record.cwd);
        if (cwd) state[`project:${state.sessionId}`] = cwd;
        if (typeof record.parentSession === 'string') {
          const parent = await context.readFileState(record.parentSession);
          if (!parent?.complete || !parent.state.sessionId || parent.state.lineageUnavailable === 'true') {
            return { state: { ...state, lineageUnavailable: 'true' }, observations: [], incomplete: true,
              incompleteReason: 'native_fork_lineage_unavailable' };
          }
          state = { ...state, parentSessionId: parent.state.sessionId,
            ...Object.fromEntries(Object.entries(parent.state).filter(([key]) => key.startsWith('project:'))),
            ...Object.fromEntries(Object.entries(parent.state).filter(([key]) => key.startsWith('entry:')).map(([key, value]) => [`inherited:${key.slice(6)}`, value])) };
        }
        return { state, observations: [] };
      }
      if (record.type === 'model_change') { const model = readString(record.modelId); if (model) state.model = model; return { state, observations: [] }; }
      const message = record.type === 'message' && isRecord(record.message)
        && (record.message.role === 'assistant' || record.message.role === 'toolResult') ? record.message : null;
      const paidSummary = record.type === 'compaction' || record.type === 'branch_summary';
      if (!message && !paidSummary) return { state, observations: [] };
      const usage = normalizePiPaidUsage(message?.usage ?? record.usage);
      const observedAt = parseTimestampMs(message?.timestamp ?? record.timestamp);
      const inferenceId = readString(record.id);
      if (!usage) return { state, observations: [], ...(paidSummary ? { incomplete: true } : {}) };
      if (!state.sessionId || !inferenceId || observedAt === null) return { state, observations: [], incomplete: true };
      if (state.lineageUnavailable === 'true') return { state, observations: [], incomplete: true, incompleteReason: 'native_fork_lineage_unavailable' };
      const nativeSessionId = state[`inherited:${inferenceId}`] ?? state.sessionId;
      state[`entry:${inferenceId}`] = nativeSessionId;
      // Summary entries carry Usage but no generating model in the native grammar.
      const modelId = readString(message?.model) ?? (message?.role === 'assistant' ? state.model : undefined) ?? null;
      return { state, observations: [{ nativeSessionId, inferenceId, observedAt,
        ...(state[`project:${nativeSessionId}`] ? { project: { rootPath: state[`project:${nativeSessionId}`]! } } : {}),
        accounting: { inputIncludesCache: false, outputIncludesReasoning: false },
        ...(state.parentSessionId && nativeSessionId === state.sessionId ? { parentNativeSessionId: state.parentSessionId } : {}),
        observation: { provider: 'pi', source: 'pi-native-accounting', scope: 'turn_delta', key: inferenceId, modelId,
          tokens: usage.tokens, cost: usage.cost, contextUsedTokens: null, contextWindowTokens: null } }],
        ...(modelId === null ? { incomplete: true } : {}) };
    },
  });
}
