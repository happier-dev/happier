import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ProjectSourcesReadOutputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';

import { createDeferred, createRenderCommitCounter, renderHook, standardCleanup, teamPolicyFixture, teamSummaryFixture, useRenderCommitCounter } from '@/dev/testkit';
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

describe('managed Session Team context', () => {
    it.each([
        { name: 'explicit Team takes precedence', primaryTeamId: 'team-primary', sharedTeamIds: ['team-shared'], expected: 'team-primary' },
        { name: 'sole shared Team', primaryTeamId: null, sharedTeamIds: ['team-shared'], expected: 'team-shared' },
        { name: 'Team and Group from the same Team', primaryTeamId: null, sharedTeamIds: ['team-shared', 'team-shared'], expected: 'team-shared' },
        { name: 'ambiguous shared Teams use personal context', primaryTeamId: null, sharedTeamIds: ['team-a', 'team-b'], expected: null },
        { name: 'personal sharing uses personal context', primaryTeamId: null, sharedTeamIds: [], expected: null },
    ])('preserves $name', async ({ primaryTeamId, sharedTeamIds, expected }) => {
        const serverId = await homes.addHome({ name: 'Context Home', serverUrl: 'https://team-context.example', accountId: 'nora' });
        const access: SessionInitialAccessDraftV1 = { grants: [
            { subject: { kind: 'account', accountId: 'colleague' }, accessLevel: 'view', canApprovePermissions: false },
            ...sharedTeamIds.map((teamId, index): SessionInitialAccessDraftV1['grants'][number] => index === 0
                ? { subject: { kind: 'team', teamId }, accessLevel: 'view', canApprovePermissions: false }
                : { subject: { kind: 'group', teamId, groupId: `group-${index}` }, accessLevel: 'view', canApprovePermissions: false }),
        ] };
        homes.answer(serverId, path, { body: { homeDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' } } } });
        homes.answer(serverId, '/v1/teams/get', { select: input => {
            expect(input).toEqual({ v: 1, teamId: expected });
            return { body: teamSummaryFixture({ id: expected ?? 'unused', policy: teamPolicyFixture({
                managedDefaults: { team: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'yolo' } }, groups: {} },
            }) }) };
        } });
        const hook = await renderHook(() => useManagedSessionDefaults({ serverId, teamId: primaryTeamId, agentTargetKey, access }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().read).toMatchObject({ status: 'ready', defaults: {
                permissionMode: { value: expected ? 'yolo' : 'read-only', source: expected ? 'team' : 'home' },
            } }));
            expect(hook.getCurrent().read.context.primaryTeamId).toBe(expected);
            expect(homes.requestsFor('/v1/teams/get')).toHaveLength(expected ? 1 : 0);
            expect(homes.requestsFor(path)).toHaveLength(expected ? 0 : 1);
        } finally { await hook.unmount(); }
    });
});

describe('personal managed Session defaults', () => {
    it('retains equal Project refresh identities while publishing permission, context and defaults changes', async () => {
        const serverId = await homes.addHome({ name: 'Project Home', serverUrl: 'https://project-defaults.example', accountId: 'nora' });
        const sourcePath = 'GET /v1/projects/sources/source-app';
        let mode: 'read-only' | 'yolo' = 'read-only';
        let homeMode: 'read-only' | 'safe-yolo' = 'read-only';
        let canManageSessionDefaults = true;
        const sourceResponse = (): { body: ProjectSourcesReadOutputV1 } => ({ body: {
            ok: true, canManage: true, canManageSessionDefaults,
            source: { id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'nora' },
                audience: [], createdByAccountId: 'nora' },
            sessionDefaults: { revision: 1, defaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: mode } } },
        } });
        let pending: ReturnType<typeof createDeferred<{ body: ProjectSourcesReadOutputV1 }>> | null = null;
        homes.answer(serverId, sourcePath, { select: () => pending?.promise ?? sourceResponse() });
        homes.answer(serverId, path, { select: () => ({ body: {
            homeDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: homeMode } },
        } }) });
        const projectContext = { sourceRef: { serverId, sourceId: 'source-app' } };
        const hook = await renderHook(() => {
            const managed = useManagedSessionDefaults({ serverId, teamId: null, agentTargetKey, projectContext });
            const downstream = React.useMemo(() => ({ read: managed.read }), [managed.read]);
            return { ...managed, downstream };
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().projectRead.status).toBe('ready'));
            const first = hook.getCurrent();
            expect(first.read).toMatchObject({ status: 'ready', defaults: { permissionMode: { value: 'read-only', source: 'project' } } });
            pending = createDeferred();
            await act(async () => publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]));
            await waitForHomeGovernance(() => expect(hook.getCurrent().projectRead.status).toBe('refreshing'));
            expect(hook.getCurrent().projectRead.data).toBe(first.projectRead.data);
            await act(async () => { pending?.resolve(sourceResponse()); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().projectRead.status).toBe('ready'));
            expect(hook.getCurrent().projectRead.data).toBe(first.projectRead.data);
            expect(hook.getCurrent().projectRead.data?.context).toBe(first.projectRead.data?.context);
            expect(hook.getCurrent().read).toBe(first.read);
            expect(hook.getCurrent().downstream).toBe(first.downstream);
            pending = null;

            canManageSessionDefaults = false;
            await act(async () => { await hook.getCurrent().projectRead.refresh(); });
            const permissionChanged = hook.getCurrent();
            expect(permissionChanged.projectRead.data).not.toBe(first.projectRead.data);
            expect(permissionChanged.projectRead.data?.canManageSource).toBe(false);
            expect(permissionChanged.projectRead.data?.context).toBe(first.projectRead.data?.context);

            homeMode = 'safe-yolo';
            await act(async () => { await hook.getCurrent().projectRead.refresh(); });
            const contextChanged = hook.getCurrent();
            expect(contextChanged.projectRead.data?.context).not.toBe(permissionChanged.projectRead.data?.context);
            expect(contextChanged.read.context.homeDefaults?.permissionModeByAgentTargetKey?.[agentTargetKey]).toBe('safe-yolo');
            expect(contextChanged.read).toMatchObject({ defaults: { permissionMode: { value: 'read-only', source: 'project' } } });
            expect(contextChanged.downstream).not.toBe(permissionChanged.downstream);

            mode = 'yolo';
            await act(async () => { await hook.getCurrent().projectRead.refresh(); });
            expect(hook.getCurrent().read).toMatchObject({ defaults: { permissionMode: { value: 'yolo', source: 'project' } } });
            expect(hook.getCurrent().downstream).not.toBe(contextChanged.downstream);
        } finally { pending?.resolve(sourceResponse()); await hook.unmount(); }
    });

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
