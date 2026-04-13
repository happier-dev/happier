import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';

const acpCatalogSettingsV1 = {
    v: 2 as const,
    backends: [
        {
            id: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'acp',
            args: [],
            env: {},
            transportProfile: 'generic' as const,
            capabilities: {
                supportsLoadSession: false as const,
                supportsModes: 'unknown' as const,
                supportsModels: 'unknown' as const,
                supportsConfigOptions: 'unknown' as const,
                promptImageSupport: 'unknown' as const,
            },
            createdAt: 1,
            updatedAt: 1,
        },
    ],
};

describe('resolveExecutionRunLauncherBackendChoices', () => {
    it('keeps configured ACP backends enabled when execution-run capability is reported on the ACP provider sentinel', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude', 'customAcp'],
            executionRunsBackends: {
                claude: { available: true, intents: ['delegate'] },
                customAcp: { available: true, intents: ['delegate'] },
            },
            acpCatalogSettingsV1,
            intent: 'delegate',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            target: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            targetKey: 'acpBackend:review-bot',
            backendId: 'review-bot',
            title: 'Review Bot',
            disabled: false,
        }));
    });
});
