import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createCollaborationSessionRecord, createSessionCollaborationHttpBoundary } from '@/dev/testkit/harness/sessionCollaborationNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { createDeferred, createSessionListRenderableSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getServerProfileById, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { SessionCollaborationSurface } from './SessionCollaborationSurface';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { publishSessionCollaborationIntent, resetSessionCollaborationIntentsForTests } from './sessionCollaborationIntent';
import { t } from '@/text';

const publicationModal = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
    show: vi.fn(), update: vi.fn(), hide: vi.fn(),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true, spies: publicationModal }).module;
});

const credentials = vi.hoisted(() => ({ serverId: '', accountId: 'collaboration-account', unreadable: false }));
/** Every request this surface issues, captured at the one runtime transport boundary. */
const transport = vi.hoisted(() => ({
    requests: [] as Array<Readonly<{ origin: string; path: string; method: string; authorization: string | null }>>,
    publicationReachable: true,
}));
const nativeFocus = vi.hoisted(() => ({
    findNodeHandle: vi.fn<(target: unknown) => number | null>(() => null),
    setAccessibilityFocus: vi.fn(),
}));
/** The live URL this surface is mounted under, so a consumed query key is observable. */
const route = vi.hoisted(() => ({
    params: {} as Record<string, string | string[] | undefined>,
    setParams: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
    readParams: (() => ({})) as () => Record<string, string | string[] | undefined>,
    applyParams: ((_params: Record<string, string | string[] | undefined>) => undefined) as (params: Record<string, string | string[] | undefined>) => void,
    resetParams: (() => undefined) as () => void,
}));

// The canonical router factory over the repository's own expo-router stub: the
// surface reads route state through it and writes back through the navigation owner.
vi.mock('expo-router', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({
        params: () => route.params,
        router: { setParams: route.setParams, replace: route.replace, push: route.push },
    });
    route.readParams = () => mock.state.params;
    route.applyParams = (params) => { mock.state.router.setParams(params); };
    route.resetParams = mock.resetParams;
    return { ...original, ...mock.module };
});

// Window geometry is the platform boundary that selects the responsive host, and
// the shared native runtime reports an 800x600 window whose 600pt minimum edge is
// exactly the canonical tablet breakpoint. This file is the compact iOS phone
// host, so it supplies real phone geometry through the same canonical factory and
// lets the real `useIsTablet`/`determineDeviceType` owner choose the pushed
// Responsibility step rather than the anchored popover.
const phoneWindow = vi.hoisted(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        ...createCapturingFlatListMock({ renderItems: true }).module,
        findNodeHandle: nativeFocus.findNodeHandle,
        AccessibilityInfo: { setAccessibilityFocus: nativeFocus.setAccessibilityFocus },
        Dimensions: { get: () => ({ ...phoneWindow }) },
        useWindowDimensions: () => ({ ...phoneWindow }),
    });
});

// The recycler is a platform boundary: its real implementation schedules on
// `requestAnimationFrame`, which this native runner does not provide, so the
// canonical testkit recycler stands in while every list, selection and
// pagination decision above it stays real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return createCapturingLegendListMock({ original, renderItems: true, renderItemLimit: 20 }).module;
});

/** The persisted credential this Home would hand to the transport, Account subject included. */
function credentialTokenFor(accountId: string): string {
    return `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature`;
}

// Device credential storage is the boundary; scope resolution and Session projections remain real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (_url, options) => {
                // An unreadable device store surfaces only to readers that asked to see it,
                // exactly as the real owner does (serverCredentialAccountScope.test.ts).
                if (credentials.unreadable && options?.serverId === credentials.serverId) {
                    if (options.storageReadFailure === 'surface') throw new Error('secure_storage_unavailable');
                    return null;
                }
                return options?.serverId === credentials.serverId ? {
                    token: `header.${Buffer.from(JSON.stringify({ sub: credentials.accountId })).toString('base64')}.signature`,
                } : null;
            },
        },
    });
});

afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
    resetServerFeaturesClientForTests();
    resetSessionCollaborationIntentsForTests();
    resetRuntimeFetch();
    vi.clearAllMocks();
    nativeFocus.findNodeHandle.mockReset();
    nativeFocus.setAccessibilityFocus.mockReset();
});

let network = createSessionCollaborationHttpBoundary();
const homes = new Map<string, ReturnType<typeof network.addHome>>();

function homeFor(serverId: string) {
    const existing = homes.get(serverId);
    if (existing) return existing;
    const profile = getServerProfileById(serverId);
    if (!profile) throw new Error(`Unknown Collaboration fixture Home: ${serverId}`);
    const home = network.addHome(profile.serverUrl, credentials.accountId);
    homes.set(serverId, home);
    return home;
}

function serveSession(serverId: string, capabilities: Parameters<typeof createSessionAccessFixture>[1] = {}) {
    const record = createCollaborationSessionRecord('same-id', {
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: createSessionAccessFixture('owner', capabilities).capabilities },
    });
    homeFor(serverId).sessions.set(record.id, record);
    return record;
}

function snapshotRequests(serverId: string) {
    const origin = new URL(getServerProfileById(serverId)!.serverUrl).origin;
    return network.requests.filter((request) => request.url.origin === origin && request.path === '/v2/sessions/same-id');
}

beforeEach(async () => {
    network = createSessionCollaborationHttpBoundary();
    homes.clear();
    publicationModal.show.mockReset().mockReturnValue('public-link-dialog');
    publicationModal.confirm.mockReset().mockResolvedValue(true);
    publicationModal.update.mockReset();
    publicationModal.hide.mockReset();
    transport.requests.length = 0;
    transport.publicationReachable = true;
    credentials.unreadable = false;
    route.params = {};
    // This module-level router mock outlives the whole file, and the consumed
    // `collaborationFocus` key each test writes back is an override that would
    // otherwise mask the same key the next test supplies through `params`.
    route.resetParams();
    route.setParams.mockClear();
    route.replace.mockClear();
    route.push.mockClear();
    // HTTP is the one replaced boundary: the mounted surface, its controllers,
    // scope resolution and the released publication projection stay real, so a
    // request can only reach the Home this surface actually bound itself to.
    setRuntimeFetch(async (url, init) => {
        const parsed = new URL(String(url));
        transport.requests.push({
            origin: parsed.origin,
            path: parsed.pathname,
            method: init?.method ?? 'GET',
            authorization: new Headers(init?.headers).get('Authorization'),
        });
        if (parsed.pathname === '/v1/auth/ping') return new Response('{}');
        if (parsed.pathname.endsWith('/public-share') && !transport.publicationReachable) return new Response('{}', { status: 503 });
        const authorization = new Headers(init?.headers).get('Authorization');
        const tokenPayload = authorization?.startsWith('Bearer ') ? authorization.slice(7).split('.')[1] : undefined;
        let accountId: string | null = null;
        if (tokenPayload) {
            const payload: unknown = JSON.parse(Buffer.from(tokenPayload, 'base64url').toString('utf8'));
            if (payload && typeof payload === 'object' && 'sub' in payload && typeof payload.sub === 'string') accountId = payload.sub;
        }
        return await network.route({ url: parsed, path: parsed.pathname, method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, accountId })
            ?? new Response('{}', { status: 404 });
    });
    // The app entry installs this real facade; the discussion owner reaches it
    // to resolve its Session runtime before issuing the actual HTTP read.
    await loadSyncSingletonForTests();
});

type CollaborationFeatureId = 'sharing.session' | 'sharing.public' | 'sessions.conversations';

async function publishFeatures(
    serverId: string,
    enabled: readonly CollaborationFeatureId[],
    disabled: readonly CollaborationFeatureId[] = [],
): Promise<void> {
    const features = homeFor(serverId).features;
    for (const feature of enabled) {
        if (!tryWriteServerEnabledBitInPlace(features, feature, true)) throw new Error(`Unable to enable ${feature}`);
    }
    for (const feature of disabled) {
        if (!tryWriteServerEnabledBitInPlace(features, feature, false)) throw new Error(`Unable to disable ${feature}`);
    }
    const snapshot = await getServerFeaturesSnapshot({ serverId, force: true });
    expect(snapshot.status).toBe('ready');
}

async function publishCollaboration(serverId: string): Promise<void> {
    await publishFeatures(serverId, ['sharing.session', 'sharing.public', 'sessions.conversations']);
}

describe('SessionCollaborationSurface', () => {
    it('retains an issued public link across transient snapshot failure without allowing stale mutations', async () => {
        const profile = await upsertServerProfile({ name: 'Snapshot recovery Home', serverUrl: 'https://snapshot-recovery.example.test' });
        credentials.serverId = profile.id;
        await publishFeatures(profile.id, ['sharing.public'], ['sharing.session', 'sessions.conversations']);
        serveSession(profile.id);
        const home = homeFor(profile.id);
        let publicShare: Record<string, unknown> | null = null;
        const writes: string[] = [];
        home.publicationResponse = (request) => {
            if (request.path === '/v1/public-shares' && request.method === 'POST') {
                writes.push('create');
                publicShare = { id: 'publication', expiresAt: null, maxUses: null, useCount: 0,
                    isConsentRequired: true, updatedAt: 1, keyDerivation: 'fragment_v1' };
                return new Response(JSON.stringify({ publicShare, isolatedOrigin: 'https://public-viewer.example.test' }));
            }
            if (request.path.endsWith('/public-share')) {
                if (request.method === 'DELETE') writes.push('delete');
                return new Response(JSON.stringify({ publicShare, isolatedOrigin: 'https://public-viewer.example.test' }));
            }
            return undefined;
        };
        const invalidate = async (seq: number) => act(async () => {
            storage.setState((state) => ({ sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [profile.id]: { 'same-id': createSessionListRenderableSessionFixture({ id: 'same-id', seq, updatedAt: seq }) },
            } }));
        });
        publishSessionCollaborationIntent({ serverId: profile.id, sessionId: 'same-id' }, 'publicLink');
        const screen = await renderScreen(<AppPaneProvider>
            <SessionCollaborationSurface target={{ serverId: profile.id, sessionId: 'same-id' }} />
        </AppPaneProvider>);
        await vi.waitFor(() => expect(snapshotRequests(profile.id).length).toBeGreaterThan(0));
        // The link itself lives in the Share panel; there is no separate publication dialog.
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-create')).not.toBeNull());
        await screen.pressByTestIdAsync('session-public-link-create');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-options')).not.toBeNull());
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-url')).not.toBeNull());
        const shownUrl = () => String(screen.findByTestId('session-public-link-url')?.props.children);
        const issuedUrl = shownUrl();
        expect(issuedUrl).toMatch(/^https:\/\/public-viewer\.example\.test\/s\/[^#]+#k=.+$/);
        expect(writes).toEqual(['create']);
        expect(publicationModal.show).not.toHaveBeenCalled();

        home.snapshotResponse = () => { throw new Error('offline'); };
        await invalidate(2);
        await vi.waitFor(() => expect(screen.findByTestId('session-external-sharing-retry')).not.toBeNull());
        // Continuity: the issued link stays readable, but nothing can change it on stale authority.
        expect(shownUrl()).toBe(issuedUrl);
        expect(screen.findHostByTestId('session-public-link-turn-off')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(screen.findHostByTestId('session-public-link-new')?.props.accessibilityState).toMatchObject({ disabled: true });
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        expect(writes).toEqual(['create']);

        home.snapshotResponse = undefined;
        await screen.pressByTestIdAsync('session-external-sharing-retry');
        await vi.waitFor(() => expect(screen.findByTestId('session-external-sharing-retry')).toBeNull());
        await vi.waitFor(() => expect(screen.findHostByTestId('session-public-link-turn-off')?.props.accessibilityState).toMatchObject({ disabled: false }));
        expect(shownUrl()).toBe(issuedUrl);

        home.snapshotResponse = () => Response.json({ error: 'forbidden' }, { status: 403 });
        await invalidate(3);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-url')).toBeNull());
        expect(writes).toEqual(['create']);
    });

    it('asks before turning the public link off and removes it through the publication owner', async () => {
        const profile = await upsertServerProfile({ name: 'Turn off Home', serverUrl: 'https://collaboration-turn-off.example.test' });
        credentials.serverId = profile.id;
        await publishFeatures(profile.id, ['sharing.public'], ['sharing.session', 'sessions.conversations']);
        serveSession(profile.id);
        let publicShare: Record<string, unknown> | null = { id: 'publication', expiresAt: null, maxUses: 10, useCount: 3, isConsentRequired: true, updatedAt: 1 };
        const writes: string[] = [];
        homeFor(profile.id).publicationResponse = (request) => {
            if (request.path.endsWith('/public-share')) {
                if (request.method === 'DELETE') { writes.push('delete'); publicShare = null; }
                return new Response(JSON.stringify({ publicShare }));
            }
            return undefined;
        };
        publishSessionCollaborationIntent({ serverId: profile.id, sessionId: 'same-id' }, 'publicLink');
        const screen = await renderScreen(<AppPaneProvider>
            <SessionCollaborationSurface target={{ serverId: profile.id, sessionId: 'same-id' }} />
        </AppPaneProvider>);
        // A link made earlier cannot be shown again; the card says so and still offers its controls.
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-hidden')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.linkGrants'));

        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await vi.waitFor(() => expect(publicationModal.confirm).toHaveBeenCalled());
        await vi.waitFor(() => expect(writes).toEqual(['delete']));
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-create')).not.toBeNull());
    });

    it('presents an unreadable device credential store as unavailable, never as signed out', async () => {
        const profile = await upsertServerProfile({ name: 'Unreadable Home', serverUrl: 'https://collaboration-unreadable.example.test' });
        await publishCollaboration(profile.id);
        credentials.serverId = profile.id;
        credentials.unreadable = true;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: profile.id, sessionId: 'unreadable-session' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-home-unavailable')).not.toBeNull());
        expect(screen.findByTestId('session-collaboration-signed-out')).toBeNull();
        expect(network.requests.some((request) => request.path.startsWith('/v2/sessions/'))).toBe(false);
    });

    it('hydrates publication from the exact inactive Home when the active Home has the same raw Session id', async () => {
        const active = await upsertServerProfile({ name: 'Active Home', serverUrl: 'https://collaboration-active-other.example.test' });
        const profile = await upsertServerProfile({ name: 'Collaboration test Home', serverUrl: 'https://collaboration-inactive.example.test' });
        await publishCollaboration(profile.id);
        credentials.serverId = profile.id;
        serveSession(profile.id);
        const rows = {};
        const index: SessionListIndexItem[] = [];
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: 'active-account' },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', serverId: active.id, metadata: null,
                    currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [profile.id]: rows },
            sessionListIndexByServerId: { ...state.sessionListIndexByServerId, [profile.id]: index },
        }));
        publishSessionCollaborationIntent({ serverId: profile.id, sessionId: 'same-id' }, 'access');

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: profile.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull());
        expect(storage.getState().sessionListRowsByServerId[profile.id]).toBe(rows);
        expect(storage.getState().sessionListIndexByServerId[profile.id]).toBe(index);
        await vi.waitFor(() => expect(snapshotRequests(profile.id).length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration:session-access-public-link')).not.toBeNull());
        expect(screen.findByTestId('session-public-link-card')).toBeNull();
        await screen.pressByTestIdAsync('session-access-editor:collaboration:session-access-public-link');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-card')).not.toBeNull());
        expect(snapshotRequests(profile.id).every((request) => request.accountId === credentials.accountId)).toBe(true);
        // Publication is read from the bound inactive Home with that Home's own
        // credential, never from whichever Home happens to be active.
        const publicationRequests = transport.requests.filter((request) => request.path.endsWith('/public-share'));
        expect(publicationRequests).not.toHaveLength(0);
        for (const request of publicationRequests) {
            expect(request.path).toBe('/v1/sessions/same-id/public-share');
            expect(request.origin).toBe('https://collaboration-inactive.example.test');
            expect(request.authorization).toContain(credentialTokenFor(credentials.accountId));
        }
        expect(transport.requests.some((request) => request.origin === 'https://collaboration-active-other.example.test')).toBe(false);
        expect(active.id).not.toBe(profile.id);
    });

    it('composes publication as an independently failing sibling of the one flexing access body', async () => {
        const active = await upsertServerProfile({ name: 'Collaboration active Home', serverUrl: 'https://collaboration-active.example.test' });
        credentials.serverId = active.id;
        // Named access plus publication with Conversations off: Public link is
        // still its own sibling inside the Share panel.
        await publishFeatures(active.id, ['sharing.session', 'sharing.public'], ['sessions.conversations']);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: true } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id);
        transport.publicationReachable = false;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        // The access card at the pane's foot grows into the Share panel.
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-access-card')).not.toBeNull());
        await screen.pressByTestIdAsync('session-collaboration-access-card');
        // One access editor, mounted as the panel's only vertical scroll owner.
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull());
        // Publication is a sibling section with its own failure boundary: an
        // unreachable publication read shows a section-local retry and leaves the
        // access body rendered.
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration:session-access-public-link')).not.toBeNull());
        await screen.pressByTestIdAsync('session-access-editor:collaboration:session-access-public-link');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-retry')).not.toBeNull());
        expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull();
        expect(screen.findByTestId('session-collaboration-access-body')?.props.style).toMatchObject({ flex: 1, minHeight: 0 });
    });

    it('opens conversations-first: the present line, one Responsible row, the conversations, and the access card at the foot', async () => {
        const active = await upsertServerProfile({ name: 'Conversations first Home', serverUrl: 'https://collaboration-conversations-first.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        const session = createSessionFixture({
            id: 'same-id', serverId: active.id, currentStorageState: 'hosted', transcriptShareable: true,
            responsibleAccountId: null, responsibleAccount: null,
            access: createSessionAccessFixture('owner', { managePublicLink: false, assignResponsibility: true }),
        });
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: { ...state.sessions, 'same-id': session },
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [active.id]: { 'same-id': session } as unknown as Record<string, SessionListRenderableSession>,
            },
        }));
        serveSession(active.id, { managePublicLink: false });

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-invite-action'), JSON.stringify({
            text: screen.getTextContent(), requests: network.requests.map(({ path, accountId }) => ({ path, accountId })),
        })).not.toBeNull());
        expect(screen.findByTestId('session-presence-section')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-row')).not.toBeNull());
        // User ruling 2026-09-29: who has access and Responsible are ONE block at the pane's foot;
        // the top holds only the present line and the conversations.
        const foot = screen.findByTestId('session-collaboration-foot');
        expect(foot?.findAll((node) => node.props.testID === 'session-collaboration-access-card').length).toBeGreaterThan(0);
        expect(foot?.findAll((node) => node.props.testID === 'session-responsibility-row').length).toBeGreaterThan(0);
        const column = screen.findByTestId('session-collaboration-main-column');
        const order = column?.findAll((node) => typeof node.props.testID === 'string'
            && ['session-presence-section', 'session-discussion-activity-list', 'session-collaboration-foot'].includes(node.props.testID as string)
            && typeof node.type === 'string').map((node) => node.props.testID);
        expect([...new Set(order)]).toEqual(['session-presence-section', 'session-discussion-activity-list', 'session-collaboration-foot']);
        // Access is set up once and conversations are used all day: no mode switch between them.
        expect(screen.findByTestId('session-collaboration-modes')).toBeNull();
        expect(screen.findByTestId('session-collaboration-mode:access')).toBeNull();
        // The access editor is not built until the card is pressed.
        expect(screen.findByTestId('session-access-editor:collaboration')).toBeNull();
    });

    it('lands a Responsible focus request on the Responsible row in the foot block', async () => {
        const active = await upsertServerProfile({ name: 'Responsible focus Home', serverUrl: 'https://collaboration-responsible-focus.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        const session = {
            id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
            responsibleAccountId: null, responsibleAccount: null,
            access: { capabilities: { managePublicLink: false, assignResponsibility: true } },
        } as unknown as Session;
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: { ...state.sessions, 'same-id': session },
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [active.id]: { 'same-id': session } as unknown as Record<string, SessionListRenderableSession>,
            },
        }));
        serveSession(active.id, { managePublicLink: false });
        const focused = vi.fn();
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
            {
                createNodeMock: (element) => {
                    const testID = (element as { props?: { testID?: string } }).props?.testID;
                    return { focus: () => focused(testID) };
                },
            },
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-row')).not.toBeNull());
        await act(async () => {
            publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'responsible');
        });
        await vi.waitFor(() => expect(focused).toHaveBeenCalledWith('session-collaboration-responsible-anchor'));
        const foot = screen.findByTestId('session-collaboration-foot');
        expect(foot?.findAll((node) => node.props.testID === 'session-collaboration-responsible-anchor').length).toBeGreaterThan(0);
    });

    it('pushes the compact Responsibility step in place of the retained Collaboration body', async () => {
        const active = await upsertServerProfile({ name: 'Responsibility step Home', serverUrl: 'https://collaboration-responsibility-step.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        const responsibilitySession = {
            id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
            // `null` is an authoritative "nobody", so responsibility is
            // projected and this viewer may change it.
            responsibleAccountId: null,
            responsibleAccount: null,
            access: { capabilities: { managePublicLink: true, assignResponsibility: true } },
        } as unknown as Session;
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: { ...state.sessions, 'same-id': responsibilitySession },
            // Responsibility's canonical reader is the exact Home's Session list
            // row, not the unscoped Session record, so the mounted controller
            // only leaves `loading` once that row exists for this Home.
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [active.id]: { 'same-id': responsibilitySession } as unknown as Record<string, SessionListRenderableSession>,
            },
        }));
        serveSession(active.id);

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        // This file mounts an iOS phone, so the compact host is the live one.
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-row')).not.toBeNull());
        expect(screen.findByTestId('session-collaboration-main-panel')?.props.pointerEvents).toBe('auto');

        await screen.pressByTestIdAsync('session-responsibility-row');
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-step')).not.toBeNull());

        // The transition belongs to the surface, not to an overlay above it:
        // Collaboration's own body stops being interactive and is hidden from
        // assistive technology while the step occupies the surface. A modal card
        // containing the same list would have left this panel active, which is
        // why asserting the step's descendants alone cannot prove a pushed step.
        const duringStep = screen.findByTestId('session-collaboration-main-panel');
        expect(duringStep?.props.pointerEvents).toBe('none');
        expect(duringStep?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(duringStep?.props.accessibilityElementsHidden).toBe(true);
        // Retained rather than unmounted, so the conversations' scroll and focus
        // survive the round trip instead of reloading behind the step.
        expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull();

        await screen.pressByTestIdAsync('session-responsibility-step-back');

        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-step')).toBeNull());
        const afterBack = screen.findByTestId('session-collaboration-main-panel');
        expect(afterBack?.props.pointerEvents).toBe('auto');
        expect(afterBack?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('session-responsibility-row')).not.toBeNull();
    });

    it('keeps publication reachable on a Home that publishes links but does not support named access', async () => {
        const active = await upsertServerProfile({ name: 'Publication only Home', serverUrl: 'https://collaboration-publication-only.example.test' });
        credentials.serverId = active.id;
        // `sharing.public` has no catalog dependency on `sharing.session`, so this
        // Home is reachable. The destination must stay admitted: publication has
        // no other entry point, and the named-access body states why it is absent
        // instead of rendering an editor that cannot work.
        await publishFeatures(active.id, ['sharing.public'], ['sharing.session', 'sessions.conversations']);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: true } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id);

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        // Sharing with people is not on this Home: the pane keeps explaining what it is for and
        // offers what still works, a public link.
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-sharing-off')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-sharing-off-action')).not.toBeNull());
        await screen.pressByTestIdAsync('session-collaboration-sharing-off-action');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-card')).not.toBeNull());
        expect(screen.findByTestId('session-access-editor:collaboration')).toBeNull();
    });

    it('drops a visited Conversations body once the exact Home withdraws that feature', async () => {
        const active = await upsertServerProfile({ name: 'Conversations withdrawn Home', serverUrl: 'https://collaboration-conversations-withdrawn.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id, { managePublicLink: false });

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());

        // The Home stops advertising the dependent feature while this surface
        // stays mounted. An unsupported body must fail closed rather than stay
        // mounted, subscribed and reachable to assistive technology.
        await act(async () => {
            await publishFeatures(
                active.id,
                ['sharing.session', 'sharing.public'],
                ['sessions.conversations'],
            );
        });

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).toBeNull());
        expect(screen.findByTestId('session-collaboration-modes')).toBeNull();
        expect(screen.findByTestId('session-collaboration-access-card')).not.toBeNull();
    });

    it('grows the Share panel for an explicit Access intent on first mount and folds it back into the card', async () => {
        const active = await upsertServerProfile({ name: 'Collaboration modes Home', serverUrl: 'https://collaboration-modes.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id, { managePublicLink: false });
        publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'access');

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull());
        // The panel covers the pane; the conversations beneath keep their place but are inert.
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('auto'));
        expect(screen.findByTestId('session-collaboration-main-column')?.props).toMatchObject({
            pointerEvents: 'none',
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(screen.findByTestId('session-collaboration-modes')).toBeNull();

        // ⌄ folds it back into the card; the panel is retained (its search and scroll survive) but inert.
        await screen.pressByTestIdAsync('session-collaboration-share-collapse');
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-main-column')?.props.pointerEvents).toBe('auto'));
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('none'));
        expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());

        // Pressing the card grows it again.
        await screen.pressByTestIdAsync('session-collaboration-access-card');
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('auto'));
    });

    it('focuses the initially requested public link after delayed session hydration mounts its anchor', async () => {
        const active = await upsertServerProfile({ name: 'Delayed focus Home', serverUrl: 'https://collaboration-delayed-focus.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        const session = {
            id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
            access: { capabilities: { managePublicLink: false } },
        } as unknown as Session;
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: { ...state.sessions, 'same-id': session },
        }));
        const record = serveSession(active.id, { managePublicLink: false });
        const hydration = createDeferred<void>();
        homeFor(active.id).snapshotResponse = async () => {
            await hydration.promise;
            return Response.json({ session: record });
        };
        publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'publicLink');
        const focused = vi.fn();
        const nativeNodes = new Map<string, Readonly<{ id: number }>>();
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            [...nativeNodes.values()].find((node) => node === target)?.id ?? null
        ));
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
            {
                createNodeMock: (element) => {
                    const testID = (element as { props?: { testID?: string } }).props?.testID;
                    const node = { id: nativeNodes.size + 1, focus: () => focused(testID) };
                    if (testID) nativeNodes.set(testID, node);
                    return node;
                },
            },
        );
        await vi.waitFor(() => expect(snapshotRequests(active.id).length).toBeGreaterThan(0));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(screen.findByTestId('session-collaboration-public-link-anchor')).toBeNull();
        await act(async () => { hydration.resolve(); });
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-public-link-anchor')).not.toBeNull());
        await vi.waitFor(() => expect(focused).toHaveBeenCalledWith('session-collaboration-public-link-anchor'));
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(
            nativeNodes.get('session-collaboration-public-link-anchor')?.id,
        );
    });

    it('focuses the requested anchor when an already-mounted surface consumes a new intent', async () => {
        const active = await upsertServerProfile({ name: 'Collaboration focus Home', serverUrl: 'https://collaboration-focus.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id, { managePublicLink: false });
        const focused = vi.fn();
        const nativeNodes = new Map<string, Readonly<{ id: number }>>();
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            [...nativeNodes.values()].find((node) => node === target)?.id ?? null
        ));

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
            {
                createNodeMock: (element) => {
                    const testID = (element as { props?: { testID?: string } }).props?.testID;
                    const node = { id: nativeNodes.size + 1, focus: () => focused(testID) };
                    if (testID) nativeNodes.set(testID, node);
                    return node;
                },
            },
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());

        await act(async () => {
            publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'access');
        });

        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('auto'));
        await vi.waitFor(() => expect(focused).toHaveBeenCalledWith('session-collaboration-access-body'));
        await vi.waitFor(() => expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledWith(
            nativeNodes.get('session-collaboration-access-body')?.id,
        ));

        await act(async () => {
            publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'publicLink');
        });
        await vi.waitFor(() => expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(
            nativeNodes.get('session-collaboration-public-link-anchor')?.id,
        ));

        nativeFocus.setAccessibilityFocus.mockClear();
        await act(async () => {
            publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'access');
            publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'publicLink');
        });
        await vi.waitFor(() => expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledWith(
            nativeNodes.get('session-collaboration-public-link-anchor')?.id,
        ));
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalledWith(
            nativeNodes.get('session-collaboration-access-body')?.id,
        );

        nativeFocus.setAccessibilityFocus.mockClear();
        await screen.unmount();
        publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'access');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalled();
    });

    it('consumes the Access focus query once so a later visit does not force Share open again', async () => {
        const active = await upsertServerProfile({ name: 'Collaboration query Home', serverUrl: 'https://collaboration-query.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id, { managePublicLink: false });
        // A released Access deep link: the one-shot intent travels as a query key
        // beside the Session's own exact-Home route state.
        route.params = { serverId: active.id, collaborationFocus: 'access' };

        const target = { serverId: active.id, sessionId: 'same-id' };
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={target} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('auto'));

        // Applied once, then consumed at the navigation owner: only this key is
        // rewritten, the Session's own route scope survives, and nothing navigates.
        await vi.waitFor(() => expect(route.setParams).toHaveBeenCalledWith({ collaborationFocus: undefined }));
        expect(route.readParams()).toMatchObject({ serverId: active.id });
        expect(route.readParams().collaborationFocus).toBeUndefined();
        expect(route.replace).not.toHaveBeenCalled();
        expect(route.push).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('session-collaboration-share-collapse');
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-main-column')?.props.pointerEvents).toBe('auto'));

        // Leaving and returning to the same Session must not force Share open again.
        await screen.unmount();
        const revisited = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={target} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(revisited.findByTestId('session-collaboration-access-card')).not.toBeNull());
        expect(revisited.findByTestId('session-collaboration-share-panel')).toBeNull();
        expect(revisited.findByTestId('session-collaboration-main-column')?.props.pointerEvents).toBe('auto');
    });

    it('handles the same route focus again after the canonical intent was absent without remounting', async () => {
        const active = await upsertServerProfile({ name: 'Collaboration repeated query Home', serverUrl: 'https://collaboration-repeated-query.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id, { managePublicLink: false });
        route.params = { serverId: active.id, collaborationFocus: 'access' };
        const target = { serverId: active.id, sessionId: 'same-id' };
        const focused = vi.fn();

        // Rendered fresh on every pass: React bails out of a subtree whose
        // element is referentially identical, so reusing one cached element
        // would leave the surface on its previous route read and this test
        // could never observe a second query arriving at all.
        const element = () => (
            <AppPaneProvider>
                <SessionCollaborationSurface target={target} />
            </AppPaneProvider>
        );
        const screen = await renderScreen(element(), {
            createNodeMock: (node) => {
                const testID = (node as { props?: { testID?: string } }).props?.testID;
                return { focus: () => focused(testID) };
            },
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('auto'));
        await vi.waitFor(() => expect(route.readParams().collaborationFocus).toBeUndefined());

        await screen.pressByTestIdAsync('session-collaboration-share-collapse');
        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('none'));

        // The route mailbox observed the consumed/absent state before a later
        // caller issued the same exact request again on this retained surface.
        await screen.update(element());
        focused.mockClear();
        await act(async () => { route.applyParams({ collaborationFocus: 'access' }); });
        await screen.update(element());

        await vi.waitFor(() => expect(screen.findByTestId('session-collaboration-share-panel')?.props.pointerEvents).toBe('auto'));
        await vi.waitFor(() => expect(focused).toHaveBeenCalledWith('session-collaboration-access-body'));
        await vi.waitFor(() => expect(route.readParams().collaborationFocus).toBeUndefined());
    });

    it('refreshes the retained Access presentation when the exact Home reports the Session changed', async () => {
        const other = await upsertServerProfile({ name: 'Collaboration other Home', serverUrl: 'https://collaboration-refresh-other.example.test' });
        const profile = await upsertServerProfile({ name: 'Collaboration refresh Home', serverUrl: 'https://collaboration-refresh.example.test' });
        await publishCollaboration(profile.id);
        credentials.serverId = profile.id;
        serveSession(profile.id);
        const rowAt = (updatedAt: number) => ({
            'same-id': createSessionListRenderableSessionFixture({ id: 'same-id', updatedAt, seq: updatedAt, metadataVersion: updatedAt }),
        });
        storage.setState((state) => ({
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [profile.id]: rowAt(10) },
        }));
        publishSessionCollaborationIntent({ serverId: profile.id, sessionId: 'same-id' }, 'access');

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: profile.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull());
        await vi.waitFor(() => expect(snapshotRequests(profile.id).length).toBeGreaterThan(0));
        const afterMount = snapshotRequests(profile.id).length;

        // The same raw Session id on a different Home is a different Session.
        await act(async () => {
            storage.setState((state) => ({
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [other.id]: rowAt(99) },
            }));
        });
        expect(snapshotRequests(profile.id).length).toBe(afterMount);

        // A completed operation on THIS Home advances its canonical row, and the
        // open panel re-reads without a remount instead of waiting for one.
        await act(async () => {
            storage.setState((state) => ({
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [profile.id]: rowAt(20) },
            }));
        });
        await vi.waitFor(() => expect(snapshotRequests(profile.id).length).toBeGreaterThan(afterMount));
        expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull();
    });

    it('seeds its own search field with the query the compact editor handed over', async () => {
        const active = await upsertServerProfile({ name: 'Collaboration handoff Home', serverUrl: 'https://collaboration-handoff.example.test' });
        credentials.serverId = active.id;
        await publishCollaboration(active.id);
        storage.setState((state) => ({
            profileScope: { serverId: active.id, accountId: credentials.accountId },
            sessions: {
                ...state.sessions,
                'same-id': {
                    id: 'same-id', metadata: null, currentStorageState: 'hosted', transcriptShareable: true,
                    access: { capabilities: { managePublicLink: false } },
                } as unknown as Session,
            },
        }));
        serveSession(active.id, { managePublicLink: false });
        // The anchored composer editor closes and hands its one-shot intent over.
        publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'access', 'ada');

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCollaborationSurface target={{ serverId: active.id, sessionId: 'same-id' }} />
            </AppPaneProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('session-access-editor:collaboration')).not.toBeNull());
        // Without the carried query the destination opens on an empty field and
        // the person retypes what they had already typed.
        await vi.waitFor(() => expect(
            screen.findByTestId('session-access-editor:collaboration:session-access-search')?.props.value,
        ).toBe('ada'));

        // The destination stays mounted. A later compact handoff whose field was
        // deliberately emptied must clear it rather than leave the old search.
        await act(async () => {
            publishSessionCollaborationIntent({ serverId: active.id, sessionId: 'same-id' }, 'access', '');
        });
        await vi.waitFor(() => expect(
            screen.findByTestId('session-access-editor:collaboration:session-access-search')?.props.value,
        ).toBe(''));
    });

});
