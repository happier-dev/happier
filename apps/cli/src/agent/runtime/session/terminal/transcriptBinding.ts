import type {
    TerminalRuntimeDirectTranscriptBindingV1,
    TerminalRuntimeTranscriptBindingHostServiceV1,
} from '@happier-dev/agents';

import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

type DirectTranscriptMirror = Readonly<{
    start(): Promise<void>;
    stop(): Promise<void>;
}>;

type CreateDirectTranscriptMirror = (params: Readonly<{
    binding: LocalHostedDirectTranscriptBinding;
    onItems: Parameters<
        TerminalRuntimeTranscriptBindingHostServiceV1['openDirectMirror']
    >[0]['onItems'];
}>) => DirectTranscriptMirror;

function toLocalHostedDirectTranscriptBinding(
    binding: TerminalRuntimeDirectTranscriptBindingV1,
): LocalHostedDirectTranscriptBinding {
    return {
        providerId: binding.providerId,
        source: binding.source,
        remoteSessionId: binding.remoteSessionId,
    };
}

export function createTerminalRuntimeTranscriptBindingHostService(deps?: Readonly<{
    createMirror?: CreateDirectTranscriptMirror;
}>): TerminalRuntimeTranscriptBindingHostServiceV1 {
    return Object.freeze({
        async openDirectMirror(request) {
            const createMirror = deps?.createMirror
                ?? (await import('@/agent/terminalRuntime/createLocalHostedDirectTranscriptMirror')).createLocalHostedDirectTranscriptMirror;
            const mirror: DirectTranscriptMirror = createMirror({
                binding: toLocalHostedDirectTranscriptBinding(request.binding),
                onItems: request.onItems,
            });
            await mirror.start();
            return Object.freeze({
                stop: async () => {
                    await mirror.stop();
                },
            });
        },
    });
}
