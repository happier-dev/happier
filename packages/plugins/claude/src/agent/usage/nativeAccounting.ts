import { join } from 'node:path';
import { isRecord, parseTimestampMs, readString } from '@happier-dev/plugin-sdk';
import { readAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionsReadAccountingRequest } from '@happier-dev/plugin-sdk/sessions/external';
import { resolveClaudeConfigDir, type ClaudeExternalSessionSource } from '../surfaces/sessions/external/source.js';
import { buildClaudeAssistantUsageObservation } from './buildAssistantObservation.js';
import { buildClaudeSdkResultUsageObservation, isClaudeSdkUsageResult } from './buildSdkResultObservation.js';

export function readClaudeNativeAccounting(request: AgentExternalSessionsReadAccountingRequest, source: ClaudeExternalSessionSource, env: NodeJS.ProcessEnv) {
  const root = join(resolveClaudeConfigDir({ source, env }), 'projects');
  return readAgentAccountingJsonlSource({ roots: [root], sourceKey: root, invocation: request,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    projectRecord(record, state) {
      if (!isRecord(record)) return { state, observations: [], incomplete: true };
      const nativeSessionId = readString(record.sessionId) ?? readString(record.session_id) ?? state.sessionId;
      const cwd = readString(record.cwd) ?? (nativeSessionId === state.sessionId ? state.cwd : undefined);
      const nextState = nativeSessionId ? { sessionId: nativeSessionId, ...(cwd ? { cwd } : {}) } : state;
      const message = isRecord(record.message) ? record.message : null;
      const observedAt = parseTimestampMs(record.timestamp);
      const nativeRecordId = readString(record.uuid);
      const usage = message && isRecord(message.usage) ? message.usage : null;
      const observation = record.type === 'assistant' && usage
        ? buildClaudeAssistantUsageObservation({ usage, modelId: readString(message?.model), nativeRecordId, inferenceId: readString(message?.id), ...(observedAt === null ? {} : { observedAtMs: observedAt }) })
        : record.type === 'result'
          ? buildClaudeSdkResultUsageObservation({ result: record, modelId: readString(record.model) ?? '', ...(observedAt === null ? {} : { observedAtMs: observedAt }) })
          : null;
      if (!observation) return { state: nextState, observations: [],
        ...(isClaudeSdkUsageResult(record) ? { incomplete: true } : {}) };
      if (!nativeSessionId || observedAt === null || !nativeRecordId) return { state: nextState, observations: [], incomplete: true };
      const modelId = readString(observation.modelId) ?? null;
      return { state: nextState, observations: [{ nativeSessionId, observedAt, ...(observation.inferenceId ? { inferenceId: observation.inferenceId } : {}),
        ...(cwd ? { project: { rootPath: cwd } } : {}),
        accounting: { inputIncludesCache: false, outputIncludesReasoning: false },
        observation: { provider: observation.provider, source: observation.source, scope: observation.scope,
          key: observation.inferenceId ? observation.key : nativeRecordId,
          modelId, tokens: observation.tokens, cost: observation.cost,
          contextUsedTokens: observation.contextUsedTokens, contextWindowTokens: observation.contextWindowTokens } }],
          ...(modelId === null || (observation.scope === 'turn_delta' && !observation.inferenceId) ? { incomplete: true } : {}) };
    },
  });
}
