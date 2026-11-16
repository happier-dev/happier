import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import { createDeferred, createRenderCommitCounter, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { parseToken } from '@/utils/auth/parseToken';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { useManagedSessionDefaults } = await import('./useManagedSessionDefaults');
const defaultsEngine = await import('@/sync/engine/home/governance/homeSessionDefaultsEngine');
const defaultsStore = await import('@/sync/store/home/governance/homeSessionDefaultsSnapshots');
const agentTargetKey = 'agent:example.agent/example';
const path = '/v1/home/governance/get';

beforeEach(async () => {
    standardCleanup();
    defaultsEngine.resetHomeSessionDefaultsEngineForTests();
    defaultsStore.resetHomeSessionDefaultsSnapshotsForTests();
    await homes.reset();
});
afterEach(() => standardCleanup());

describe('personal managed Session defaults', () => {
    it('keeps creation ineligible until the first exact Home defaults read settles', async () => {
        const serverId = await homes.addHome({ name: 'Cold Home', serverUrl: 'https://cold-defaults.example', accountId: 'nora' });
        const response = createDeferred<{ body: { homeDefaults: null } }>();
        homes.answer(serverId, path, { select: () => response.promise });
        const hook = await renderHook(() => useManagedSessionDefaults({ serverId, teamId: null, agentTargetKey }));
        try {
            await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
            // New Session's existing readiness owner requires read.status === 'ready'.
            expect(hook.getCurrent().read).toMatchObject({ status: 'unavailable', reason: 'unobserved' });
            response.resolve({ body: { homeDefaults: null } });
            await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        } finally { response.resolve({ body: { homeDefaults: null } }); await hook.unmount(); }
    });

    it('loads member-readable Home defaults without Teams and follows only relevant pushed changes', async () => {
        const serverId = await homes.addHome({ name: 'Nora Home', serverUrl: 'https://personal-defaults.example', accountId: 'nora' });
        let mode = 'read-only';
        homes.answer(serverId, path, { select: input => {
            expect(input).toEqual({ projection: 'session_defaults' });
            return { body: { homeDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: mode } } } };
        } });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useManagedSessionDefaults({ serverId, teamId: null, agentTargetKey });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read).toMatchObject({ status: 'ready',
            defaults: { permissionMode: { value: 'read-only', source: 'home' } } }));
        const reads = homes.requestsFor(path).length;
        counter.reset();
        await act(async () => {
            defaultsStore.applyHomeSessionDefaultsProjection({ serverId, accountId: 'another-account' }, { homeDefaults: null }, true);
            defaultsStore.applyHomeSessionDefaultsProjection({ serverId: 'another-home', accountId: 'nora' }, { homeDefaults: null }, true);
            for (let i = 0; i < 20; i += 1) publishHomeAccountChange(serverId, [`machine-${i}`], { changeKinds: ['machine'] });
            publishHomeAccountChange('another-home', [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        expect(homes.requestsFor(path)).toHaveLength(reads);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        mode = 'yolo';
        await act(async () => publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().read).toMatchObject({ defaults: { permissionMode: { value: 'yolo', source: 'home' } } }));
        expect(homes.requestsFor(path)).toHaveLength(reads + 1);
        await hook.unmount();
        mode = 'read-only';
        await act(async () => publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        expect(homes.requestsFor(path)).toHaveLength(reads + 1);
        const returned = await renderHook(() => useManagedSessionDefaults({ serverId, teamId: null, agentTargetKey }));
        await waitForHomeGovernance(() => expect(returned.getCurrent().read).toMatchObject({ defaults: { permissionMode: { value: 'read-only' } } }));
        expect(homes.requestsFor(path)).toHaveLength(reads + 2);
        await returned.unmount();
    });

    it('retains offline defaults, withdraws refused defaults, and never reuses another Account projection', async () => {
        const serverId = await homes.addHome({ name: 'Shared Home', serverUrl: 'https://personal-scope.example', accountId: 'nora' });
        homes.answer(serverId, path, { body: { homeDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' } } } });
        const hook = await renderHook(() => useManagedSessionDefaults({ serverId, teamId: null, agentTargetKey,
            memberDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'safe-yolo' } } }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.context.homeDefaults).toBeTruthy());
        // Member defaults remain above Home defaults in the existing resolver.
        expect(hook.getCurrent().read).toMatchObject({ defaults: { permissionMode: { value: 'safe-yolo', source: 'member' } } });
        homes.answer(serverId, path, { status: 503, body: { error: 'unavailable' } });
        await act(async () => publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(defaultsStore.getHomeSessionDefaultsSnapshot({ serverId, accountId: 'nora' })?.error).toBeTruthy());
        expect(hook.getCurrent().read.context.homeDefaults).toBeTruthy();
        homes.answer(serverId, path, { status: 403, body: { error: 'home_governance_forbidden' } });
        await act(async () => publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.context.homeDefaults).toBeNull());
        expect(hook.getCurrent().read.status).toBe('ready');
        homes.answer(serverId, path, { body: { homeDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' } } } });
        await act(async () => publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.context.homeDefaults).toBeTruthy());
        homes.answer(serverId, path, { body: { homeDefaults: null } });
        await act(async () => homes.switchAccount(serverId, 'ellis'));
        await waitForHomeGovernance(() => expect(parseToken(homes.requestsFor(path).at(-1)?.token ?? '')).toBe('ellis'));
        expect(hook.getCurrent().read.context.homeDefaults).toBeNull();
        await hook.unmount();
    });
});
