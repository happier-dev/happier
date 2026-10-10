import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_TEAM_CAPABILITIES_V1, type TeamSummaryV1 } from '@happier-dev/protocol/teams';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreActionExecutor: (() => void) | undefined;

// Load the real runtime and Action graph outside per-test setup deadlines.
await loadSyncSingletonForTests();
const warmActionLoader = await installRealActionExecutorModuleLoader();
warmActionLoader();

/**
 * The mounted plugin front door and the Home family.
 *
 * Every `teams.*` / `home.governance.*` id is plugin-invocable, so a trusted
 * mounted plugin may ask for one. This file proves the mount's own Home and
 * Account carry that request to the Home it was admitted under, instead of the
 * whole family answering `unsupported_action` because the default executor was
 * built with no Home port.
 */

function team(id: string, name: string): TeamSummaryV1 {
    return {
        id,
        name,
        description: null,
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'member',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        counts: null,
    };
}

function request(facts: Readonly<{ pluginId: string; contributionId: string; surfaceId: string }>, payload: unknown) {
    return {
        version: 1,
        requestId: 'req:executeAction',
        surface: {
            pluginId: facts.pluginId,
            contributionId: facts.contributionId,
            surfaceId: facts.surfaceId,
            placement: 'browserSurface',
            platform: 'web',
            channel: 'internal',
            resourceScope: [],
            diagnostics: [],
        },
        method: 'executeAction',
        payload,
    } as never;
}

beforeEach(async () => {
    await harness.reset();
    await loadSyncSingletonForTests();
    restoreActionExecutor = await installRealActionExecutorModuleLoader();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
});

afterEach(async () => {
    await connection?.dispose();
    connection = null;
    restoreActionExecutor?.();
    restoreActionExecutor = undefined;
    await harness.reset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
    vi.clearAllMocks();
});

async function mountedSurface() {
    const serverId = await harness.addHome({
        serverUrl: 'https://home-plugin-front-door.example',
        name: 'Plugin Front Door Home',
        serverIdentityId: 'srv_plugin_front_door',
        accountId: 'account-1',
        teamsEnabled: true,
    });
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://home-plugin-front-door.example', accountId: 'account-1',
    });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    (await import('@/sync/domains/state/storage')).storage.setState({ profileScope: { serverId: scopeId, accountId: 'account-1' } });
    const accountLifetime = (await import('@/sync/domains/scope/activeServerAccountScope')).captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected the restored Home Account to be applied.');
    const facts = {
        pluginId: 'acme.browser',
        contributionId: 'panel',
        surfaceId: 'surfacePlacement:acme.browser:panel',
        placement: 'browserSurface',
        platform: 'web',
        channel: 'internal',
        machineId: 'machine_1',
        serverId: scopeId,
        projectionGeneration: 12,
        occurrenceId: 'browser-front-door-occurrence-12',
        executionOrigin: {
            serverIdentityId: 'srv_plugin_front_door',
            materializationRef: {
                machineId: 'machine_1',
                materializationId: 'materialization-current',
                pluginId: 'acme.browser',
            },
        },
        accountLifetime,
        interactionEnabled: true,
        daemonInteractionEnabled: true,
    } as const;
    return { facts, serverId };
}

describe('mounted plugin surface, Home family Actions', () => {
    it('carries a Home-family read to the exact Home the mount is bound to', async () => {
        const { facts, serverId } = await mountedSurface();
        harness.answer(serverId, '/v1/teams/list', { body: { items: [team('t1', 'Acme')], nextCursor: null } });
        const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
        const controller = createBoundPluginSurfaceController({ facts });

        const answer = await controller.hostApi.handleRequest(request(facts, {
            action: 'teams.list',
            input: { v: 1, scope: 'member', archived: 'active', limit: 20 },
        }));

        expect(answer).toEqual({ items: [team('t1', 'Acme')], nextCursor: null });
        expect(harness.requestsFor('/v1/teams/list')).toMatchObject([{
            serverId, serverUrl: 'https://home-plugin-front-door.example',
            token: connection!.credentials.token,
        }]);
        expect(serverId).not.toBe('');
        controller.dispose();
    });

    it('refuses the same read once the mount is no longer current', async () => {
        const { facts } = await mountedSurface();
        const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
        const controller = createBoundPluginSurfaceController({ facts });
        await connection!.dispose();
        connection = null;

        // A retired mount refuses synchronously, so the answer is awaited rather
        // than asserted as a promise.
        expect(await controller.hostApi.handleRequest(request(facts, {
            action: 'teams.list',
            input: { v: 1, scope: 'member', archived: 'active', limit: 20 },
        }))).toMatchObject({ code: 'stale_surface' });
        expect(harness.requestsFor('/v1/teams/list')).toEqual([]);
        controller.dispose();
    });
});
