import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

import { runtimeBreadcrumb } from './runtimeBreadcrumb';

type ResolveOhMyPiTerminalTranscriptBindingParams = Parameters<typeof runtimeBreadcrumb>[0];

export function resolveOhMyPiTerminalTranscriptBinding(
    params: ResolveOhMyPiTerminalTranscriptBindingParams,
): LocalHostedDirectTranscriptBinding | undefined {
    const breadcrumb = runtimeBreadcrumb(params);
    if (!breadcrumb) {
        return undefined;
    }

    return {
        providerId: 'ohMyPi',
        source: {
            kind: 'ohMyPiAgentDir',
            agentDir: breadcrumb.agentDir,
        },
        remoteSessionId: breadcrumb.remoteSessionId,
        env: breadcrumb.env,
    };
}
