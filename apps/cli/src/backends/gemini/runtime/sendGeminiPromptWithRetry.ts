import type { AgentBackend } from '@/agent';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export async function sendGeminiPromptWithRetry(params: {
  backend: AgentBackend;
  acpSessionId: string;
  prompt: string;
  messageBuffer: MessageBuffer;
  session: ApiSessionClient;
  onDebug: (message: string) => void;
  maxRetries?: number;
  retryDelayMs?: number;
  waitForResponseTimeoutMs?: number;
}): Promise<void> {
  const maxRetries = typeof params.maxRetries === 'number' ? params.maxRetries : 3;
  const retryDelayMs = typeof params.retryDelayMs === 'number' ? params.retryDelayMs : 2_000;
  const waitForResponseTimeoutMs = typeof params.waitForResponseTimeoutMs === 'number'
    ? params.waitForResponseTimeoutMs
    : 120_000;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await params.backend.sendPrompt(params.acpSessionId, params.prompt);
      params.onDebug('[gemini] Prompt sent successfully');

      // Wait for Gemini to finish responding (all chunks received + final idle)
      // This ensures we don't send task_complete until response is truly done.
      if (params.backend.waitForResponseComplete) {
        await params.backend.waitForResponseComplete(waitForResponseTimeoutMs);
        params.onDebug('[gemini] Response complete');
      }

      break;
    } catch (promptError) {
      lastError = promptError;
      const errObj = promptError as any;
      const errorDetails = errObj?.data?.details || errObj?.details || errObj?.message || '';
      const errorCode = errObj?.code;

      // Quota/capacity errors are not retryable.
      const isQuotaError = errorDetails.includes('exhausted') ||
        errorDetails.includes('quota') ||
        errorDetails.includes('capacity');
      if (isQuotaError) {
        const resetTimeMatch = errorDetails.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
        let resetTimeMsg = '';
        if (resetTimeMatch) {
          const parts = resetTimeMatch.slice(1).filter(Boolean).join('');
          resetTimeMsg = ` Quota resets in ${parts}.`;
        }
        const quotaMsg = `Gemini quota exceeded.${resetTimeMsg} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`;
        params.messageBuffer.addMessage(quotaMsg, 'status');
        params.session.sendAgentMessage('gemini', { type: 'message', message: quotaMsg });
        throw promptError;
      }

      // Retry transient internal/empty-response failures.
      const isEmptyResponseError = errorDetails.includes('empty response') ||
        errorDetails.includes('Model stream ended');
      const isInternalError = errorCode === -32603;
      const isRetryable = isEmptyResponseError || isInternalError;

      if (isRetryable && attempt < maxRetries) {
        params.onDebug(`[gemini] Retryable error on attempt ${attempt}/${maxRetries}: ${errorDetails}`);
        params.messageBuffer.addMessage(`Gemini returned empty response, retrying (${attempt}/${maxRetries})...`, 'status');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }

      throw promptError;
    }
  }

  if (lastError && maxRetries > 1) {
    // If we had transient failures but eventually succeeded.
    params.onDebug('[gemini] Prompt succeeded after retries');
  }
}
