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

const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async () => true));
const shareTextSafeMock = vi.hoisted(() => vi.fn(async () => 'shared' as const));
const sharingAvailableMock = vi.hoisted(() => ({ current: true }));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

// The clipboard and the share sheet are the two genuine platform boundaries on
// this screen; everything below them — the Action transport, the strict result
// schemas and the confined-bearer rules — stays real.
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: setClipboardStringSafeMock }));
vi.mock('@/utils/ui/shareText', () => ({
    isTextSharingAvailable: () => sharingAvailableMock.current,
    shareTextSafe: shareTextSafeMock,
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const INVITATION_CREATE_PATH = '/v1/teams/invitations/create';
const INVITATION_REISSUE_PATH = '/v1/teams/invitations/reissue';
const INVITATION_LIST_PATH = '/v1/teams/invitations/list';

async function renderCreateScreen(serverId: string) {
    // The form has no page of its own: it mounts inside the Team shell, as the Invite people dialog mounts it.
    const { TeamInvitationForm } = await import('./TeamInvitationCreateScreen');
    const { TeamSection } = await import('../TeamSection');
    return renderScreen(
        <TeamSection serverId={serverId} teamId="team-1">
            {(context) => <TeamInvitationForm context={context} />}
        </TeamSection>,
    );
}

async function addManagedHome(
    emailDelivery: 'available' | 'unavailable' = 'available',
    linkDelivery: 'available' | 'unavailable' = 'available',
): Promise<string> {
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
    // The sheet asks this exact Home whether it can mail an invitation; it has
    // no other way to know, and it renders no rows from the answer.
    harness.answer(serverId, INVITATION_LIST_PATH, {
        body: { items: [], nextCursor: null, emailDelivery, linkDelivery },
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderCreateScreen>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    setClipboardStringSafeMock.mockReset();
    setClipboardStringSafeMock.mockResolvedValue(true);
    shareTextSafeMock.mockReset();
    shareTextSafeMock.mockResolvedValue('shared');
    sharingAvailableMock.current = true;
});

afterEach(() => {
    standardCleanup();
});

describe('TeamInvitationCreateScreen', () => {
    it('starts only one invitation creation when activated twice before the busy state renders', async () => {
        let releaseCreate = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseCreate = resolve; });
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture(),
                joinUrl: 'https://home-a.example/join/token-1',
            },
            respondAfter,
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        act(() => {
            screen.pressByTestId('team-invite-submit');
            screen.pressByTestId('team-invite-submit');
        });

        await vi.waitFor(() => expect(harness.requestsFor(INVITATION_CREATE_PATH)).toHaveLength(1));
        await act(async () => releaseCreate());
    });

    it('exposes delivery and role choices as labeled radio groups with checked state', async () => {
        const serverId = await addManagedHome();

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-delivery:link');

        const selectedChoices = [
            ['team-invite-delivery:link', 'teams.invitations.inviteTitle(team=Platform)'],
            ['team-invite-role:member', 'teams.members.roleLabel'],
        ] as const;

        for (const [testID, groupLabel] of selectedChoices) {
            const selected = screen.findByTestId(testID);
            expect([selected?.props.accessibilityRole, selected?.props.role]).toContain('radio');
            expect(selected?.props.accessibilityState).toMatchObject({ checked: true });

            let ancestor = selected?.parent ?? null;
            while (ancestor
                && ancestor.props.accessibilityRole !== 'radiogroup'
                && ancestor.props.role !== 'radiogroup') {
                ancestor = ancestor.parent;
            }
            expect(ancestor).not.toBeNull();
            expect(ancestor?.props.accessibilityLabel ?? ancestor?.props['aria-label']).toBe(groupLabel);
        }
    });

    it('states what a transferable link gives away before the bearer is minted', async () => {
        const serverId = await addManagedHome();

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');

        // The consequence belongs beside the button that creates the secret,
        // not only on the screen that already hands it over.
        expect(screen.getTextContent())
            .toContain('teams.invitations.linkNotice(team=Platform,role=teams.role.member)');
        expect(harness.requestsFor(INVITATION_CREATE_PATH)).toHaveLength(0);
    });

    it('says there is no shareable link at all, before and after creating, when this Home publishes no join target', async () => {
        const serverId = await addManagedHome('unavailable', 'unavailable');
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: { invitation: teamInvitationRowFixture(), joinUrl: null },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-link-unavailable-notice');

        // "Share a link instead" is false here: there is no link to share.
        expect(screen.getTextContent()).not.toContain('teams.invitations.emailUnavailable');
        expect(screen.getTextContent()).toContain('teams.invitations.linkUnavailableRow');
        expect(screen.getTextContent()).toContain('teams.invitations.linkUnavailableBody');

        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-link-unavailable');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // Reissuing cannot produce a link this Home is unable to render, so the
        // "shown once, create a new one" story is not told here.
        expect(ids).not.toContain('team-invite-create-new-link');
        expect(ids).not.toContain('team-invite-bearer-unavailable');
        expect(screen.getTextContent()).not.toContain('teams.invitations.bearerUnavailable');
        expect(screen.getTextContent()).toContain('teams.invitations.linkUnavailableBody');
    });

    it('says why Email is absent when this Home answered that it cannot mail', async () => {
        const serverId = await addManagedHome('unavailable');

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-delivery-link-only');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // No chooser with one option, and no silent disappearance either.
        expect(ids).not.toContain('team-invite-delivery:email');
        expect(screen.getTextContent()).toContain('teams.invitations.emailUnavailable');
    });

    it('offers copy, share and a QR for the one confined link delivery', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture(),
                joinUrl: 'https://home-a.example/join/token-1',
            },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-copy-link');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-invite-share-link');
        expect(ids).toContain('team-invite-qr');

        await screen.pressByTestIdAsync('team-invite-share-link');
        // The exact minted URL, not a rebuilt one: a link the manager hands over
        // must be the bearer the Home actually issued.
        expect(shareTextSafeMock).toHaveBeenCalledWith('https://home-a.example/join/token-1');
        await screen.pressByTestIdAsync('team-invite-copy-link');
        expect(setClipboardStringSafeMock).toHaveBeenCalledWith('https://home-a.example/join/token-1');
    });

    it('falls back to the usable link when the encoder refuses the QR', async () => {
        const serverId = await addManagedHome();
        // Well past any QR version's capacity. The encoder owns that limit, so
        // this must degrade to the copyable link rather than throwing out of
        // the success state the manager is standing in.
        const oversized = `https://home-a.example/join/${'t'.repeat(6000)}`;
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: { invitation: teamInvitationRowFixture(), joinUrl: oversized },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-qr-too-large');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-invite-qr');
        // The link itself is still deliverable; only its scannable form is not.
        expect(ids).toContain('team-invite-copy-link');
    });

    it('hides sharing rather than offering a control the platform cannot honour', async () => {
        sharingAvailableMock.current = false;
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture(),
                joinUrl: 'https://home-a.example/join/token-1',
            },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-copy-link');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-invite-share-link');
    });

    it('retries a failed email through atomic reissue without exposing its bearer', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture({
                    recipientEmailMask: 'a•••@example.com',
                    lastEmailDelivery: { status: 'failed', attemptedAt: 1_000_000_000_000 },
                }),
                joinUrl: null,
            },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        // The address field only exists once email delivery is selected, so
        // that choice has to be committed before it can be typed into.
        act(() => screen.pressByTestId('team-invite-delivery:email'));
        act(() => screen.changeTextByTestId('team-invite-email', 'ada@example.com'));
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-delivery-failed');

        let ids = collectRenderedTestIds(screen.tree.toJSON());
        // A failed submission is said to have failed; a missing link never
        // reads as a delivered email, and an email-bound invitation never
        // shows the manager a bearer or its QR.
        expect(ids).not.toContain('team-invite-delivery-sent');
        expect(ids).not.toContain('team-invite-copy-link');
        expect(ids).not.toContain('team-invite-share-link');
        expect(ids).not.toContain('team-invite-qr');
        expect(ids).toContain('team-invite-retry-delivery');
        expect(ids).not.toContain('team-invite-create-new-link');

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
        await screen.pressByTestIdAsync('team-invite-retry-delivery');
        await waitForTestId(screen, 'team-invite-delivery-sent');

        expect(harness.requestsFor(INVITATION_REISSUE_PATH)[0]?.input).toMatchObject({
            invitationId: 'invitation-1',
            recipientEmail: null,
        });
        ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-invite-retry-delivery');
        expect(ids).not.toContain('team-invite-bearer-unavailable');
    });

    it('reports successful email delivery without pretending its intentionally withheld bearer was lost', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture({
                    recipientEmailMask: 'a•••@example.com',
                    lastEmailDelivery: { status: 'sent', attemptedAt: 1_000_000_000_000 },
                }),
                joinUrl: null,
            },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        act(() => screen.pressByTestId('team-invite-delivery:email'));
        act(() => screen.changeTextByTestId('team-invite-email', 'ada@example.com'));
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-delivery-sent');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-invite-bearer-unavailable');
        expect(ids).not.toContain('team-invite-create-new-link');
        expect(ids).not.toContain('team-invite-retry-delivery');
        expect(ids).not.toContain('team-invite-copy-link');
    });

    it('keeps one reissue identity while retrying a lost email-delivery response', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture({
                    recipientEmailMask: 'a•••@example.com',
                    lastEmailDelivery: { status: 'failed', attemptedAt: 1_000_000_000_000 },
                }),
                joinUrl: null,
            },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        act(() => screen.pressByTestId('team-invite-delivery:email'));
        act(() => screen.changeTextByTestId('team-invite-email', 'ada@example.com'));
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-retry-delivery');

        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            status: 503,
            body: { error: 'unavailable' },
        });
        await screen.pressByTestIdAsync('team-invite-retry-delivery');

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
        await screen.pressByTestIdAsync('team-invite-retry-delivery');
        await waitForTestId(screen, 'team-invite-delivery-sent');

        const retries = harness.requestsFor(INVITATION_REISSUE_PATH);
        expect(retries).toHaveLength(2);
        expect((retries[0]?.input as { requestKey?: string }).requestKey).toBeTruthy();
        expect((retries[1]?.input as { requestKey?: string }).requestKey)
            .toBe((retries[0]?.input as { requestKey?: string }).requestKey);
    });

    it('reissues an unrecoverable bearer atomically instead of leaving two live invitations', async () => {
        const serverId = await addManagedHome();
        // A redacted automated result: the invitation exists, the link does not.
        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: { invitation: teamInvitationRowFixture(), joinUrl: null },
        });

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-bearer-unavailable');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-invite-copy-link');
        expect(ids).toContain('team-invite-create-new-link');

        harness.answer(serverId, INVITATION_REISSUE_PATH, {
            body: {
                previous: teamInvitationRowFixture({ state: 'revoked' }),
                replacement: teamInvitationRowFixture({ id: 'invitation-2' }),
                joinUrl: 'https://home-a.example/join/token-2',
            },
        });
        await screen.pressByTestIdAsync('team-invite-create-new-link');
        await waitForTestId(screen, 'team-invite-copy-link');

        expect(harness.requestsFor(INVITATION_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(INVITATION_REISSUE_PATH)[0]?.input).toMatchObject({
            invitationId: 'invitation-1',
            recipientEmail: null,
        });
    });

    it('withholds the Team history choice for a guest instead of promising access', async () => {
        const serverId = await addManagedHome();

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-history:from_membership');

        act(() => screen.pressByTestId('team-invite-role:guest'));
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .not.toContain('team-invite-history:from_membership');
        });

        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture({ role: 'guest' }),
                joinUrl: 'https://home-a.example/join/token-1',
            },
        });
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-copy-link');

        expect(harness.requestsFor(INVITATION_CREATE_PATH)[0]?.input).toMatchObject({
            role: 'guest',
            historyAccess: 'from_membership',
        });
    });

    it('offers Email only while the Home says it can currently deliver it', async () => {
        const serverId = await addManagedHome('unavailable');

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-submit');
        await vi.waitFor(() => {
            expect(harness.requestsFor(INVITATION_LIST_PATH).length).toBeGreaterThan(0);
        });

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // No mail boundary means one honest way to invite, so the chooser and the
        // address field both go rather than leaving a control the Home refuses.
        expect(ids).not.toContain('team-invite-delivery:email');
        expect(ids).not.toContain('team-invite-delivery:link');
        expect(ids).not.toContain('team-invite-email');
        // The transferable link is the part that must survive: it is unaffected
        // by mail and is exactly what the manager falls back to.
        expect(ids).toContain('team-invite-submit');

        harness.answer(serverId, INVITATION_CREATE_PATH, {
            body: {
                invitation: teamInvitationRowFixture(),
                joinUrl: 'https://home-a.example/join/token-1',
            },
        });
        await screen.pressByTestIdAsync('team-invite-submit');
        await waitForTestId(screen, 'team-invite-copy-link');
        // A sheet that cannot mail must not submit a recipient it never collected.
        expect(harness.requestsFor(INVITATION_CREATE_PATH)[0]?.input)
            .toMatchObject({ recipientEmail: null });
    });

    it('asks for the smallest page because it wants the answer, not the roster', async () => {
        const serverId = await addManagedHome();

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-delivery:email');

        // The sheet renders no invitation rows, so paying for fifty of them to
        // learn one Home fact would be waste the manager waits on.
        expect(harness.requestsFor(INVITATION_LIST_PATH)[0]?.input)
            .toMatchObject({ limit: 1 });
    });

    it('explains a viewer without invitation authority and asks the Home for nothing', async () => {
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

        const screen = await renderCreateScreen(serverId);
        await waitForTestId(screen, 'team-invite-forbidden');

        expect(harness.requestsFor(INVITATION_CREATE_PATH)).toHaveLength(0);
        // A viewer with no invitation authority asks nothing at all — including
        // the delivery question, which is only answered for a manager.
        expect(harness.requestsFor(INVITATION_LIST_PATH)).toHaveLength(0);
    });
});
