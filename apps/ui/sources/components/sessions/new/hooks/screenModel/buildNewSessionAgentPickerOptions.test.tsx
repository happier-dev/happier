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
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import {
    isBackendEntrySelectableForNewSession,
    resolveBackendEntryUnavailabilityReasonForNewSession,
} from '@/components/sessions/new/modules/newSessionAgentSelection';

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
    it('retains bundled rows disabled beside configured Agents when the Machine cannot answer its catalog', () => {
        const definition = AcpBackendDefinitionV1Schema.parse({ id: 'review', name: 'review', title: 'Review',
            launch: { kind: 'command', command: 'review', args: [] }, createdAt: 1, updatedAt: 1 });
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'codex'],
            mergedProviderProjectionById: null,
            mergedBackendProjectionById: null,
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [definition] } },
        });
        const selection = { machineAgentsById: {}, machineAgentsStatus: 'offline' as const };
        const result = buildNewSessionAgentPickerOptions({
            useProfiles: false, projectionCurrent: false, selectedProfileId: null, profileMap: new Map(),
            resolvedBackendEntries: entries, getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: entry => isBackendEntrySelectableForNewSession({ ...selection, entry }),
            getBackendEntryUnavailabilityReason: entry => resolveBackendEntryUnavailabilityReasonForNewSession({ ...selection, entry }),
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectEngineSelection: vi.fn(), selectedMachineId: 'machine-1', capabilityServerId: 'server-1',
            selectedPath: '/repo', selectedBackendTargetKey: entries[0]!.backendTargetKey, selectedModelId: 'default',
        });
        expect(new Map(result.agentPickerOptions?.map(({ id, disabled }) => [id, disabled])))
            .toEqual(new Map(entries.map(entry => [entry.backendTargetKey, entry.kind !== 'configuredBackend'])));
        expect(result.selectableBackendEntries.map(entry => entry.kind)).toEqual(['configuredBackend']);
        expect(entries.map(entry => entry.agentId)).toEqual(['claude', 'codex', 'custom-acp']);
    });
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
            projectionCurrent: true,
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
        });

        expect(result.selectableBackendEntries.map((entry) => entry.backendId)).toEqual(['claude', 'antigravity-localharness']);
        expect(result.agentPickerOptions?.map((option) => option.label)).toEqual(['Claude', 'Antigravity']);
    });

    it('names a per-Agent reason on its rail row but leaves an unknown machine to the picker header', () => {
        const entry = (id: 'claude' | 'codex') => createEntry({
            backendId: id, kind: 'builtInAgent', title: id, providerId: id, catalogAgentId: id, builtInAgentId: id,
            capabilities: { session: { supported: true } },
        });
        const claude = entry('claude');
        const codex = entry('codex');
        const result = buildNewSessionAgentPickerOptions({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claude, codex],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => false,
            // Nothing is known about Claude on an unreachable machine; Codex is known to be signed out.
            getBackendEntryUnavailabilityReason: (candidate) => candidate === claude ? 'agent-not-ready:claude' : 'logged-out:codex',
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectEngineSelection: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            selectedBackendTargetKey: claude.backendTargetKey,
            selectedModelId: 'default',
        });

        const byLabel = new Map(result.agentPickerOptions?.map((option) => [option.label, option]));
        expect(byLabel.get('claude')?.subtitle).toBeUndefined();
        expect(byLabel.get('codex')?.subtitle).toBe('profiles.machineLogin.status.notLoggedIn');
    });
});
