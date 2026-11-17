import { stat } from 'node:fs/promises';
import type { AgentAcpPromptUsageDefinition } from '@happier-dev/plugin-sdk/agents/runtime';
import { readJsonlFileBackwardPage } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { CodeBuddySourceError, isRecord, resolveCodeBuddyFile, resolveCodeBuddySource } from '../externalSessions/source.js';

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** CodeBuddy 2.162 persists per-response OpenAI counters before returning its ACP prompt result. */
export function createCodeBuddyPromptUsage(): AgentAcpPromptUsageDefinition {
  let journal: { sessionId: string; path: string } | undefined;
  return {
    async projectPromptUsage({ usage, promptResponse, completion }) {
      if (usage !== null) return usage;
      if (!completion || !isRecord(promptResponse) || typeof promptResponse.userMessageId !== 'string') return null;
      const metadata = isRecord(promptResponse._meta) ? promptResponse._meta : null;
      const requestId = metadata?.['codebuddy.ai/conversationRequestId'];
      if (typeof requestId !== 'string' || !requestId) return null;
      const { providerSessionId, signal } = completion;
      try {
        if (journal?.sessionId !== providerSessionId) {
          const source = await resolveCodeBuddySource({ kind: 'codebuddyHome' }, completion.env);
          const path = await resolveCodeBuddyFile(source.root, source.source, providerSessionId, signal);
          journal = { sessionId: providerSessionId, path };
        }
        const size = (await stat(journal.path)).size;
        const seen = new Set<string>();
        const models = new Set<string>();
        const tokens = { input: 0, output: 0, total: 0, cacheRead: 0, reasoning: 0 };
        let cacheKnown = true, reasoningKnown = true, matchedUser = false;
        const completedRequest = Symbol('completed-native-request');
        try {
          await readJsonlFileBackwardPage({ filePath: journal.path, endOffsetBytes: null,
            maxBytes: Math.max(1, size), maxOversizeLineBytes: Math.max(1, size), maxItems: Number.MAX_SAFE_INTEGER, signal,
            onLine({ value }) {
              if (!isRecord(value) || value.sessionId !== providerSessionId || !isRecord(value.providerData)
                || value.providerData.conversationRequestId !== requestId) return;
              if (value.type === 'message' && value.role === 'user' && value.id === promptResponse.userMessageId) {
                matchedUser = true; throw completedRequest;
              }
              const native = value.providerData;
              if (typeof native.messageId !== 'string' || seen.has(native.messageId) || !isRecord(native.rawUsage)) return;
              const input = count(native.rawUsage.prompt_tokens), output = count(native.rawUsage.completion_tokens), total = count(native.rawUsage.total_tokens);
              if (input === null || output === null || total === null) return;
              seen.add(native.messageId);
              tokens.input += input; tokens.output += output; tokens.total += total;
              const cache = isRecord(native.rawUsage.prompt_tokens_details) ? count(native.rawUsage.prompt_tokens_details.cached_tokens) : null;
              const reasoning = isRecord(native.rawUsage.completion_tokens_details) ? count(native.rawUsage.completion_tokens_details.reasoning_tokens) : null;
              if (cache === null) cacheKnown = false; else tokens.cacheRead += cache;
              if (reasoning === null) reasoningKnown = false; else tokens.reasoning += reasoning;
              if (typeof native.model === 'string' && native.model) models.add(native.model);
            },
          });
        } catch (error) { if (error !== completedRequest) throw error; }
        if (!matchedUser || seen.size === 0) return null;
        return { tokens: { input: tokens.input, output: tokens.output, total: tokens.total,
          ...(cacheKnown ? { cacheRead: tokens.cacheRead } : {}), ...(reasoningKnown ? { reasoning: tokens.reasoning } : {}) },
          ...(models.size === 1 ? { modelId: [...models][0]! } : {}),
          accounting: { nativeSessionId: providerSessionId, inferenceId: requestId, inputIncludesCache: true, outputIncludesReasoning: true } };
      } catch (error) {
        // Optional native facts cannot turn a completed Agent reply into a failed turn.
        if (error instanceof CodeBuddySourceError || (signal.aborted && error === signal.reason)
          || (isRecord(error) && typeof error.code === 'string' && typeof error.syscall === 'string')) return null;
        throw error;
      }
    },
  };
}
