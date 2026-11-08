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
}>): Promise<boolean> {
    while (!params.signal.aborted) {
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
                diagnostic: params.diagnostic, retryable: params.retireAfterInput });
        }
        params.consumer.releaseInputBatch();
        // A generic failed host must retire so the visible Pending Retry can
        // start a new runtime. Typed permanent refusals retain their Stop flow.
        if (params.retireAfterInput) return true;
    }
    return false;
}
