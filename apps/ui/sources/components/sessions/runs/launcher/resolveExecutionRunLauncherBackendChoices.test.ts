import { describe, expect, it, vi } from 'vitest';


vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';

const record = AcpCatalogRecordV1Schema.parse({
    v: 1,
    definitions: [
        {
            id: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            launch: { kind: 'command' as const, command: 'acp', args: [] },
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
    it('uses canonical native snapshot facts for one review choice', () => {
        const targetKey = 'agent:happier.agent.claude/claude';
        const choices = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: ['claude'], intent: 'review', acpCatalogSnapshot,
            executionRunsBackends: { [targetKey]: { available: true, intents: ['review'], title: 'Claude review' } } });
        expect(choices).toEqual([expect.objectContaining({ backendId: 'claude', agentId: 'claude', title: 'Claude review', disabled: false })]);
    });
    it('names review choices by their catalog title, never the raw agent id, before the machine reports titles', () => {
        const unreported = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: ['claude', 'codex'], intent: 'review', executionRunsBackends: undefined });
        expect(unreported.map((choice) => choice.title)).toEqual(['t:agentInput.agent.claude', 't:agentInput.agent.codex']);
        const untitled = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'], intent: 'review',
            executionRunsBackends: { claude: { available: true, intents: ['review'] } },
        });
        expect(untitled.map((choice) => choice.title)).toEqual(['t:agentInput.agent.claude']);
    });
    it('resolves qualified configured review targets to the exact row and operational Agent', () => {
        const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
        const choices = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: [], intent: 'review', acpCatalogSnapshot,
            executionRunsBackends: { [targetKey]: { available: true, intents: ['review'] } } });
        expect(choices).toEqual([expect.objectContaining({ backendId: 'review-bot', agentId: 'custom-acp', targetKey,
            backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' } })]);
    });
    it('does not revive a qualified configured review target from an unavailable or deleted row', () => {
        const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
        for (const catalog of [{ status: 'unavailable' as const, reason: 'account-mode-mismatch' },
            { status: 'ready' as const, revision: 5, record: { v: 1 as const, definitions: [] } }]) {
            expect(resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: [], intent: 'review', acpCatalogSnapshot: catalog,
                executionRunsBackends: { [targetKey]: { available: true, intents: ['review'] } } })).toEqual([]);
        }
    });
    it('keeps a qualified configured delegate target executable and definition-qualified in the Action key', () => {
        const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
        const choices = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: [], intent: 'delegate', acpCatalogSnapshot,
            executionRunsBackends: { [targetKey]: { available: true, intents: ['delegate'] } } });
        expect(choices).toEqual([expect.objectContaining({ backendId: 'review-bot', agentId: 'custom-acp',
            targetKey, disabled: false })]);
    });
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
            backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
            title: 'Review Bot', disabled: false,
        }));
    });

    it.each(['delegate', 'review'])('keeps native %s choices independent of an incomplete configured catalog', (intent) => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: { claude: { available: true, intents: [intent] } },
            acpCatalogSnapshot: { status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions: [] }, diagnostics: [] },
            intent,
        });
        expect(choices).toContainEqual(expect.objectContaining({ backendId: 'claude', disabled: false }));
        expect(choices.some((choice) => choice.backendTarget.kind === 'agent' && choice.backendTarget.definitionId)).toBe(false);
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
            targetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
            backendId: 'review-bot',
            agentId: 'custom-acp',
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
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
                targetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
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
            targetKey: 'agent:happier.agent.claude/claude',
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
            targetKey: 'agent:acme.plugin/provider1',
            backendId: 'acme.plugin.backend1',
            title: 'Acme Plugin Backend',
            disabled: false,
        }));
    });

    describe('Machine facts', () => {
        const machineAgent = (overrides: Partial<MachineAgent>): MachineAgent => ({
            agentId: 'claude', title: 'Claude', state: 'ready', installed: true, version: '1.0.0', latestVersion: null, update: null,
            signIn: { status: 'unknown', via: null, nativeLogin: 'terminal', connectedServices: [] },
            platform: { supported: true },
            install: { available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: null, requiresVendorConsent: false },
            dependencies: [], job: null, stale: false, ...overrides,
        });

        it('offers no review choice while the Machine has not answered, and the same choices once it has', () => {
            const reviewable = { claude: { available: true, intents: ['review'] }, codex: { available: true, intents: ['review'] } };
            const unread = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: ['claude', 'codex'], intent: 'review', executionRunsBackends: null });
            expect(unread.map((choice) => choice.backendId)).toEqual(['claude', 'codex']);
            expect(unread.every((choice) => choice.disabled)).toBe(true);
            const answered = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: ['claude', 'codex'], intent: 'review', executionRunsBackends: reviewable });
            expect(answered.map((choice) => choice.disabled)).toEqual([false, false]);
        });

        it('places an Agent the Machine does not have as not on the Machine, and leaves a signed-out one choosable', () => {
            const reviewable = { claude: { available: true, intents: ['review'] }, codex: { available: true, intents: ['review'] }, opencode: { available: true, intents: ['review'] } };
            const choices = resolveExecutionRunLauncherBackendChoices({
                enabledAgentIds: ['claude', 'codex', 'opencode'], intent: 'review', executionRunsBackends: reviewable,
                machineAgents: [
                    machineAgent({ agentId: 'claude' }),
                    machineAgent({ agentId: 'codex', state: 'needsSignIn', signIn: { status: 'signedOut', via: null, nativeLogin: 'terminal', connectedServices: [] } }),
                    machineAgent({ agentId: 'opencode', state: 'notInstalled', installed: false, version: null }),
                ],
            });
            expect(choices.map((choice) => [choice.backendId, choice.disabled, choice.unavailable])).toEqual([
                ['claude', false, undefined],
                ['codex', false, undefined],
                ['opencode', true, 'notOnMachine'],
            ]);
        });
    });
});
