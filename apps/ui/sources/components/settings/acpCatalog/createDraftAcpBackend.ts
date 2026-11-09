import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

export function createDraftAcpBackend(now = Date.now()): AcpBackendDefinitionV1 {
    return {
        id: '',
        name: '',
        title: '',
        launch: { kind: 'command', command: '', args: [] },
        env: {},
        auth: {
            support: 'unsupported',
        },
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
