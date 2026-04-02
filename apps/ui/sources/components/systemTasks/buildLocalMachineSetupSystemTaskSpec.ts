import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

export function buildLocalMachineSetupSystemTaskSpec(params: Readonly<{
    installService?: boolean;
    startService?: boolean;
    verifyService?: boolean;
}> = {}): SystemTaskSpec {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
            channel,
            ...(typeof params.installService === 'boolean' ? { installService: params.installService } : {}),
            ...(typeof params.startService === 'boolean' ? { startService: params.startService } : {}),
            ...(typeof params.verifyService === 'boolean' ? { verifyService: params.verifyService } : {}),
        },
    };
}
