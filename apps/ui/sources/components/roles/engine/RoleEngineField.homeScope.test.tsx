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
import { useRoleEnginePresentation } from '../catalog/useRoleEnginePresentation';
import { useRoleRailItems } from '../rail/useRoleRailItems';
import { RolesRailDetailView } from '../rail/RolesRailDetail';
import { t } from '@/text';
import { RoleEngineField } from './RoleEngineField';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

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
    storage.setState({ settingsScope: scope });
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({
        v: 1, definitions: [{
            id: 'focused-review', name: 'focused-review', title: 'Focused Review',
            description: 'Focused review', command: 'review-agent', args: [], env: {}, defaultMode: 'default', defaultModel: 'default',
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

        expect(hook.getCurrent()(engine)).toEqual({ label: 'stored-model · high', icon: null, unavailable: true });
        expect(hook.getCurrent()(undefined)).toEqual({ label: null, icon: null, unavailable: false });
    });

    it('keeps Account Settings while a Home-qualified presentation retires and reopens with its runtime', async () => {
        const settings = await renderHook(() => useRoleEnginePresentation());
        const session = await renderHook(() => useRoleEnginePresentation('focused-home'));
        expect(settings.getCurrent()(engine).label).toBe('Focused Review · stored-model · high');
        expect(session.getCurrent()(engine).unavailable).toBe(false);

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });

        expect(session.getCurrent()(engine)).toEqual({ label: 'stored-model · high', icon: null, unavailable: true });
        expect(settings.getCurrent()(engine).unavailable).toBe(false);

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        expect(session.getCurrent()(engine).label).toBe('Focused Review · stored-model · high');
        expect(session.getCurrent()(engine).unavailable).toBe(false);

        await act(async () => {
            publishAppliedActiveServerSnapshot({ serverId: 'another-home', serverUrl: 'https://another-home.test', generation: 2 });
        });
        expect(session.getCurrent()(engine)).toEqual({ label: 'stored-model · high', icon: null, unavailable: true });
        await act(async () => {
            publishAppliedActiveServerSnapshot({ serverId: 'focused-home', serverUrl: 'https://focused-home.test', generation: 3 });
        });
        expect(session.getCurrent()(engine).unavailable).toBe(false);
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
        const detail = options.find(option => option.label === 'Focused Review')!.renderDetailContent({ onRequestClose: () => {} });

        // The role's stored effort is the effort the picker shows as chosen.
        expect(detail.props.selectedConfigOverrides).toEqual({ reasoning_effort: 'high' });

        detail.props.onSelectionChange({ modelId: 'stored-model', sessionModeId: null, configOverrides: { reasoning_effort: 'low' } });
        expect(onChange).toHaveBeenLastCalledWith({ agentTargetKey: engine.agentTargetKey, modelId: 'stored-model', effort: 'low' });

        // A model the effort does not apply to clears it instead of keeping a stale one.
        detail.props.onSelectionChange({ modelId: 'other-model', sessionModeId: null, configOverrides: {} });
        expect(onChange).toHaveBeenLastCalledWith({ agentTargetKey: engine.agentTargetKey, modelId: 'other-model' });
    });

    it('keeps a role no layer can resolve in the rail as unavailable instead of dropping it', async () => {
        const hook = await renderHook(() => useRoleRailItems([{ roleId: 'revoked-shared-role', engine }], 'another-home'));

        expect(hook.getCurrent()).toEqual([expect.objectContaining({ roleId: 'revoked-shared-role', unavailable: 'role' })]);
    });

    it('does not offer a role that was turned off, and says when a role names an engine this Account has not enabled', async () => {
        const base = { instructions: 'Review this work', runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off' } as const;
        const hook = await renderHook(() => useRoleRailItems([
            { roleId: 'workflow:off', name: 'Turned off', ...base, enabled: false },
            { roleId: 'workflow:elsewhere', name: 'Elsewhere', ...base, enabled: true,
                engine: { agentTargetKey: 'backend:not-enabled:configured:not-enabled' } },
            { roleId: 'workflow:here', name: 'Here', ...base, enabled: true, engine },
        ], 'focused-home'));
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
