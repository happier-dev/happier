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
    it('uses the review backend snapshot label for review-intent launcher choices instead of the raw engine id', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['review'], label: 'Claude Review' },
            },
            acpCatalogSettingsV1,
            intent: 'review',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendId: 'claude',
            title: 'Claude Review',
            disabled: false,
        }));
    });

    it('uses merged daemon projection titles for source-backed review backends outside enabled canonical agents', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['review'] },
                'coderabbit.review.backend': { available: true, intents: ['review'] },
            },
            acpCatalogSettingsV1,
            intent: 'review',
            mergedBackendProjectionById: {
                'coderabbit.review.backend': {
                    backendId: 'coderabbit.review.backend',
                    agentId: 'coderabbit.review.provider',
                    title: 'CodeRabbit Review',
                    subtitle: 'coderabbit.review.backend',
                    catalogAgentId: null,
                    iconAgentId: null,
                },
            },
            mergedProviderProjectionById: {
                'coderabbit.review.provider': {
                    agentId: 'coderabbit.review.provider',
                    title: 'CodeRabbit Provider',
                    subtitle: 'coderabbit.review.provider',
                    channel: 'plugin',
                    isBuiltIn: false,
                    iconAgentId: null,
                },
            },
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'coderabbit.review.backend' },
            targetKey: 'backend:coderabbit.review.backend',
            backendId: 'coderabbit.review.backend',
            title: 'CodeRabbit Review',
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
                    agentId: 'acme.plugin.provider1',
                    title: 'Acme Plugin Backend',
                    subtitle: 'acme.plugin.backend1',
                    catalogAgentId: null,
                    iconAgentId: null,
                },
            },
            mergedProviderProjectionById: {
                'acme.plugin.provider1': {
                    agentId: 'acme.plugin.provider1',
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
