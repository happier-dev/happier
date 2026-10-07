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
import { RoleEngineField } from './RoleEngineField';

const engine = { agentTargetKey: 'backend:focused-review:configured:focused-review', modelId: 'stored-model', effort: 'high' } as const;
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

beforeEach(() => {
    previousState = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.getState().activateProfileScope({ serverId: 'focused-home', accountId: 'focused-account' });
    publishAppliedActiveServerSnapshot({ serverId: 'focused-home', serverUrl: 'https://focused-home.test', generation: 1 });
    storage.setState({ settings: {
        ...storage.getState().settings,
        acpCatalogSettingsV1: { v: 2, backends: [{
            id: 'focused-review', name: 'focused-review', title: 'Focused Review',
            description: '', command: 'review-agent', args: [], env: {}, defaultMode: '', defaultModel: '',
            capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
            createdAt: 1, updatedAt: 1,
        }] },
        backendEnabledByTargetKey: { [engine.agentTargetKey]: true },
    } });
});

afterEach(() => {
    standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.getState().clearProfileScope();
    storage.setState(previousState, true);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
});

describe('role engine exact Home qualification', () => {
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
        const hook = await renderHook(() => useRoleRailItems([{
            roleId: 'session:review', name: 'Session review', instructions: 'Review this work',
            runsAs: { kind: 'session' }, engine,
        }], 'another-home'));

        expect(hook.getCurrent()).toEqual([expect.objectContaining({
            roleId: 'session:review', name: 'Session review', engineLabel: 'stored-model · high',
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
});
