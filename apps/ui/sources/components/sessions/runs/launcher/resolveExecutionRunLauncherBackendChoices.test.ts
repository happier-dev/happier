import { describe, expect, it, vi } from 'vitest';


vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunLauncherBackendChoices, resolveInitialExecutionRunBackendTargetKey } from './resolveExecutionRunLauncherBackendChoices';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { readBundledAgentPresentation } from '@happier-dev/agents/presentation';

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
    it('projects exact ready and unavailable engines from the daemon Review Action without reading UI eligibility', () => {
        const targetKey = 'agent:acme.review/reviewer';
        const configured = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
        const items = [{ engineId: 'acme.review/reviewer', value: targetKey, backendId: 'acme.review/reviewer',
            label: 'Acme Reviewer', enabled: false, available: false, readiness: 'needsSignIn' as const,
            unavailableCode: 'needsSignIn', capabilities: { structuredNarration: false } },
        { engineId: configured, value: configured, backendId: 'review-bot', label: 'Exact ACP reviewer',
            enabled: true, available: true, readiness: 'ready' as const, capabilities: { structuredNarration: false } }];
        const launcher = { enabledAgentIds: ['claude'], intent: 'review', executionRunsBackends: {
            claude: { available: true, intents: ['review'] }, [targetKey]: { available: true, intents: ['delegate'] },
        } };
        expect(resolveExecutionRunLauncherBackendChoices(launcher)).toEqual([]);
        const choices = resolveExecutionRunLauncherBackendChoices({ ...launcher, reviewEngines: items });
        expect(choices).toEqual([
            expect.objectContaining({ targetKey, reviewEngineId: items[0]!.engineId,
                title: 'Acme Reviewer', disabled: true, reviewInventoryItem: items[0] }),
            expect.objectContaining({ targetKey: configured, backendId: 'review-bot', agentId: 'custom-acp',
                title: 'Exact ACP reviewer', disabled: false, reviewInventoryItem: items[1] }),
        ]);
        expect(resolveInitialExecutionRunBackendTargetKey(choices[0]!.backendTarget, choices)).toBeNull();
    });

    it('keeps a qualified configured delegate target executable and definition-qualified in the Action key', () => {
        const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
        const choices = resolveExecutionRunLauncherBackendChoices({ enabledAgentIds: [], intent: 'delegate', acpCatalogSnapshot,
            executionRunsBackends: { [targetKey]: { available: true, intents: ['delegate'] } } });
        expect(choices).toEqual([expect.objectContaining({ backendId: 'review-bot', agentId: 'custom-acp',
            targetKey, disabled: false })]);
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

    it('keeps native delegate choices independent of an incomplete configured catalog', () => {
        const choices = resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds: ['claude'],
            executionRunsBackends: { claude: { available: true, intents: ['delegate'] } },
            acpCatalogSnapshot: { status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions: [] }, diagnostics: [] },
            intent: 'delegate',
        });
        expect(choices).toEqual([expect.objectContaining({ backendId: 'claude', disabled: false })]);
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
            title: readBundledAgentPresentation('claude')!.name,
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

});
