import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

export function buildLocalMachineSetupSystemTaskSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
        },
    };
}
