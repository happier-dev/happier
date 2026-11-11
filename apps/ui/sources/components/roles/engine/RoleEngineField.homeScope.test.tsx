import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    publishAppliedActiveServerRuntimeAvailability,
    publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveRoleEngineTargetKey, useRoleEnginePresentation } from '../catalog/useRoleEnginePresentation';
import { useRoleRailItems } from '../rail/useRoleRailItems';
import { RolesRailDetailView } from '../rail/RolesRailDetail';
import { t } from '@/text';
import { RoleEngineField } from './RoleEngineField';
import { applyAcpCatalogSnapshot, getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { resolveRoleDefinitionV1, resolveRoleSelectionV1, resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { rememberLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';

// Native portal/window measurement is the system boundary; the picker and catalog stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

const engine = { agentTargetKey: 'backend:focused-review:configured:focused-review', modelId: 'stored-model', effort: 'high' } as const;
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

beforeEach(() => {
    resetAcpCatalogEngineForTests();
    previousState = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.getState().activateProfileScope({ serverId: 'focused-home', accountId: 'focused-account' });
    publishAppliedActiveServerSnapshot({ serverId: 'focused-home', serverUrl: 'https://focused-home.test', generation: 1 });
    storage.setState({ settings: {
        ...storage.getState().settings,
        backendEnabledByTargetKey: { [engine.agentTargetKey]: true },
    } });
    const scope = { serverId: 'focused-home', accountId: 'focused-account' };
    rememberLastUsedBackendSelection(scope, { lastUsedAgent: null, lastUsedBackendTarget: null });
    storage.setState({ settingsScope: scope });
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({
        v: 1, definitions: [{
            id: 'focused-review', name: 'focused-review', title: 'Focused Review',
            description: 'Focused review', launch: { kind: 'command' as const, command: 'review-agent', args: [] }, env: {}, defaultMode: 'default', defaultModel: 'default',
            capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
            createdAt: 1, updatedAt: 1,
        }],
    }) }, true);
});

afterEach(() => {
    standardCleanup();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.getState().clearProfileScope();
    storage.setState(previousState, true);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
});

describe('role engine exact Home qualification', () => {
    it('opens engine choices from the same current private catalog as role labels', async () => {
        const screen = await renderScreen(<RoleEngineField engine={undefined} label="engine" onChange={() => {}} testID="engine-field" />);
        await screen.pressByTestIdAsync('engine-field');
        expect(screen.findAll(node => node.props?.options?.some?.((option: { label: string }) => option.label === 'Focused Review')).length).toBeGreaterThan(0);
    });
    it('settles an incomplete private catalog as unavailable rather than indefinitely loading', async () => {
        const screen = await renderScreen(<RoleEngineField engine={undefined} label="engine" onChange={() => {}} testID="engine-field" />);
        await screen.pressByTestIdAsync('engine-field');
        await act(async () => {
            applyAcpCatalogSnapshot({ serverId: 'focused-home', accountId: 'focused-account' }, {
                status: 'partial', revision: 2, reason: 'incomplete-inventory',
                record: { v: 1, definitions: [] }, diagnostics: [{ path: 'definitions[0]', reason: 'invalid_definition' }],
            }, true);
        });
        expect(screen.tree.root.findByType(SurfaceStateCard).props.kind).toBe('error');
    });
    it.each(['another-home', null])('does not disclose focused Account engine identity for target %s', async (serverId) => {
        const hook = await renderHook(() => useRoleEnginePresentation(serverId));

        expect(hook.getCurrent()(engine)).toEqual({ label: 'stored-model · high', choiceLabel: 'stored-model · high', icon: null, unavailable: true, pending: false });
        expect(hook.getCurrent()(undefined)).toEqual({ label: null, choiceLabel: null, icon: null, unavailable: false, pending: false });
    });

    it('names the agent a role without an engine runs on, with that agent\'s own mark', async () => {
        // Configured catalog presence is not a preference (dc905138273).
        rememberLastUsedBackendSelection(storage.getState().settingsScope, {
            lastUsedBackendTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'focused-review' },
        });
        const hook = await renderHook(() => useRoleEnginePresentation());
        const presented = hook.getCurrent()(undefined);
        // The role follows the Account's preferred agent: its title and mark, not "Default agent".
        expect(presented.label).toBe('Focused Review');
        expect(presented.choiceLabel).toBe('Focused Review');
        expect(presented.icon).not.toBeNull();
        expect(presented.unavailable).toBe(false);
    });

    it('says nothing about the agent a role without an engine follows until the catalog has named it', async () => {
        resetAcpCatalogSnapshotsForTests();
        const hook = await renderHook(() => useRoleEnginePresentation());
        const presented = hook.getCurrent()(undefined);
        expect(presented.pending).toBe(true);
        expect(presented.label).toBeNull();
        expect(presented.icon).toBeNull();
    });
    it('names an explicitly preferred bundled Agent without waiting for the independent configured catalog', async () => {
        resetAcpCatalogSnapshotsForTests();
        rememberLastUsedBackendSelection(storage.getState().settingsScope, {
            lastUsedBackendTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude },
        });
        const hook = await renderHook(() => useRoleEnginePresentation());
        const presented = hook.getCurrent()(undefined);
        expect(presented).toMatchObject({ label: 'Claude', choiceLabel: 'Claude', pending: false, unavailable: false });
        expect(presented.icon).not.toBeNull();
        expect(hook.getCurrent()({ agentTargetKey: resolveBackendTargetKeyV2({
            kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude,
        }) }).label).toBe('Claude');
    });
    it('does not replace an explicitly preferred configured Agent while its catalog is loading', async () => {
        resetAcpCatalogSnapshotsForTests();
        rememberLastUsedBackendSelection(storage.getState().settingsScope, {
            lastUsedBackendTarget: { kind: 'backend', backendId: 'focused-review', configuredBackendId: 'focused-review' },
        });
        const hook = await renderHook(() => useRoleEnginePresentation());
        expect(hook.getCurrent()(undefined)).toMatchObject({ label: null, pending: true });
    });
    it('keeps Account Settings while a Home-qualified presentation retires and reopens with its runtime', async () => {
        const scope = { serverId: 'focused-home', accountId: 'focused-account' };
        const catalog = getAcpCatalogSnapshot(scope)?.catalog;
        if (catalog?.status !== 'ready') throw new Error('Expected the seeded ready catalog');
        const settings = await renderHook(() => useRoleEnginePresentation());
        const session = await renderHook(() => useRoleEnginePresentation('focused-home'));
        expect(settings.getCurrent()(engine).label).toBe('Focused Review · stored-model · high');
        // Beside the agent's own mark, the line starts at the model.
        expect(settings.getCurrent()(engine).choiceLabel).toBe('stored-model · high');
        expect(session.getCurrent()(engine).unavailable).toBe(false);

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });

        expect(session.getCurrent()(engine)).toEqual({ label: 'stored-model · high', choiceLabel: 'stored-model · high', icon: null, unavailable: true, pending: false });
        expect(settings.getCurrent()(engine).unavailable).toBe(false);

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        // Retirement withdraws catalog freshness (53135463ad0); the returning
        // runtime's catalog producer supplies a fresh snapshot before naming it.
        await act(async () => { applyAcpCatalogSnapshot(scope, catalog, true); });
        expect(session.getCurrent()(engine).label).toBe('Focused Review · stored-model · high');
        expect(session.getCurrent()(engine).unavailable).toBe(false);

        await act(async () => {
            publishAppliedActiveServerSnapshot({ serverId: 'another-home', serverUrl: 'https://another-home.test', generation: 2 });
        });
        expect(session.getCurrent()(engine)).toEqual({ label: 'stored-model · high', choiceLabel: 'stored-model · high', icon: null, unavailable: true, pending: false });
        await act(async () => {
            publishAppliedActiveServerSnapshot({ serverId: 'focused-home', serverUrl: 'https://focused-home.test', generation: 3 });
        });
        await act(async () => { applyAcpCatalogSnapshot(scope, catalog, true); });
        expect(session.getCurrent()(engine).unavailable).toBe(false);
    });

    it('names the Account declaration separately from the engine captured in a Session Role snapshot', async () => {
        const declaration = resolveRoleDefinitionV1({
            roleId: 'reviewer',
            settingsOverrides: { reviewer: { roleId: 'reviewer', engine } },
        });
        if (!declaration.ok) throw new Error('Expected an editable Role declaration');
        const capturedEngine = {
            agentTargetKey: resolveBackendTargetKeyV2({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex }),
            modelId: 'gpt-6-luna',
        };
        const sessionRoles = snapshotSessionRolesAtSpawnV1({
            leadSessionId: 'lead-session',
            roles: resolveRolesSnapshotV1({ defaultEngine: capturedEngine }),
        });
        const resolved = resolveRoleSelectionV1({
            roleId: 'reviewer',
            settingsOverrides: { reviewer: { roleId: 'reviewer', engine } },
            sessionRoles,
        });
        expect(resolved.ok ? resolved.selection.engine : null).toEqual(capturedEngine);
        const settings = await renderHook(() => useRoleEnginePresentation());
        const rail = await renderHook(() => useRoleRailItems(undefined, 'focused-home', sessionRoles, true));
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });

        const accountEngine = settings.getCurrent()(declaration.selection.engine);
        expect(accountEngine.label).toBe('Focused Review · stored-model · high');
        // A configured definition declares Custom ACP, never a backing Agent inferred from its command.
        expect(React.isValidElement<{ entry: { identity: unknown } }>(accountEngine.icon)
            ? accountEngine.icon.props.entry.identity : null).toEqual(CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1);
        expect(rail.getCurrent().find(item => item.roleId === 'reviewer')).toMatchObject({
            agentTargetKey: capturedEngine.agentTargetKey,
            engineLabel: 'Codex · gpt-6-luna',
        });
        expect(declaration.selection.engine).toEqual(engine);
    });

    it('retains a session-authored role in an unavailable Home rail without naming focused Account engines', async () => {
        const hook = await renderHook(() => useRoleRailItems(undefined, 'another-home', {
            sessionRoles: { 'session:review': {
                roleId: 'session:review', name: 'Session review', instructions: 'Review this work',
                runsAs: { kind: 'session' }, engine,
                workspaceWrites: 'deny', secondOpinion: 'off', enabled: true,
            } },
            overrides: { 'session:review': { roleId: 'session:review', engine: { ...engine, modelId: 'session-model' } } },
            notes: '',
        }));

        expect(hook.getCurrent()).toEqual([expect.objectContaining({
            roleId: 'session:review', name: 'Session review', engineLabel: 'session-model · high',
        })]);
        expect(hook.getCurrent()[0]?.engineIcon).toBeUndefined();
    });

    it.each(['another-home', null])('does not offer the engine picker for unavailable target %s', async (serverId) => {
        const onChange = vi.fn();
        const screen = await renderScreen(<RoleEngineField serverId={serverId} engine={engine}
            label="stored-model · high" onChange={onChange} testID="engine-field" />);

        expect(screen.findByTestId('engine-field')?.props.disabled).toBe(true);
        expect(screen.findAllHostsByTestId('agent-input-chip-picker-popover')).toEqual([]);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('leaves the matching Home and unscoped Account Settings engine fields available', async () => {
        const screen = await renderScreen(<>
            <RoleEngineField serverId="focused-home" engine={engine} label="engine" onChange={() => {}} testID="session-engine" />
            <RoleEngineField engine={engine} label="engine" onChange={() => {}} testID="settings-engine" />
        </>);

        expect(screen.findByTestId('session-engine')?.props.disabled).not.toBe(true);
        expect(screen.findByTestId('settings-engine')?.props.disabled).not.toBe(true);
    });
    it('opens the engine popover on the role effort and writes the chosen effort as engine.effort', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<RoleEngineField engine={engine} label="engine" onChange={onChange} testID="engine-field" />);
        await screen.pressByTestIdAsync('engine-field');
        const options = screen.findAll(node => Array.isArray(node.props?.options)
            && node.props.options.some((option: { label: string }) => option.label === 'Focused Review'))[0]!.props.options as ReadonlyArray<{
            label: string; renderDetailContent: (input: { onRequestClose: () => void }) => React.ReactElement<{
                selectedConfigOverrides: Readonly<Record<string, string>>;
                onSelectionChange: (next: { modelId: string; sessionModeId: null; configOverrides: Readonly<Record<string, string>> }) => void;
            }>;
        }>;
        const detailScreen = await renderScreen(options.find(option => option.label === 'Focused Review')!.renderDetailContent({ onRequestClose: () => {} }));
        const detail = detailScreen.tree.root.findByType(NewSessionEngineOptionDetail);

        // The role's stored effort is the effort the picker shows as chosen.
        expect(detail.props.selectedConfigOverrides).toEqual({ reasoning_effort: 'high' });
        const select = detail.props.onSelectionChange;
        if (!select) throw new Error('Missing engine selection callback');

        select({ modelId: 'stored-model', modelSelection: null, modelLabel: null, sessionModeId: 'default', configOverrides: { reasoning_effort: 'low' } });
        // Written in the catalog's canonical key, the same Agent the stored role named.
        const agentTargetKey = resolveRoleEngineTargetKey(engine.agentTargetKey);
        expect(onChange).toHaveBeenLastCalledWith({ agentTargetKey, modelId: 'stored-model', effort: 'low' });

        // A model the effort does not apply to clears it instead of keeping a stale one.
        select({ modelId: 'other-model', modelSelection: null, modelLabel: null, sessionModeId: 'default', configOverrides: {} });
        expect(onChange).toHaveBeenLastCalledWith({ agentTargetKey, modelId: 'other-model' });
    });

    it('keeps the invoking workflow machine and directory on the shared engine detail', async () => {
        const screen = await renderScreen(<RoleEngineField engine={engine} label="engine" onChange={() => {}}
            machineId="workflow-machine" directory="/workflow/repo" testID="engine-field" />);
        await screen.pressByTestIdAsync('engine-field');
        const options = screen.findAll(node => Array.isArray(node.props?.options)
            && node.props.options.some((option: { label: string }) => option.label === 'Focused Review'))[0]!.props.options;
        const detailScreen = await renderScreen(options.find((option: { label: string }) => option.label === 'Focused Review')
            .renderDetailContent({ onRequestClose() {} }));
        const detail = detailScreen.tree.root.findByType(NewSessionEngineOptionDetail);
        expect(detail.props).toMatchObject({ selectedMachineId: 'workflow-machine', cwd: '/workflow/repo' });
    });

    it('uses the incumbent recent Machine and directory preferences for neutral Account role editing', async () => {
        const machine = createMachineFixture({ id: 'recent-machine', activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { 'focused-home': [machine] } });
        storage.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: machine.id, path: '/recent/repo' }] });
        const screen = await renderScreen(<RoleEngineField engine={engine} label="engine" onChange={() => {}} testID="engine-field" />);
        await screen.pressByTestIdAsync('engine-field');
        const options = screen.findAll(node => Array.isArray(node.props?.options)
            && node.props.options.some((option: { label: string }) => option.label === 'Focused Review'))[0]!.props.options;
        const detailScreen = await renderScreen(options.find((option: { label: string }) => option.label === 'Focused Review')
            .renderDetailContent({ onRequestClose() {} }));
        const detail = detailScreen.tree.root.findByType(NewSessionEngineOptionDetail);
        expect(detail.props).toMatchObject({ selectedMachineId: machine.id, cwd: '/recent/repo' });
    });

    it('keeps a role no layer can resolve in the rail as unavailable instead of dropping it', async () => {
        const hook = await renderHook(() => useRoleRailItems([{ roleId: 'revoked-shared-role', engine }], 'another-home'));

        expect(hook.getCurrent()).toEqual([expect.objectContaining({ roleId: 'revoked-shared-role', unavailable: 'role' })]);
    });

    it('does not offer a role that was turned off, and says when a role names an engine this Account has not enabled', async () => {
        const base = { instructions: 'Review this work', runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off' } as const;
        const hook = await renderHook(() => useRoleRailItems([
            { roleId: 'workflow:elsewhere', name: 'Elsewhere', ...base,
                engine: { agentTargetKey: 'backend:not-enabled:configured:not-enabled' } },
            { roleId: 'workflow:here', name: 'Here', ...base, engine },
        ], 'focused-home', { overrides: {}, notes: '', sessionRoles: {
            'session:off': { roleId: 'session:off', name: 'Turned off', ...base, enabled: false },
        } }));
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });

        const items = hook.getCurrent();
        expect(items.map(item => item.roleId)).toEqual(['workflow:elsewhere', 'workflow:here']);
        expect(items[0]?.unavailable).toBe('engine');
        expect(items[1]?.unavailable).toBeUndefined();
    });
    it('keeps an unavailable role in the rail grid with its reason and way out, never as an ordinary choice', async () => {
        const onManageRoles = vi.fn();
        const screen = await renderScreen(<RolesRailDetailView value={null} onChange={() => {}} onManageRoles={onManageRoles} roles={[
            { roleId: 'ok', name: 'Ready', purpose: 'Ready to use' },
            { roleId: 'elsewhere', name: 'Elsewhere', purpose: 'Pinned to another agent', engineLabel: 'Other agent', unavailable: 'engine' },
            { roleId: 'gone', name: 'Gone', purpose: '', unavailable: 'role' },
        ]} />);
        const options = screen.findAll(node => Array.isArray(node.props?.options) && node.props.options.some((option: { value: string }) => option.value === 'gone'))[0]!
            .props.options as ReadonlyArray<{ value: string; description: string; disabled?: boolean; onActivate?: () => void }>;
        const byValue = new Map(options.map(option => [option.value, option]));

        expect(byValue.get('ok')).toEqual(expect.not.objectContaining({ disabled: true }));
        expect(byValue.get('gone')).toMatchObject({ disabled: true });
        expect(byValue.get('gone')?.description).toContain(t('roles.rail.unavailableRole'));
        expect(byValue.get('elsewhere')?.description).toContain(t('roles.rail.chooseEngine'));
        byValue.get('elsewhere')?.onActivate?.();
        expect(onManageRoles).toHaveBeenCalledTimes(1);
    });
});
