import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import { notifySessionPublicLinkInvalidated } from '@/sync/domains/social/sessionPublicLinkInvalidation';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { SessionAccessApiError } from '@/sync/api/session/sessionAccessApi';
import { SessionPublicLinkSection, useSessionCollaborationPublicLink } from './SessionPublicLinkSection';
import type { RenderScreenResult } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const publication = vi.hoisted(() => ({
    getPublicLink: vi.fn(),
    createPublicLink: vi.fn(),
    removePublicLink: vi.fn(),
    clientOptions: [] as unknown[],
    /** Every bearer the transport generated, in request order. */
    issuedTokens: [] as string[],
}));
const modal = vi.hoisted(() => ({ update: vi.fn(), hide: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => true) }));
const serverProfile = vi.hoisted(() => ({
    get: vi.fn(() => ({
        id: 'home-one',
        serverUrl: 'https://internal-home.example.test',
        shareableServerUrl: 'https://public-home.example.test',
        shareableServerUrlValidatedAgainstServerUrl: 'https://internal-home.example.test',
    })),
}));

// The canonical Session-access Action client is the replaced boundary; the
// mounted controller, its reconciliation, and its presentation stay real.
vi.mock('@/sync/api/session/sessionAccessApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionAccessApi')>();
    return {
        ...actual,
        createSessionAccessClient: (options: unknown) => {
            publication.clientOptions.push(options);
            const withFormat = (settings: Record<string, unknown> | null) => settings === null ? null : {
                ...settings, keyDerivation: 'fragment_v1', isolatedOrigin: 'https://public-viewer.example.test',
            };
            return {
                getPublicLink: async () => withFormat(await publication.getPublicLink()),
                createPublicLink: async (input: unknown) => {
                    const issue = (options as { onPublicLinkIssued?: (material: { lookupId: string; secret: string }) => void })
                        .onPublicLinkIssued;
                    // The real leaf reports the bearer it generated before it
                    // dispatches, so recovery evidence survives a lost response.
                    // Each request mints its own bearer, which is what makes a
                    // falsely promoted one observable.
                    const issued = `generated-by-transport-${publication.issuedTokens.length + 1}`;
                    publication.issuedTokens.push(issued);
                    issue?.({ lookupId: issued, secret: `fragment-${issued}` });
                    return withFormat(await publication.createPublicLink(input));
                },
                removePublicLink: publication.removePublicLink,
            };
        },
    };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    runWithServerRequestAuthorityForServerAccountScope: async (
        options: { scope: unknown },
        run: (authority: unknown) => Promise<unknown>,
    ) => run({ scope: options.scope, context: { credentials: { token: 'token', secret: new Uint8Array() } } }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority', () => ({
    readSessionSnapshotForAuthority: async () => ({
        session: { ...sessionFixture({ managePublicLink: true }), encryptionMode: 'plain' },
        callerDataKeyEnvelope: null,
    }),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});
/**
 * Feature availability is not mocked: the canonical decision runtime stays real
 * and only the exact Home's server snapshot is primed, so this suite proves the
 * section consumes the exact-server decision rather than any nearby snapshot.
 */
function primePublicLinkFeature(serverId: string, enabled: boolean): void {
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.public', enabled)) {
        throw new Error('Unable to write sharing.public');
    }
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
}
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>()),
    getServerProfileById: serverProfile.get,
}));

const scope = { serverId: 'home-one', accountId: 'account-owner' };

function sessionFixture(capabilities: Readonly<{ managePublicLink: boolean }>): Session {
    return {
        id: 'session-1',
        metadata: null,
        // A Session a current Home created: the canonical reader always names its
        // persisted layout, and an unmarked row is a historical (layout-0) one.
        metadataLayoutVersion: 1,
        currentStorageState: 'hosted',
        transcriptShareable: true,
        access: { capabilities },
    } as unknown as Session;
}

function hostedAvailability(): ExternalSessionSharingAvailability {
    return {
        sharingPresentation: {
            shareable: true,
            state: 'hosted',
            machineName: null,
            action: 'none',
            materializedThroughSourceAt: null,
        },
    } as unknown as ExternalSessionSharingAvailability;
}

/** The pane's one publication controller rendered through the Share panel's card, as the surface mounts it. */
function PublicLink(props: Readonly<{
    scope?: Readonly<{ serverId: string; accountId: string }>;
    session?: Session | null;
    testID?: string;
}>) {
    const session = props.session === undefined ? sessionFixture({ managePublicLink: true }) : props.session;
    const link = useSessionCollaborationPublicLink({
        scope: props.scope ?? scope,
        sessionId: 'session-1',
        session,
        availability: hostedAvailability(),
    });
    return <SessionPublicLinkSection link={link} hasSession={session !== null} shareable testID={props.testID} />;
}

const status = (screen: RenderScreenResult, testID = 'session-public-link-status') => screen.findByTestId(testID)?.props.children;
const shownUrl = (screen: RenderScreenResult) => screen.findByTestId('session-public-link-url')?.props.children as string | undefined;

/** Make a link through the card: Create public link (or New link…), then Create in the options. */
async function makeLink(screen: RenderScreenResult): Promise<void> {
    await screen.pressByTestIdAsync(screen.findByTestId('session-public-link-create') ? 'session-public-link-create' : 'session-public-link-new');
    await vi.waitFor(() => expect(screen.findByTestId('session-public-link-options-create')).not.toBeNull());
    await screen.pressByTestIdAsync('session-public-link-options-create');
}

describe('SessionPublicLinkSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        publication.clientOptions.length = 0;
        publication.issuedTokens.length = 0;
        // `clearAllMocks` only drops recorded calls: a queued `…Once` value or a
        // default implementation survives it. Every case below scripts this
        // transport precisely, so an unconsumed leftover from the previous case
        // would decide the next case's first read instead of its own fixture.
        publication.getPublicLink.mockReset();
        publication.createPublicLink.mockReset();
        publication.removePublicLink.mockReset();
        modal.alert.mockReset();
        modal.confirm.mockReset().mockResolvedValue(true);
        resetServerFeaturesClientForTests();
        primePublicLinkFeature(scope.serverId, true);
    });

    it('does not expose or fetch publication when the exact Home does not advertise sharing.public', async () => {
        primePublicLinkFeature(scope.serverId, false);
        // Another Home advertising publication must not admit this section.
        primePublicLinkFeature('home-other', true);
        const screen = await renderScreen(<PublicLink />);
        expect(screen.findByTestId('session-public-link-card')).toBeNull();
        expect(publication.getPublicLink).not.toHaveBeenCalled();
    });

    it('renders publication as its own card, never as an access principal', async () => {
        publication.getPublicLink.mockResolvedValue(null);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-card')).not.toBeNull());
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        expect(screen.findByTestId('session-public-link-create')).not.toBeNull();
        // Publication is not a grant: it must never appear inside the access editor rows.
        expect(screen.findByTestId('session-access-editor')).toBeNull();
    });

    it('shows its isolated link with a fragment secret, Copy and QR code', async () => {
        const created = { id: 'p1', expiresAt: null, useCount: 0, maxUses: 10, isConsentRequired: true, updatedAt: 1 };
        publication.getPublicLink.mockResolvedValue(null);
        publication.createPublicLink.mockResolvedValue(created);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(shownUrl(screen)).toBe(`https://public-viewer.example.test/s/${publication.issuedTokens[0]}#k=fragment-${publication.issuedTokens[0]}`));
        expect(status(screen)).toBe('On');
        // What it grants, in plain words, then its limits.
        expect(String(screen.findByTestId('session-public-link-detail')?.props.children)).toContain('0/10');
        await screen.pressByTestIdAsync('session-public-link-qr');
        expect(screen.findByTestId('session-public-link-qr-code')).not.toBeNull();
    });

    it('lets the user confirm a public Session link with visual network access off', async () => {
        publication.getPublicLink.mockResolvedValue(null);
        publication.createPublicLink.mockResolvedValue({ id: 'p1', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, networkOff: true, updatedAt: 1 });
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await screen.pressByTestIdAsync('session-public-link-create');
        const network = screen.findByTestId('session-public-link-network-off');
        expect(network).not.toBeNull();
        await act(async () => { network!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        expect(publication.createPublicLink).toHaveBeenCalledWith(expect.objectContaining({ networkOff: true }));
        expect(status(screen)).toBe('On');
    });

    it('admits one publication request while a create is in flight', async () => {
        const deferred = createDeferred<Record<string, unknown>>();
        publication.getPublicLink.mockResolvedValue(null);
        publication.createPublicLink.mockImplementation(() => deferred.promise);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => { screen.pressByTestId('session-public-link-options-create'); });
        await act(async () => { screen.pressByTestId('session-public-link-options-create'); });
        expect(publication.createPublicLink).toHaveBeenCalledTimes(1);
        expect(screen.findHostByTestId('session-public-link-options-create')?.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        await act(async () => { deferred.resolve({ id: 'p1', expiresAt: null, useCount: 0, maxUses: null, isConsentRequired: true, updatedAt: 1 }); });
        await vi.waitFor(() => expect(screen.findAllHostsByTestId('session-public-link-url')).toHaveLength(1));
        expect(publication.createPublicLink).toHaveBeenCalledTimes(1);
    });

    it('asks before turning the link off and deletes once for rapid activations', async () => {
        const deferred = createDeferred<void>();
        publication.getPublicLink.mockResolvedValueOnce({ id: 'p1', expiresAt: null, useCount: 3, maxUses: null, isConsentRequired: false, updatedAt: 1 }).mockResolvedValue(null);
        publication.removePublicLink.mockImplementation(() => deferred.promise);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('On'));
        await act(async () => { screen.pressByTestId('session-public-link-turn-off'); });
        await act(async () => { screen.pressByTestId('session-public-link-turn-off'); });
        expect(modal.confirm).toHaveBeenCalledTimes(1);
        expect(publication.removePublicLink).toHaveBeenCalledTimes(1);
        await act(async () => { deferred.resolve(); });
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        expect(publication.removePublicLink).toHaveBeenCalledTimes(1);
    });

    it('keeps the link when the person does not confirm turning it off', async () => {
        publication.getPublicLink.mockResolvedValue({ id: 'p1', expiresAt: null, useCount: 3, maxUses: null, isConsentRequired: false, updatedAt: 1 });
        modal.confirm.mockResolvedValue(false);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('On'));
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await vi.waitFor(() => expect(modal.confirm).toHaveBeenCalled());
        expect(publication.removePublicLink).not.toHaveBeenCalled();
        expect(status(screen)).toBe('On');
    });

    it('never promotes a bearer for a regeneration the Home did not commit', async () => {
        const first = {
            id: 'p1', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 1,
        };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockResolvedValue(first);
        publication.createPublicLink
            .mockResolvedValueOnce(first)
            .mockRejectedValue(new SessionAccessApiError('outcome_unknown'));
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!));

        // The physical executor owns one exact replay. If it still reports an
        // unknown outcome, this controller never guesses from mutable settings.
        await makeLink(screen);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        // The options stay open after a failure so the person can try again; closing them shows the link.
        await screen.pressByTestIdAsync('session-public-link-options-cancel');
        expect(publication.issuedTokens).toHaveLength(2);
        expect(status(screen)).toBe('On');
        expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!);
        expect(shownUrl(screen)).not.toContain(publication.issuedTokens[1]!);
    });

    it('does not infer a committed regeneration from refreshed row metadata', async () => {
        const first = {
            id: 'p1', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 1,
        };
        const regenerated = { ...first, id: 'p2', updatedAt: 2 };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(first)
            .mockResolvedValue(regenerated);
        publication.createPublicLink
            .mockResolvedValueOnce(first)
            .mockRejectedValue(new SessionAccessApiError('outcome_unknown'));
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(shownUrl(screen)).toBeDefined());

        await makeLink(screen);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        expect(publication.getPublicLink).toHaveBeenCalledTimes(1);
    });

    it('does not let a pre-create refresh overwrite the created publication or bearer', async () => {
        const staleRefresh = createDeferred<null>();
        const created = {
            id: 'p-created', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 4,
        };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(() => staleRefresh.promise);
        publication.createPublicLink.mockResolvedValue(created);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));

        notifySessionPublicLinkInvalidated({ serverId: scope.serverId, sessionId: 'session-1' });
        await vi.waitFor(() => expect(publication.getPublicLink).toHaveBeenCalledTimes(2));
        await makeLink(screen);
        await vi.waitFor(() => expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!));

        await act(async () => { staleRefresh.resolve(null); });
        await vi.waitFor(() => expect(status(screen)).toBe('On'));
        expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!);
    });

    it('does not let a pre-delete refresh resurrect a publication after unknown-outcome reconciliation', async () => {
        const active = {
            id: 'p-active', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 5,
        };
        const staleRefresh = createDeferred<typeof active>();
        publication.getPublicLink
            .mockResolvedValueOnce(active)
            .mockImplementationOnce(() => staleRefresh.promise)
            .mockResolvedValueOnce(null);
        publication.removePublicLink.mockRejectedValue(new SessionAccessApiError('outcome_unknown'));
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('On'));

        notifySessionPublicLinkInvalidated({ serverId: scope.serverId, sessionId: 'session-1' });
        await vi.waitFor(() => expect(publication.getPublicLink).toHaveBeenCalledTimes(2));
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));

        await act(async () => { staleRefresh.resolve(active); });
        expect(status(screen)).toBe('Off');
    });

    it('retains a bearer only for identical settings as the Home reports changes', async () => {
        const created = {
            id: 'p-current', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 7,
        };
        const rotated = { ...created, useCount: 2, updatedAt: 8 };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(created)
            .mockResolvedValueOnce(rotated)
            .mockResolvedValueOnce(null);
        publication.createPublicLink.mockResolvedValue(created);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!));

        await act(async () => { notifySessionPublicLinkInvalidated({ serverId: scope.serverId, sessionId: 'session-1' }); });
        await vi.waitFor(() => expect(publication.getPublicLink).toHaveBeenCalledTimes(2));
        expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!);

        // Changed settings are a different link state: the old bearer is not claimed for it.
        await act(async () => { notifySessionPublicLinkInvalidated({ serverId: scope.serverId, sessionId: 'session-1' }); });
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-hidden')).not.toBeNull());
        expect(shownUrl(screen)).toBeUndefined();

        await act(async () => { notifySessionPublicLinkInvalidated({ serverId: scope.serverId, sessionId: 'session-1' }); });
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
    });

    it('says a link made elsewhere cannot be shown again instead of exposing or inventing a token', async () => {
        publication.getPublicLink.mockResolvedValue({ id: 'p1', expiresAt: null, useCount: 3, maxUses: null, isConsentRequired: false, updatedAt: 1 });
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('On'));
        expect(screen.findByTestId('session-public-link-hidden')).not.toBeNull();
        expect(screen.findByTestId('session-public-link-url')).toBeNull();
        expect(screen.findByTestId('session-public-link-qr')).toBeNull();
    });

    it('tells a viewer without managePublicLink who can create a link, without fetching publication state', async () => {
        publication.getPublicLink.mockResolvedValue(null);
        const screen = await renderScreen(<PublicLink session={sessionFixture({ managePublicLink: false })} />);
        expect(screen.findByTestId('session-public-link-card')).toBeNull();
        expect(screen.findByTestId('session-public-link-denied')).not.toBeNull();
        expect(publication.getPublicLink).not.toHaveBeenCalled();
    });

    it('keeps a card-local retry when publication load fails', async () => {
        publication.getPublicLink.mockRejectedValue(new Error('offline'));
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-retry')).not.toBeNull());
        publication.getPublicLink.mockResolvedValue(null);
        await screen.pressByTestIdAsync('session-public-link-retry-action');
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
    });

    it('leaves a twice-ambiguous create unresolved instead of promoting from a read', async () => {
        const committed = {
            id: 'p-committed', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 2,
        };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockResolvedValue(committed);
        publication.createPublicLink.mockRejectedValue(new SessionAccessApiError('outcome_unknown'));
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());

        expect(publication.createPublicLink).toHaveBeenCalledTimes(1);
        expect(publication.getPublicLink).toHaveBeenCalledTimes(1);
    });

    it('clears the card mutation refusal when its Home and Account scope changes', async () => {
        publication.getPublicLink.mockResolvedValue(null);
        publication.createPublicLink.mockRejectedValue(new SessionAccessApiError('public_share_isolation_unavailable', 503));
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        expect(modal.alert).not.toHaveBeenCalled();
        const otherScope = { serverId: 'home-two', accountId: 'other-account' };
        primePublicLinkFeature(otherScope.serverId, true);
        await act(async () => { screen.tree.update(<PublicLink scope={otherScope} />); });
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        expect(screen.findByTestId('session-public-link-mutation-error')).toBeNull();
        expect(screen.findByTestId('session-public-link-options-create')).toBeNull();
    });

    it('refreshes every mounted owner controller for the exact Home and Session only', async () => {
        publication.getPublicLink.mockResolvedValue(null);
        const otherScope = { serverId: 'home-two', accountId: 'account-owner' };
        primePublicLinkFeature(otherScope.serverId, true);
        await renderScreen(
            <>
                <PublicLink testID="home-one-public-link" />
                <PublicLink testID="home-one-second-public-link" />
                <PublicLink scope={otherScope} testID="home-two-public-link" />
            </>,
        );
        await vi.waitFor(() => expect(publication.getPublicLink).toHaveBeenCalledTimes(3));
        publication.getPublicLink.mockClear();

        notifySessionPublicLinkInvalidated({ serverId: 'home-one', sessionId: 'session-1' });

        await vi.waitFor(() => expect(publication.getPublicLink).toHaveBeenCalledTimes(2));
        // Every refreshed read is bound to the exact qualified Home/Account and
        // Session, never to whichever Home happens to be active.
        expect(publication.clientOptions.every((options) => {
            const bound = options as { scope: unknown; sessionId: string };
            return JSON.stringify(bound.scope) === JSON.stringify(scope) || JSON.stringify(bound.scope) === JSON.stringify(otherScope);
        })).toBe(true);
    });

    it('keeps the last good publication visible when an invalidation refresh is offline', async () => {
        publication.getPublicLink.mockResolvedValueOnce({
            id: 'p1', expiresAt: null, useCount: 3, maxUses: null,
            isConsentRequired: false, updatedAt: 1,
        });
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('On'));
        publication.getPublicLink.mockRejectedValueOnce(new Error('offline'));

        notifySessionPublicLinkInvalidated({ serverId: 'home-one', sessionId: 'session-1' });

        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-retry')).not.toBeNull());
        expect(status(screen)).toBe('On');
        expect(screen.findByTestId('session-public-link-detail')).not.toBeNull();
    });

    it('refreshes from the exact Session change observed during reconnect catch-up', async () => {
        const active = {
            id: 'p-after-reconnect', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: false, updatedAt: 2,
        };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(active);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));

        // The canonical changes-page catch-up publishes raw AccountChange entity IDs.
        publishHomeAccountChange('home-one', ['session-1'], { sessionListQueryAffects: true });

        await vi.waitFor(() => expect(status(screen)).toBe('On'));
        expect(publication.getPublicLink).toHaveBeenCalledTimes(2);
    });

    it('reconciles remote create, settings, regeneration, and deletion through the owner endpoint', async () => {
        const first = {
            id: 'p1', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: false, updatedAt: 1,
        };
        const changed = { ...first, maxUses: 5, updatedAt: 2 };
        const regenerated = { ...first, id: 'p2', updatedAt: 3 };
        publication.getPublicLink
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(changed)
            .mockResolvedValueOnce(regenerated)
            .mockResolvedValueOnce(null);
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));

        await act(async () => {
            notifySessionPublicLinkInvalidated({ serverId: 'home-one', sessionId: 'session-1' });
        });
        await vi.waitFor(() => {
            expect(publication.getPublicLink).toHaveBeenCalledTimes(2);
            expect(status(screen)).toBe('On');
        });

        await act(async () => {
            notifySessionPublicLinkInvalidated({ serverId: 'home-one', sessionId: 'session-1' });
        });
        await vi.waitFor(() => {
            expect(publication.getPublicLink).toHaveBeenCalledTimes(3);
            expect(String(screen.findByTestId('session-public-link-detail')?.props.children)).toContain('5');
        });

        await act(async () => {
            notifySessionPublicLinkInvalidated({ serverId: 'home-one', sessionId: 'session-1' });
        });
        await vi.waitFor(() => {
            expect(publication.getPublicLink).toHaveBeenCalledTimes(4);
            expect(String(screen.findByTestId('session-public-link-detail')?.props.children)).not.toContain('5');
        });

        await act(async () => {
            notifySessionPublicLinkInvalidated({ serverId: 'home-one', sessionId: 'session-1' });
        });
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        expect(publication.getPublicLink).toHaveBeenCalledTimes(5);
    });

    it('keeps an issued link readable but withdraws every control while the authority is not current', async () => {
        publication.getPublicLink.mockResolvedValue(null);
        publication.createPublicLink.mockResolvedValue({ id: 'p1', expiresAt: null, useCount: 0, maxUses: null, isConsentRequired: true, updatedAt: 1 });
        function Stale(props: Readonly<{ current: boolean }>) {
            const session = sessionFixture({ managePublicLink: true });
            const link = useSessionCollaborationPublicLink({
                scope, sessionId: 'session-1', session, availability: hostedAvailability(), authorityCurrent: props.current,
            });
            return <SessionPublicLinkSection link={link} hasSession shareable />;
        }
        const screen = await renderScreen(<Stale current />);
        await vi.waitFor(() => expect(status(screen)).toBe('Off'));
        await makeLink(screen);
        await vi.waitFor(() => expect(shownUrl(screen)).toBeDefined());
        await screen.update(<Stale current={false} />);
        expect(shownUrl(screen)).toContain(publication.issuedTokens[0]!);
        expect(screen.findHostByTestId('session-public-link-turn-off')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(screen.findHostByTestId('session-public-link-new')?.props.accessibilityState).toMatchObject({ disabled: true });
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        expect(modal.confirm).not.toHaveBeenCalled();
        expect(publication.removePublicLink).not.toHaveBeenCalled();
    });

    // The approval-routed publication journey runs on the real approval
    // lifecycle in `SessionPublicLinkSection.approval.test.tsx`.
});
