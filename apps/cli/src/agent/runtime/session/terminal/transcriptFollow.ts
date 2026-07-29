import type {
    HostExternalTranscriptFollowEvent,
    HostExternalTranscriptFollowResult,
} from '@/session/external/privateContract';

import type {
    HostTerminalTranscriptFollowBinding,
    HostTerminalTranscriptFollowBindResult,
    HostTerminalTranscriptFollowService,
} from './contract';

function unavailable(code: string): HostTerminalTranscriptFollowBindResult {
    return Object.freeze({ status: 'unavailable', code });
}

export function createHostTerminalTranscriptFollowService(params: Readonly<{
    followProviderSession(
        request: Readonly<{
            agentId: string;
            providerSessionId: string;
            cursor?: string;
            signal: AbortSignal;
        }>,
        listener: (
            event: HostExternalTranscriptFollowEvent,
        ) => void | Promise<void>,
    ): Promise<HostExternalTranscriptFollowResult>;
    signal: AbortSignal;
    publish(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
}>): HostTerminalTranscriptFollowService {
    const activeBindings = new Set<HostTerminalTranscriptFollowBinding>();

    const releaseActiveBindings = async (): Promise<void> => {
        const bindings = Array.from(activeBindings);
        const results = await Promise.allSettled(
            bindings.map(async (binding) => await binding.dispose()),
        );
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
    };

    const service: HostTerminalTranscriptFollowService = Object.freeze({
        async bindProviderSession(request) {
            if (params.signal.aborted || request.signal?.aborted) {
                return unavailable('plugin_operation_aborted');
            }
            if (
                request.agentId.length === 0
                || request.agentId !== request.agentId.trim()
                || request.providerSessionId.length === 0
                || request.providerSessionId !== request.providerSessionId.trim()
            ) {
                return unavailable('plugin_external_follow_identity_mismatch');
            }
            const bindingAbort = new AbortController();
            const signal = AbortSignal.any([
                params.signal,
                bindingAbort.signal,
                ...(request.signal ? [request.signal] : []),
            ]);
            let result: HostExternalTranscriptFollowResult;
            try {
                result = await params.followProviderSession(
                    {
                        agentId: request.agentId,
                        providerSessionId: request.providerSessionId,
                        ...(request.cursor ? { cursor: request.cursor } : {}),
                        signal,
                    },
                    async (event) => {
                        await params.publish(event);
                    },
                );
            } catch (error) {
                bindingAbort.abort();
                throw error;
            }
            if (result.status === 'unavailable') {
                bindingAbort.abort();
                return result;
            }

            let disposePromise: Promise<void> | null = null;
            const binding: HostTerminalTranscriptFollowBinding = Object.freeze({
                async dispose() {
                    disposePromise ??= (async () => {
                        activeBindings.delete(binding);
                        bindingAbort.abort();
                        await result.subscription.dispose();
                    })();
                    await disposePromise;
                },
            });
            activeBindings.add(binding);
            if (signal.aborted) {
                await binding.dispose();
                return unavailable('plugin_operation_aborted');
            }
            return Object.freeze({
                status: 'following',
                startingCursor: result.startingCursor,
                binding,
            });
        },
        releaseActiveBindings,
    });

    const releaseOnAbort = () => {
        void releaseActiveBindings().catch(() => undefined);
    };
    if (params.signal.aborted) releaseOnAbort();
    else params.signal.addEventListener('abort', releaseOnAbort, { once: true });

    return service;
}
