import type * as React from 'react';
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
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
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
    it.each([[false, undefined, false], [false, 'machine', false], [false, 'member', true], [true, undefined, true]] as const)(
      'offers the rail install action by requester scope (%s, %s)', (canManageMachine, executionScope, allowed) => {
        const entry = createEntry({ backendId: 'codex', kind: 'builtInAgent', title: 'Codex', providerId: 'codex',
            catalogAgentId: 'codex', builtInAgentId: 'codex', capabilities: { session: { supported: true } } });
        const facts = MachineAgentInventoryItemSchema.parse({ agentId: 'codex', title: 'Codex',
            installed: false, version: null, latestVersion: null, update: { supported: true, command: null },
            signIn: { status: 'unknown', loginSupport: 'login_terminal' }, platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null, ...(executionScope ? { executionScope } : {}) }, dependencies: [] });
        const agent = projectMachineAgent({ agentId: 'codex', title: 'Codex', facts, checking: false, stale: false, connectedServices: [], job: null });
        const installMachineAgent = vi.fn();
        const result = buildNewSessionAgentPickerOptions({
            useProfiles: false, projectionCurrent: true, selectedProfileId: null, profileMap: new Map(),
            resolvedBackendEntries: [entry, createEntry({ backendId: 'claude', kind: 'builtInAgent', title: 'Claude' })],
            getCompatibleProfileBackendEntries: () => [], isBackendEntrySelectable: () => false,
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectBackendTarget: vi.fn(), selectEngineSelection: vi.fn(), selectedMachineId: 'machine-1', capabilityServerId: 'server-1',
            selectedPath: '/repo', selectedBackendTargetKey: entry.backendTargetKey, selectedModelId: 'default',
            getBackendEntryMachineAgent: () => agent, renderMachineAgentSetup: () => null, installMachineAgent, canManageMachine,
        });
        const action = result.agentPickerOptions?.[0]?.statusAction;
        expect(Boolean(action)).toBe(allowed);
        action?.onPress();
        expect(installMachineAgent).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });

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
            selectBackendTarget: vi.fn(), selectEngineSelection: vi.fn(), selectedMachineId: 'machine-1', capabilityServerId: 'server-1',
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
            selectBackendTarget: vi.fn(), selectEngineSelection: vi.fn(),
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
            selectBackendTarget: vi.fn(), selectEngineSelection: vi.fn(),
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

    it('says once, in the open Agent pane, that the machine is offline instead of leaving every greyed Agent unexplained', () => {
        const entry = (id: 'claude' | 'codex') => createEntry({
            backendId: id, kind: 'builtInAgent', title: id, providerId: id, catalogAgentId: id, builtInAgentId: id,
            capabilities: { session: { supported: true } },
        });
        const claude = entry('claude');
        const codex = entry('codex');
        const refreshAgents = vi.fn();
        const build = (machineAgentsStatus: 'offline' | 'ready' | 'loading' | 'idle' | 'error') => buildNewSessionAgentPickerOptions({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claude, codex],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => machineAgentsStatus === 'ready',
            getBackendEntryUnavailabilityReason: (candidate) => machineAgentsStatus === 'ready'
                ? null : `agent-not-ready:${candidate.agentId as 'claude' | 'codex'}`,
            getBackendEntryMachineAgent: () => null,
            selectedMachineName: 'Leeroys-MacBook-Pro',
            machineAgentsStatus,
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectBackendTarget: vi.fn(), selectEngineSelection: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            selectedBackendTargetKey: claude.backendTargetKey,
            selectedModelId: 'default',
            refreshProbe: { phase: 'idle', onRefresh: refreshAgents },
        });
        type PaneProps = { modelSummary?: string; refreshProbe?: { failed?: boolean; refreshErrorMessage?: string; onRefresh?: () => void } | null };
        const pane = (option: NonNullable<ReturnType<typeof build>['agentPickerOptions']>[number] | undefined) => (
            option?.renderDetailContent?.({ onRequestClose: () => {} }) as React.ReactElement<PaneProps> | undefined
        )?.props;
        const paneLine = (option: Parameters<typeof pane>[0]) => pane(option)?.modelSummary;

        // Not reported yet: the agents are being checked; the greyed strip says so once.
        for (const status of ['loading', 'idle'] as const) {
            expect((build(status).agentPickerOptions ?? []).map(paneLine))
                .toEqual(['machineAgents.checkingAgents', 'machineAgents.checkingAgents']);
        }
        // The read failed: the pane's one failure line, whose Retry is the inventory owner's own refresh.
        const failed = pane(build('error').agentPickerOptions?.[0]);
        expect(failed?.modelSummary).toBeUndefined();
        expect(failed?.refreshProbe).toEqual(expect.objectContaining({ failed: true, refreshErrorMessage: 'machineAgents.unknown' }));
        failed?.refreshProbe?.onRefresh?.();
        expect(refreshAgents).toHaveBeenCalledTimes(1);

        const offline = build('offline').agentPickerOptions ?? [];
        // No row repeats it; the pane under the strip says it once, whichever Agent is open.
        expect(offline.map((option) => option.subtitle)).toEqual([undefined, undefined]);
        expect(offline.map(paneLine)).toEqual(['machineAgents.offlineNote', 'machineAgents.offlineNote']);
        // A reachable machine is quiet.
        expect((build('ready').agentPickerOptions ?? []).map(paneLine)).toEqual([undefined, undefined]);
    });
});
