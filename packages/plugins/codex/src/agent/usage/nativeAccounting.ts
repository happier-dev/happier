import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isRecord, parseTimestampMs, readString } from '@happier-dev/plugin-sdk';
import { readAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionAccountingObservation, AgentExternalSessionsReadAccountingRequest } from '@happier-dev/plugin-sdk/sessions/external';
import { homeEntries } from '../rollout/discovery/homeEntries.js';
import type { CodexExternalSessionSource } from '../surfaces/sessions/external/models.js';
import { normalizeCodexTokenUsage } from './tokenCountMessage.js';
import { estimateUsageModelCost, resolveUsageTokenCategories } from '@happier-dev/protocol';

export async function readCodexNativeAccounting(request: AgentExternalSessionsReadAccountingRequest, source: CodexExternalSessionSource, env: NodeJS.ProcessEnv) {
  const homes = await homeEntries({ source, env, signal: request.signal, deadlineAtMs: request.deadlineAtMs });
  const roots = homes.flatMap(({ codexHome }) => [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]);
  return readAgentAccountingJsonlSource({ roots, sourceKey: JSON.stringify(roots), invocation: request,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    projectRecord(record, state, filePath, recordOffsetBytes) {
      if (!isRecord(record)) return { state, observations: [], incomplete: true };
      const payload = isRecord(record.payload) ? record.payload : null;
      if (record.type === 'session_meta' && payload) {
        const id = readString(payload.id); const parent = readString(payload.forked_from_id) ?? readString(payload.parent_thread_id);
        const cwd = readString(payload.cwd);
        return { state: { ...state, ...(id ? { sessionId: id } : {}), ...(cwd ? { cwd } : {}), ...(parent ? { parentSessionId: parent } : {}) }, observations: [] };
      }
      if (record.type === 'turn_context' && payload) return { state: { ...state,
        ...(readString(payload.model) ? { model: String(payload.model) } : {}),
        ...(readString(payload.turn_id) ? { turnId: String(payload.turn_id) } : {}) }, observations: [] };
      const modern = record.type === 'token_usage_record' ? payload : null;
      const legacy = record.type === 'event_msg' && payload?.type === 'token_count' && isRecord(payload.info) ? payload.info : null;
      if (!modern && !legacy) return { state, observations: [] };
      const tokens = normalizeCodexTokenUsage(modern?.usage ?? legacy?.total_token_usage);
      const nativeSessionId = readString(modern?.thread_id) ?? state.sessionId;
      const observedAt = parseTimestampMs(record.timestamp);
      if (!tokens || !nativeSessionId || observedAt === null) return { state, observations: [], incomplete: true };
      const nativeTurnId = readString(modern?.turn_id);
      const witnessedContextModel = !modern || (nativeTurnId && nativeTurnId === state.turnId)
        ? state.model : undefined;
      const modelId = readString(modern?.model) ?? readString(modern?.model_id) ?? witnessedContextModel ?? null;
      const inferenceId = readString(modern?.response_id);
      const scope = modern ? 'turn_delta' as const : 'session_cumulative' as const;
      const estimate = estimateUsageModelCost(modelId, resolveUsageTokenCategories(tokens, { inputIncludesCache: true, outputIncludesReasoning: true }));
      const observation: AgentExternalSessionAccountingObservation = { nativeSessionId, observedAt,
        ...(state.cwd && nativeSessionId === state.sessionId ? { project: { rootPath: state.cwd } } : {}),
        accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
        ...(inferenceId ? { inferenceId } : {}),
        ...(state.parentSessionId ? { parentNativeSessionId: state.parentSessionId } : {}),
        observation: { provider: 'codex', source: 'codex-native-accounting', scope,
          key: inferenceId ?? `${createHash('sha256').update(filePath).digest('base64url')}:${recordOffsetBytes}:${createHash('sha256').update(JSON.stringify(record)).digest('base64url')}`, modelId, tokens,
          cost: estimate ? { reportedUsd: 0, estimatedUsd: estimate.estimatedUsd, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate',
            ...(estimate.breakdown ? { breakdown: estimate.breakdown } : {}) } : null,
          contextUsedTokens: null, contextWindowTokens: null } };
      return { state, observations: [observation], ...(!inferenceId || !modelId ? { incomplete: true } : {}) };
    },
  });
}
