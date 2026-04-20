import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';

vi.mock('@/sync/domains/reviews/reviewEngineCatalog', () => ({
    buildAvailableReviewEngineOptions: () => ([
        {
            id: 'review-engine-1',
            label: 'Review Engine One',
        },
    ]),
}));

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
    it('uses the review engine label for review-intent launcher choices instead of the raw engine id', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['review'] },
            },
            acpCatalogSettingsV1,
            intent: 'review',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendId: 'review-engine-1',
            title: 'Review Engine One',
            disabled: false,
        }));
    });

    it('keeps configured ACP backends enabled when execution-run capability is reported on the configured backend id', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['delegate'] },
                'review-bot': { available: true, intents: ['delegate'] },
            },
            acpCatalogSettingsV1,
            intent: 'delegate',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            targetKey: 'acpBackend:review-bot',
            backendId: 'review-bot',
            title: 'Review Bot',
            disabled: false,
        }));
    });

    it('prefers the configured ACP backend entry when discovered backend ids collide with configured ACP ids', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['delegate'] },
                'review-bot': { available: true, intents: ['delegate'] },
            },
            acpCatalogSettingsV1,
            intent: 'delegate',
        });

        expect(choices.filter((choice) => choice.title === 'Review Bot')).toEqual([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                targetKey: 'acpBackend:review-bot',
                backendId: 'review-bot',
                title: 'Review Bot',
                disabled: false,
            }),
        ]);
    });

    it('uses the resolved backend catalog title for built-in launcher choices instead of the raw backend id', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['delegate'] },
            },
            acpCatalogSettingsV1,
            intent: 'delegate',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'claude' },
            targetKey: 'agent:claude',
            backendId: 'claude',
            title: 't:agentInput.agent.claude',
            disabled: false,
        }));
    });

    it('uses merged daemon projection titles for plugin backend choices when available', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['delegate'] },
                'acme.plugin.backend1': { available: true, intents: ['delegate'] },
            },
            acpCatalogSettingsV1,
            intent: 'delegate',
            mergedBackendProjectionById: {
                'acme.plugin.backend1': {
                    backendId: 'acme.plugin.backend1',
                    providerId: 'acme.plugin.provider1',
                    title: 'Acme Plugin Backend',
                    subtitle: 'acme.plugin.backend1',
                    providerAgentId: null,
                    iconAgentId: null,
                },
            },
            mergedProviderProjectionById: {
                'acme.plugin.provider1': {
                    providerId: 'acme.plugin.provider1',
                    title: 'Acme Plugin Provider',
                    subtitle: 'acme.plugin.provider1',
                    channel: 'plugin',
                    isBuiltIn: false,
                    iconAgentId: null,
                },
            },
        } as any);

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'acme.plugin.backend1' },
            targetKey: 'agent:acme.plugin.backend1',
            backendId: 'acme.plugin.backend1',
            title: 'Acme Plugin Backend',
            disabled: false,
        }));
    });
});
