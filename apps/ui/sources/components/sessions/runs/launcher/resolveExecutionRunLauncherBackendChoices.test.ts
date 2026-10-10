import { describe, expect, it, vi } from 'vitest';


vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

const record = AcpCatalogRecordV1Schema.parse({
    v: 1,
    definitions: [
        {
            id: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'acp',
            args: [],
            env: {},
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
});
const acpCatalogSnapshot: AcpCatalogSnapshotV1 = {
    status: 'ready', revision: 4, record,
};

describe('resolveExecutionRunLauncherBackendChoices', () => {
    it('does not revive a configured review backend absent from the ready Account row', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'], intent: 'review',
            executionRunsBackends: { 'backend:removed-bot:configured:removed-bot': { available: true, intents: ['review'] } },
            acpCatalogSnapshot: { status: 'ready', revision: 5, record: { v: 1, definitions: [] } },
        });
        expect(choices.some((choice) => choice.backendTarget.kind === 'backend' && choice.backendTarget.configuredBackendId === 'removed-bot')).toBe(false);
    });
    it('resolves configured launch choices from the ready Account row after Settings root removal', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: { 'review-bot': { available: true, intents: ['delegate'] } },
            acpCatalogSnapshot,
            intent: 'delegate',
        });
        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            title: 'Review Bot', disabled: false,
        }));
    });

    it.each(['delegate', 'review'])('refuses %s choices when the required catalog is incomplete', (intent) => {
        expect(() => resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: { claude: { available: true, intents: [intent] } },
            acpCatalogSnapshot: { status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions: [] }, diagnostics: [] },
            intent,
        })).toThrowError(expect.objectContaining({ code: 'acp_catalog_unavailable' }));
    });
    it('uses the review backend snapshot label for review-intent launcher choices instead of the raw engine id', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['review'], label: 'Claude Review' },
            },
            acpCatalogSnapshot,
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
            acpCatalogSnapshot,
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

    it('preserves the concrete configured ACP review target from the machine snapshot', () => {
        const targetKey = 'backend:review-bot:configured:review-bot';
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: {
                claude: { available: true, intents: ['review'] },
                [targetKey]: { available: true, intents: ['review'], reviewScopes: ['worktree', 'paths'], title: 'Review Bot' },
            },
            acpCatalogSnapshot,
            intent: 'review',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: {
                kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
            },
            targetKey,
            backendId: 'review-bot',
            agentId: 'customAcp',
            title: 'Review Bot',
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
            acpCatalogSnapshot,
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
            acpCatalogSnapshot,
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
            acpCatalogSnapshot,
            intent: 'delegate',
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
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
            acpCatalogSnapshot,
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
                    qualifiedId: 'acme.plugin.provider1',
                    identity: { pluginId: 'acme.plugin', localId: 'provider1' },
                    title: 'Acme Plugin Provider',
                    subtitle: 'acme.plugin.provider1',
                    channel: 'plugin',
                    isBuiltIn: false,
                    iconAgentId: null,
                },
            },
        });

        expect(choices).toContainEqual(expect.objectContaining({
            backendTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.plugin', localId: 'provider1' },
            },
            targetKey: 'agent:acme.plugin.provider1',
            backendId: 'acme.plugin.backend1',
            title: 'Acme Plugin Backend',
            disabled: false,
        }));
    });
});
