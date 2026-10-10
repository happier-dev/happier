import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamInvitationRowFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AlertButton = Readonly<{ text: string; onPress?: () => void }>;

/** Which offered action a case takes, and what it types when asked. */
const modalChoice = vi.hoisted(() => ({
    press: null as string | null,
    promptAnswer: null as string | null,
}));
const modalBoundary = vi.hoisted(() => ({
    calls: 0,
    wait: null as Promise<void> | null,
    /** Every destructive confirmation this screen raised, in order. */
    confirmations: [] as Array<Readonly<{ title: string; body: string }>>,
    confirmed: true,
}));

const promptSpy = vi.hoisted(() => vi.fn(async () => modalChoice.promptAnswer));
const languageMock = vi.hoisted(() => ({ current: 'en' }));
const shareTextSafeMock = vi.hoisted(() => vi.fn(async () => 'shared' as const));
const sharingAvailableMock = vi.hoisted(() => ({ current: true }));
const virtualizedBoundary = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
    mountLimit: Number.POSITIVE_INFINITY,
}));
const navigationState = vi.hoisted(() => ({
    focused: true,
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, unknown>) => {
        virtualizedBoundary.props = props;
        const data = ((props.data as readonly unknown[] | undefined) ?? []).slice(0, virtualizedBoundary.mountLimit);
        const renderItem = props.renderItem as (info: { item: unknown; index: number }) => React.ReactNode;
        return React.createElement(
            'VirtualizedList',
            { testID: props.testID },
            props.ListHeaderComponent as React.ReactNode,
            ...data.map((item, index) => renderItem({ item, index })),
            props.ListFooterComponent as React.ReactNode,
        );
    },
}));

// Sharing is a genuine platform boundary. Make its availability explicit so
// this screen proves the same link handoff as invitation creation on every host.
vi.mock('@/utils/ui/shareText', () => ({
    isTextSharingAvailable: () => sharingAvailableMock.current,
    shareTextSafe: shareTextSafeMock,
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => navigationState.focused,
    };
});

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ getPreferredLanguage: () => languageMock.current });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                // The screen offers its actions as explicit alert buttons, so a
                // case picks one by the exact action it means to take.
                alertAsync: (async (_title: string, _body: string, buttons?: readonly AlertButton[]) => {
                    modalBoundary.calls += 1;
                    if (modalBoundary.wait) await modalBoundary.wait;
                    const chosen = buttons?.find((button) => button.text === modalChoice.press);
                    chosen?.onPress?.();
                }) as never,
                prompt: promptSpy as never,
                confirm: (async (title: string, body: string) => {
                    modalBoundary.confirmations.push({ title, body });
                    return modalBoundary.confirmed;
                }) as never,
            },
        }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const INVITATIONS_LIST_PATH = '/v1/teams/invitations/list';
const INVITATION_REISSUE_PATH = '/v1/teams/invitations/reissue';
const INVITATION_REVOKE_PATH = '/v1/teams/invitations/revoke';

async function renderInvitations(serverId: string) {
    const { TeamInvitationsScreen } = await import('./TeamInvitationsScreen');
    const { NavigationContext, useNavigation } = await import('@react-navigation/native');
    function NativeRoute({ children }: React.PropsWithChildren) {
        return <NavigationContext.Provider value={useNavigation()}>{children}</NavigationContext.Provider>;
    }
    return renderScreen(<TeamInvitationsScreen serverId={serverId} teamId="team-1" />, { wrapper: NativeRoute });
}

async function addManagedHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageInvitations: true }),
        }),
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderInvitations>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids, JSON.stringify({ ids, text: screen.getTextContent() })).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    modalChoice.press = null;
    modalChoice.promptAnswer = null;
    modalBoundary.calls = 0;
    modalBoundary.wait = null;
    modalBoundary.confirmations = [];
    modalBoundary.confirmed = true;
    promptSpy.mockClear();
    languageMock.current = 'en';
    shareTextSafeMock.mockReset();
    shareTextSafeMock.mockResolvedValue('shared');
    sharingAvailableMock.current = true;
    navigationState.focused = true;
    virtualizedBoundary.props = null;
    virtualizedBoundary.mountLimit = Number.POSITIVE_INFINITY;
});

afterEach(() => {
    standardCleanup();
});

describe('TeamInvitationsScreen', () => {
    it('formats invitation expiry in the selected app language', async () => {
        languageMock.current = 'de';
        const expiresAt = Date.parse('2025-02-03T12:00:00Z');
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ expiresAt })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        expect(screen.getTextContent())
            .toContain(new Intl.DateTimeFormat('de', { dateStyle: 'medium' }).format(expiresAt));
    });
    it.each([
        { status: 403, label: 'teams.errors.forbidden' },
        { status: 404, label: 'teams.unavailable.updateRequired' },
    ])('explains an invitation read refusal ($status) without offering an ineffective retry', async ({ status, label }) => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, { status });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-unavailable');

        expect(screen.getTextContent()).toContain(label);
        expect(screen.getTextContent()).not.toContain('teams.unavailable.offline');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-invitations-retry');
    });

    it('recovers an initial transient invitation read failure and retains loaded invitations when refresh fails', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, { status: 503 });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-retry');
        expect(screen.getTextContent()).toContain('teams.unavailable.offline');

        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture()],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        await screen.pressByTestIdAsync('team-invitations-retry');
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-invitations-unavailable');

        harness.answer(serverId, INVITATIONS_LIST_PATH, { status: 503 });
        await act(async () => { navigationState.focusEffects[0]?.(); });
        await waitForTestId(screen, 'team-invitations-retry');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-invitations-row:invitation-1');
        expect(screen.getTextContent()).toContain('teams.unavailable.offline');
    });

    it('opens only one row action while the first choice is still pending', async () => {
        let releaseChoice = (): void => {};
        modalBoundary.wait = new Promise<void>((resolve) => { releaseChoice = resolve; });
        modalChoice.press = 'teams.invitations.reissue';
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [teamInvitationRowFixture()], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'invitation-2' }),
                joinUrl: 'https://home-a.example/join/token-2',
            },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        act(() => {
            screen.pressByTestId('team-invitations-row:invitation-1');
            screen.pressByTestId('team-invitations-row:invitation-1');
        });

        expect(modalBoundary.calls).toBe(1);
        await act(async () => releaseChoice());
        await vi.waitFor(() => expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(1));
    });

    it('confirms a revoke with revoke copy before it calls the Home', async () => {
        modalChoice.press = 'teams.invitations.revoke';
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [teamInvitationRowFixture()], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });
        harness.answer(serverId, INVITATION_REVOKE_PATH, {
            body: teamInvitationRowFixture({ state: 'revoked' }),
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        await vi.waitFor(() => expect(harness.requestsFor(INVITATION_REVOKE_PATH)).toHaveLength(1));
        // The chooser's body describes reissuing whenever reissue is offered, so
        // the destructive branch must state its own consequence itself.
        expect(modalBoundary.confirmations).toEqual([{
            title: 'teams.invitations.revokeTitle',
            body: 'teams.invitations.revokeBody',
        }]);
    });

    it('leaves the invitation live when the revoke confirmation is declined', async () => {
        modalChoice.press = 'teams.invitations.revoke';
        modalBoundary.confirmed = false;
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [teamInvitationRowFixture()], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        expect(modalBoundary.confirmations).toHaveLength(1);
        expect(harness.requestsFor(INVITATION_REVOKE_PATH)).toHaveLength(0);
        // A declined confirmation must not strand the row's action guard.
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');
        expect(modalBoundary.confirmations).toHaveLength(2);
    });

    it('groups invitations still waiting apart from finished ones, with an undelivered email offering Send again', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [
                    teamInvitationRowFixture({ id: 'waiting-ok' }),
                    teamInvitationRowFixture({
                        id: 'waiting-undelivered',
                        recipientEmailMask: 's•••@gmail.com',
                        lastEmailDelivery: { status: 'failed', attemptedAt: 1 },
                    }),
                    teamInvitationRowFixture({ id: 'finished-accepted', state: 'accepted' }),
                ],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:finished-accepted');

        const keyExtractor = virtualizedBoundary.props?.keyExtractor as (item: unknown) => string;
        const data = virtualizedBoundary.props?.data as readonly unknown[];
        expect(data.map(keyExtractor)).toEqual(['waiting:waiting-ok', 'finished:finished-accepted']);
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // Trouble carries its action in its own row; nothing else does.
        expect(ids).toContain('team-invitations-send-again:waiting-undelivered');
        expect(ids).not.toContain('team-invitations-send-again:waiting-ok');
        expect(ids).not.toContain('team-invitations-send-again:finished-accepted');

        // "Send again" is the same-recipient retry, asked for directly: no chooser opens.
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ id: 'waiting-undelivered', state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'replacement' }),
                joinUrl: null,
            },
        });
        await screen.pressByTestIdAsync('team-invitations-send-again:waiting-undelivered');
        await vi.waitFor(() => expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(1));
        expect(modalBoundary.calls).toBe(0);
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)[0]?.input)
            .toMatchObject({ invitationId: 'waiting-undelivered', recipientEmail: null });
    });

    it('renders a large invitation ledger as stable chunks in the canonical virtualized list', async () => {
        virtualizedBoundary.mountLimit = 2;
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: Array.from({ length: 25 }, (_, index) => teamInvitationRowFixture({
                    id: `invitation-${index}`,
                })),
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-0');

        expect(virtualizedBoundary.props?.testID).toBe('team-invitations-virtualized-list');
        expect(virtualizedBoundary.props?.maintainVisibleContentPosition).toBe(true);
        const data = virtualizedBoundary.props?.data as readonly unknown[];
        expect(data.length).toBeLessThan(25);
        const keyExtractor = virtualizedBoundary.props?.keyExtractor as (item: unknown) => string;
        // Every one of these is still waiting, so all three chunks belong to the Waiting group.
        expect(data.map(keyExtractor)).toEqual([
            'waiting:invitation-0',
            'waiting:invitation-12',
            'waiting:invitation-24',
        ]);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-invitations-row:invitation-24');
    });

    it('refetches the retained list when returning from invitation creation', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture()],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        const before = harness.requestsFor(INVITATIONS_LIST_PATH).length;

        const { TeamInvitationsScreen } = await import('./TeamInvitationsScreen');
        navigationState.focused = false;
        await screen.update(<TeamInvitationsScreen serverId={serverId} teamId="team-1" />);
        navigationState.focused = true;
        await screen.update(<TeamInvitationsScreen serverId={serverId} teamId="team-1" />);

        await vi.waitFor(() => {
            expect(harness.requestsFor(INVITATIONS_LIST_PATH).length).toBeGreaterThan(before);
        });
    });

    it('hands a reissued bearer over exactly as a freshly created one', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture()],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'invitation-2' }),
                joinUrl: 'https://home-a.example/join/token-2',
            },
        });
        modalChoice.press = 'teams.invitations.reissue';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');
        await waitForTestId(screen, 'team-invitations-fresh-copy-link');

        // The same secret must be deliverable the same way on both screens; a
        // scannable link on create and a copy-only link on reissue is a
        // difference no manager could discover a reason for.
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-invitations-fresh-share-link');
        expect(ids).toContain('team-invitations-fresh-qr');
    });

    it('withholds Change email when this Home can no longer mail one', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ recipientEmailMask: 'a•••@example.com' })],
                nextCursor: null,
                emailDelivery: 'unavailable',
                linkDelivery: 'available',
            },
        });
        // The case picks Change email if it is offered at all.
        modalChoice.press = 'teams.invitations.deliveryChangeEmail';
        modalChoice.promptAnswer = 'ada@example.com';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        // Offering it would promise a reissue the Home refuses — and a refused
        // reissue retires nothing, so the manager would be left guessing.
        expect(promptSpy).not.toHaveBeenCalled();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(0);
    });

    it('refetches the authoritative page when this Home says its Teams changed', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture()],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        const before = harness.requestsFor(INVITATIONS_LIST_PATH).length;

        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol');

        // A wake naming other entities is not this list's business.
        await act(async () => {
            publishHomeAccountChange(serverId, ['home-governance']);
        });
        expect(harness.requestsFor(INVITATIONS_LIST_PATH).length).toBe(before);

        // A Teams wake means another manager committed something; the row this
        // screen is showing may already say the wrong thing.
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        await vi.waitFor(() => {
            expect(harness.requestsFor(INVITATIONS_LIST_PATH).length).toBeGreaterThan(before);
        });
    });

    it('retries an email-bound invitation without reproducing the address behind its mask', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ recipientEmailMask: 'a•••@example.com' })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'invitation-2' }),
                joinUrl: null,
            },
        });
        modalChoice.press = 'teams.invitations.reissue';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        await vi.waitFor(() => {
            expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(1);
        });
        // `null` is Retry, and the Home preserves the existing constraint, so
        // this cannot widen an email-bound invitation into a transferable link
        // and the manager is never asked to retype an address they cannot see.
        expect(promptSpy).not.toHaveBeenCalled();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)[0]?.input).toMatchObject({
            invitationId: 'invitation-1',
            recipientEmail: null,
        });
        await vi.waitFor(() => {
            const rendered = JSON.stringify(screen.tree.toJSON());
            expect(rendered).toContain('teams.invitations.deliveryUnknown');
            expect(rendered).not.toContain('teams.invitations.bearerUnavailable');
        });
    });

    it('reuses the same reissue identity after an uncertain response', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ recipientEmailMask: 'a•••@example.com' })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            status: 503,
            body: { error: 'unavailable' },
        });
        modalChoice.press = 'teams.invitations.reissue';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({
                    id: 'invitation-2',
                    recipientEmailMask: 'a•••@example.com',
                    lastEmailDelivery: { status: 'sent', attemptedAt: 1_000_000_000_001 },
                }),
                joinUrl: null,
            },
        });
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        const retries = harness.requestsFor(INVITATION_REISSUE_PATH);
        expect(retries).toHaveLength(2);
        expect((retries[0]?.input as { requestKey?: string }).requestKey).toBeTruthy();
        expect((retries[1]?.input as { requestKey?: string }).requestKey)
            .toBe((retries[0]?.input as { requestKey?: string }).requestKey);
    });

    it('replaces the recipient only when Change email is the chosen intent', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ recipientEmailMask: 'a•••@example.com' })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'invitation-2' }),
                joinUrl: null,
            },
        });
        modalChoice.press = 'teams.invitations.deliveryChangeEmail';
        modalChoice.promptAnswer = 'grace@example.com';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        await vi.waitFor(() => {
            expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(1);
        });
        expect(promptSpy).toHaveBeenCalled();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)[0]?.input).toMatchObject({
            recipientEmail: 'grace@example.com',
        });
    });

    it('asks the Home for nothing when the replacement address is abandoned', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ recipientEmailMask: 'a•••@example.com' })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        modalChoice.press = 'teams.invitations.deliveryChangeEmail';
        modalChoice.promptAnswer = null;

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        expect(promptSpy).toHaveBeenCalled();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(0);
    });

    it('never offers Change email for a link invitation that has no recipient', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [teamInvitationRowFixture()], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });
        modalChoice.press = 'teams.invitations.deliveryChangeEmail';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        // The action was not offered, so choosing it selects nothing at all.
        expect(promptSpy).not.toHaveBeenCalled();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(0);
    });

    it('reissues a transferable link without asking for an address it never had', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [teamInvitationRowFixture()], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'invitation-2' }),
                joinUrl: 'https://home-a.example/join/token-2',
            },
        });
        modalChoice.press = 'teams.invitations.reissue';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        await waitForTestId(screen, 'team-invitations-fresh-copy-link');
        expect(promptSpy).not.toHaveBeenCalled();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)[0]?.input)
            .toMatchObject({ recipientEmail: null });
    });

    it('shows no link at all when the replacement bearer never reached this manager', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({ recipientEmailMask: 'a•••@example.com' })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({
                    id: 'invitation-2',
                    recipientEmailMask: 'a•••@example.com',
                    lastEmailDelivery: { status: 'sent', attemptedAt: 1_000_000_000_000 },
                }),
                joinUrl: null,
            },
        });
        modalChoice.press = 'teams.invitations.reissue';
        modalChoice.promptAnswer = 'ada@example.com';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');
        await screen.pressByTestIdAsync('team-invitations-row:invitation-1');

        await vi.waitFor(() => {
            expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(1);
        });
        // The bearer went only to the mail boundary. Rendering a copy control
        // over an absent link would be a false promise of a recoverable secret.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-invitations-fresh-copy-link');
    });

    it('does not offer a replacement for an accepted invitation', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: {
                items: [teamInvitationRowFixture({
                    state: 'accepted',
                    acceptedByAccountId: 'account-grace',
                })],
                nextCursor: null,
                emailDelivery: 'available',
                linkDelivery: 'available',
            },
        });
        modalChoice.press = 'teams.invitations.reissue';

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-row:invitation-1');

        // Reissuing a spent invitation would mint access for a person who has
        // already joined, so the row is informational rather than pressable.
        expect(screen.findHostByTestId('team-invitations-row:invitation-1')?.props.onPress).toBeUndefined();
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)).toHaveLength(0);
        expect(harness.requestsFor(INVITATION_REVOKE_PATH)).toHaveLength(0);
    });

    it('explains a viewer without invitation authority and reads no invitations', async () => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });

        const screen = await renderInvitations(serverId);
        await waitForTestId(screen, 'team-invitations-forbidden');

        expect(harness.requestsFor(INVITATIONS_LIST_PATH)).toHaveLength(0);
    });
});
