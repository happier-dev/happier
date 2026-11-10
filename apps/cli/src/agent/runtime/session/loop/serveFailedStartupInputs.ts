import type { PermissionModeQueuedPrompt, PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { normalizePermissionModeQueuedPromptLocalIds } from '@/agent/runtime/permissions/queuedPrompt';
import type { SessionProviderInputConsumer } from '@/agent/runtime/session/input/_types';
import type { HostProviderInputOutcomeEvidence } from '@/agent/runtime/session/input/providerInputOutcome';

/** Keep the host's existing custody available when native startup preceded input. */
export async function serveFailedStartupInputs(params: Readonly<{
    consumer: SessionProviderInputConsumer<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
    signal: AbortSignal;
    diagnostic: Readonly<{ code: string; severity: 'error' }>;
    observe: (outcome: HostProviderInputOutcomeEvidence) => void;
    retireAfterInput: boolean;
    retryable: boolean;
}>): Promise<boolean> {
    while (!params.signal.aborted) {
        // A launch refusal can be returned before the caller admits its original.
        // Do not keep a publisher alive waiting for input that will never arrive.
        // Unknown Pending retains custody; the input owner decides emptiness.
        if (params.retireAfterInput && (await params.consumer.readLiveWork()).input === 'settled') return false;
        const batch = await params.consumer.waitForNextInput({ abortSignal: params.signal });
        if (!batch) return false;
        if (batch.message.hostContextOnly) {
            params.consumer.deferContextOnlyInput(batch);
            params.consumer.releaseInputBatch();
            continue;
        }
        for (const localInputId of normalizePermissionModeQueuedPromptLocalIds(batch.message)) {
            params.observe({ type: 'input-rejected', localInputId,
                userMessageSeq: batch.message.userMessageSeq ?? null,
                ...(batch.message.userMessageSeqs ? { userMessageSeqs: batch.message.userMessageSeqs } : {}),
                diagnostic: params.diagnostic, retryable: params.retryable });
        }
        params.consumer.releaseInputBatch();
        // The host lifecycle owns retirement independently of refusal retryability.
        if (params.retireAfterInput) return true;
    }
    return false;
}
