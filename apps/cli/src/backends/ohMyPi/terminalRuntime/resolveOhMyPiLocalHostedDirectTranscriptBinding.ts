import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

import { readOhMyPiTerminalRuntimeBreadcrumb } from './readOhMyPiTerminalRuntimeBreadcrumb';

type ResolveOhMyPiLocalHostedDirectTranscriptBindingParams = Parameters<typeof readOhMyPiTerminalRuntimeBreadcrumb>[0];

export function resolveOhMyPiLocalHostedDirectTranscriptBinding(
    params: ResolveOhMyPiLocalHostedDirectTranscriptBindingParams,
): LocalHostedDirectTranscriptBinding | undefined {
    const breadcrumb = readOhMyPiTerminalRuntimeBreadcrumb(params);
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
