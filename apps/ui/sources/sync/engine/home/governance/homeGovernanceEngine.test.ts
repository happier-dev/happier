import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NO_HOME_CAPABILITIES_V1,
    type HomeGovernanceProjectionV1,
} from '@happier-dev/protocol/home/governance';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/system/runtimeFetch')>();
    return {
        ...actual,
        runtimeFetch: async (input: Parameters<typeof actual.runtimeFetch>[0], init?: RequestInit) => {
            if (new URL(String(input)).pathname === '/v1/auth/ping') return Response.json({});
            return await runtimeFetchMock({ url: input, init });
        },
    };
});

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveHomeGovernanceViewState } from '@/components/settings/home/governance/homeGovernanceViewState';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getHomeGovernanceSnapshot,
    resetHomeGovernanceSnapshotsForTests,
} from '@/sync/store/home/governance/homeGovernanceSnapshots';

import {
    observeHomeGovernance,
    refreshHomeGovernanceSnapshot,
    resetHomeGovernanceEngineForTests,
} from './homeGovernanceEngine';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function projection(activeOwnerCount = 1): HomeGovernanceProjectionV1 {
    return {
        viewer: { accountId: 'account', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        policy: {
            revision: 3,
            teamCreationPolicy: 'managed_only',
            authentication: { status: 'inherited' },
        },
        authenticationOptions: {
            methods: [],
            permittedAccountModes: ['e2ee'],
            recommendedProvisioningMode: 'e2ee',
            signInService: { deploymentMode: null, canDisable: false },
        },
        setupState: 'owned',
        activeOwnerCount,
        teamsEnabled: true,
    };
}

async function addHome(name: string, serverUrl: string): Promise<string> {
    return (await upsertServerProfile({ serverUrl, name })).id;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

function governanceCallCount(host: string): number {
    return runtimeFetchMock.mock.calls
        .filter(([input]) => String(input?.url ?? '').startsWith(host))
        .length;
}

beforeEach(() => {
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
    resetHomeGovernanceSnapshotsForTests();
    resetHomeGovernanceEngineForTests();
});

afterEach(() => {
    resetHomeGovernanceEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    vi.clearAllMocks();
});

describe('homeGovernanceEngine', () => {
    it('loads the projection for a newly observed Home and publishes it under that exact scope', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready');
        });

        expect(getHomeGovernanceSnapshot(scope)?.data).toEqual(projection());
        expect(getHomeGovernanceSnapshot(scope)?.stale).toBe(false);
        release();
    });

    it('coalesces concurrent observations of one scope into a single load', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(homeA, 'account')!;

        const releaseFirst = observeHomeGovernance(scope);
        const releaseSecond = observeHomeGovernance(scope);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready');
        });

        expect(governanceCallCount('https://home-a.example')).toBe(1);
        releaseFirst();
        releaseSecond();
    });

    it('refetches only the woken Home and leaves another Home untouched', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        const homeB = await addHome('Home B', 'https://home-b.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scopeA = createServerAccountScope(homeA, 'account')!;
        const scopeB = createServerAccountScope(homeB, 'account')!;

        const releaseA = observeHomeGovernance(scopeA);
        const releaseB = observeHomeGovernance(scopeB);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scopeA)?.status).toBe('ready');
            expect(getHomeGovernanceSnapshot(scopeB)?.status).toBe('ready');
        });
        const callsToBBeforeWake = governanceCallCount('https://home-b.example');

        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection(2)));
        publishHomeAccountChange(homeA);

        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scopeA)?.data?.activeOwnerCount).toBe(2);
        });
        expect(governanceCallCount('https://home-b.example')).toBe(callsToBBeforeWake);
        releaseA();
        releaseB();
    });

    it('refetches administration when the focused viewer Account role or status changes', async () => {
        const home = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection(1)));
        const scope = createServerAccountScope(home, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(governanceCallCount('https://home-a.example')).toBe(1));
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection(2)));
        publishHomeAccountChange(home, ['self']);

        await vi.waitFor(() => {
            expect(governanceCallCount('https://home-a.example')).toBe(2);
            expect(getHomeGovernanceSnapshot(scope)?.data?.activeOwnerCount).toBe(2);
        });
        release();
    });

    it('does not refetch administration for an exact change page that touches nothing it shows', async () => {
        const home = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection(1)));
        const scope = createServerAccountScope(home, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(governanceCallCount('https://home-a.example')).toBe(1));
        publishHomeAccountChange(home, ['session-1', 'machine-1']);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(governanceCallCount('https://home-a.example')).toBe(1);

        publishHomeAccountChange(home, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.waitFor(() => expect(governanceCallCount('https://home-a.example')).toBe(2));
        release();
    });

    it('does not lose a wake that arrives while its own load is still in flight', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;

        // The first read is opened before the mutation commits, so its answer
        // cannot contain the change.
        let releaseFirstResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                releaseFirstResponse = resolve;
            });
            return jsonResponse(projection(1));
        });
        let releaseTrailingResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                releaseTrailingResponse = resolve;
            });
            return jsonResponse(projection(2));
        });

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(releaseFirstResponse).not.toBeNull());

        // The Home commits a role change and wakes us mid-flight.
        publishHomeAccountChange(homeA);
        releaseFirstResponse!();

        await vi.waitFor(() => expect(releaseTrailingResponse).not.toBeNull());
        const interim = getHomeGovernanceSnapshot(scope);
        expect(interim?.data?.activeOwnerCount).toBe(1);
        expect(interim?.stale).toBe(true);
        expect(resolveHomeGovernanceViewState(interim).kind).toBe('ready');
        expect(resolveHomeGovernanceViewState(interim)).toMatchObject({
            mutationsAvailable: true, updating: true, stale: true, readFailed: false,
        });

        releaseTrailingResponse!();

        // The pre-mutation answer must not be published as fresh and final.
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.data?.activeOwnerCount).toBe(2);
        });
        expect(getHomeGovernanceSnapshot(scope)?.stale).toBe(false);
        release();
    });

    it('coalesces several wakes during one in-flight load into a single trailing reload', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;

        let releaseFirstResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                releaseFirstResponse = resolve;
            });
            return jsonResponse(projection(1));
        });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection(2)));

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(releaseFirstResponse).not.toBeNull());

        publishHomeAccountChange(homeA);
        publishHomeAccountChange(homeA);
        publishHomeAccountChange(homeA);
        releaseFirstResponse!();

        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.data?.activeOwnerCount).toBe(2);
        });
        // One opening read plus exactly one trailing reload, not one per wake.
        expect(governanceCallCount('https://home-a.example')).toBe(2);
        release();
    });

    it('retains an unobserved wake as staleness and refreshes on the next observer', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready');
        });
        release();
        const callsAfterRelease = governanceCallCount('https://home-a.example');

        publishHomeAccountChange(homeA);
        await Promise.resolve();

        expect(governanceCallCount('https://home-a.example')).toBe(callsAfterRelease);

        let releaseRemountResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                releaseRemountResponse = resolve;
            });
            return jsonResponse(projection(2));
        });
        const releaseAgain = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(releaseRemountResponse).not.toBeNull());
        const interim = getHomeGovernanceSnapshot(scope);
        expect(interim?.data?.activeOwnerCount).toBe(1);
        expect(interim?.stale).toBe(true);
        expect(resolveHomeGovernanceViewState(interim)).toMatchObject({
            mutationsAvailable: true, updating: true, stale: true, readFailed: false,
        });

        releaseRemountResponse!();
        await vi.waitFor(() => {
            expect(governanceCallCount('https://home-a.example')).toBe(callsAfterRelease + 1);
            expect(getHomeGovernanceSnapshot(scope)?.data?.activeOwnerCount).toBe(2);
            expect(getHomeGovernanceSnapshot(scope)?.stale).toBe(false);
        });
        releaseAgain();
    });

    it('keeps the last projection visible and marks it stale when a refresh fails', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready');
        });

        runtimeFetchMock.mockRejectedValue(new Error('network down'));
        await refreshHomeGovernanceSnapshot(scope);

        const snapshot = getHomeGovernanceSnapshot(scope);
        expect(snapshot?.status).toBe('error');
        // The surface keeps rendering the last truth rather than flashing empty.
        expect(snapshot?.data).toEqual(projection());
        expect(snapshot?.stale).toBe(true);
        expect(snapshot?.error).toEqual({ kind: 'unreachable', retryable: true, code: null });
        expect(resolveHomeGovernanceViewState(snapshot)).toMatchObject({ mutationsAvailable: false });
        release();
    });

    /**
     * The governance read is parsed by the strict schema the canonical Action row
     * declares, so a Home that answers 200 with a shape outside that contract is a
     * failed read — not a projection. Proving it at the outcome keeps the real
     * parser in the path: a payload that only differs by one leaked administrative
     * field must not reach the store, and the last good projection must survive as
     * explicitly stale rather than being withdrawn or replaced.
     */
    it('rejects an off-contract governance answer and retains the last projection as stale', async () => {
        const home = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(home, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready'));

        runtimeFetchMock.mockImplementation(async () => jsonResponse({
            ...projection(2),
            serverInternalOwnerEmails: ['owner@example.test'],
        }));
        await refreshHomeGovernanceSnapshot(scope);

        expect(getHomeGovernanceSnapshot(scope)).toMatchObject({
            status: 'error',
            // The pre-failure truth stays on screen instead of flashing empty,
            // and it is marked stale so mutations stay unavailable.
            data: projection(),
            stale: true,
            reachability: 'reachable',
            error: { kind: 'invalid', retryable: false },
        });
        expect(resolveHomeGovernanceViewState(getHomeGovernanceSnapshot(scope)))
            .toMatchObject({ mutationsAvailable: false });
        release();
    });

    it('withdraws a retained administration projection when the Home requires owner setup', async () => {
        const home = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(home, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready'));

        runtimeFetchMock.mockImplementation(async () => jsonResponse(
            { error: 'home_governance_setup_required' },
            409,
        ));
        await refreshHomeGovernanceSnapshot(scope);

        expect(getHomeGovernanceSnapshot(scope)).toMatchObject({
            status: 'error',
            data: null,
            stale: false,
            error: {
                kind: 'forbidden',
                retryable: false,
                code: 'home_governance_setup_required',
            },
        });
        release();
    });

    it('records a Home without the operation as unsupported rather than as a denial', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response('', { status: 404 }));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.status).toBe('error');
        });

        expect(getHomeGovernanceSnapshot(scope)?.error).toEqual({
            kind: 'unsupported',
            retryable: false,
            code: null,
        });
        // An answering Home is reachable even when it lacks the operation.
        expect(getHomeGovernanceSnapshot(scope)?.reachability).toBe('reachable');
        release();
    });

    it('does not let one Account read another Account governance rows on the same Home', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => jsonResponse(projection()));
        const scope = createServerAccountScope(homeA, 'account')!;
        const otherScope = createServerAccountScope(homeA, 'other-account')!;

        const release = observeHomeGovernance(scope);
        await vi.waitFor(() => {
            expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready');
        });

        expect(getHomeGovernanceSnapshot(otherScope)).toBeNull();
        release();
    });
});
