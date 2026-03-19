import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol';

export function createDraftAcpBackend(now = Date.now()): AcpBackendDefinitionV1 {
    return {
        id: '',
        name: '',
        title: '',
        command: '',
        args: [],
        env: {},
        auth: {
            support: 'unsupported',
        },
        transportProfile: 'generic',
        defaultMode: undefined,
        defaultModel: undefined,
        capabilities: {
            supportsLoadSession: false,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'unknown',
        },
        createdAt: now,
        updatedAt: now,
    };
}
