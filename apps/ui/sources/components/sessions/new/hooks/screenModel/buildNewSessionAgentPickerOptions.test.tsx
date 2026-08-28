import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

import { buildNewSessionAgentPickerOptions } from './buildNewSessionAgentPickerOptions';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit';

function createEntry(params: Readonly<{
    backendId: string;
    kind: ResolvedBackendCatalogEntry['kind'];
    title: string;
    providerId?: string;
    catalogAgentId?: ResolvedBackendCatalogEntry['catalogAgentId'];
    builtInAgentId?: ResolvedBackendCatalogEntry['builtInAgentId'];
    capabilities?: ResolvedBackendCatalogEntry['capabilities'];
}>): ResolvedBackendCatalogEntry {
    const backendTarget = params.kind === 'configuredBackend'
        ? { kind: 'backend' as const, backendId: params.backendId, configuredBackendId: params.backendId }
        : { kind: 'backend' as const, backendId: params.backendId };
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({
            agentId: params.providerId ?? params.backendId,
        }),
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: params.kind,
        backendId: params.backendId,
        agentId: params.providerId ?? params.backendId,
        catalogAgentId: params.catalogAgentId ?? null,
        builtInAgentId: params.builtInAgentId ?? null,
        iconAgentId: params.catalogAgentId ?? params.builtInAgentId ?? null,
        capabilities: params.capabilities ?? null,
        title: params.title,
        subtitle: null,
        cliAuthBackgroundCheckSafe: false,
    };
}

describe('buildNewSessionAgentPickerOptions', () => {
    it('shows one Antigravity option and filters review-only engines out of the session picker', () => {
        const claude = createEntry({
            backendId: 'claude',
            kind: 'builtInAgent',
            title: 'Claude',
            providerId: 'claude',
            catalogAgentId: 'claude',
            builtInAgentId: 'claude',
            capabilities: { session: { supported: true } },
        });
        const antigravity = createEntry({
            backendId: 'antigravity-localharness',
            kind: 'builtInAgent',
            title: 'Antigravity',
            providerId: 'antigravity',
            catalogAgentId: 'antigravity',
            builtInAgentId: 'antigravity',
            capabilities: { session: { supported: true } },
        });
        const codeRabbit = createEntry({
            backendId: 'coderabbit',
            kind: 'pluginBackend',
            title: 'CodeRabbit',
            providerId: 'coderabbit',
            capabilities: {
                session: { supported: false },
                executionRun: { supported: true },
            },
        });
        const deepSec = createEntry({
            backendId: 'deepsec',
            kind: 'pluginBackend',
            title: 'DeepSec',
            providerId: 'deepsec',
            capabilities: {
                session: { supported: false },
                executionRun: { supported: true },
            },
        });

        const result = buildNewSessionAgentPickerOptions({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claude, antigravity, codeRabbit, deepSec],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectEngineSelection: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            selectedBackendTargetKey: antigravity.backendTargetKey,
            selectedModelId: 'default',
            settings: {} as any,
        });

        expect(result.selectableBackendEntries.map((entry) => entry.backendId)).toEqual(['claude', 'antigravity-localharness']);
        expect(result.agentPickerOptions?.map((option) => option.label)).toEqual(['Claude', 'Antigravity']);
    });
});
