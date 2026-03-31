import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

export function buildLocalMachineSetupSystemTaskSpec(params: Readonly<{
    installService?: boolean;
    startService?: boolean;
    verifyService?: boolean;
}> = {}): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
            ...(typeof params.installService === 'boolean' ? { installService: params.installService } : {}),
            ...(typeof params.startService === 'boolean' ? { startService: params.startService } : {}),
            ...(typeof params.verifyService === 'boolean' ? { verifyService: params.verifyService } : {}),
        },
    };
}
