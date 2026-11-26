import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep this shell test independent from unrelated generated plugin artifacts.
// These are the same canonical testkit owners re-exported by `@/dev/testkit`,
// imported from their owning modules because the Home boundaries are installed
// with `vi.doMock` (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { TeamSectionContext } from './teamSectionContext';

/**
 * The approval shell of a Team section, over the real approval lifecycle.
 *
 * Credential binding, Team projection and refresh run through the real owners.
 * The approval is real end to end — a
 * present-user Team mutation creates it through the shared Action front door,
 * the Inbox decides it through the generic executor, and the section reads the
 * outcome through the real `useApprovalArtifact` over the Home's stateful
 * Artifact store. No terminal record is written by hand.
 */

// The package Vitest config supplies the canonical empty app-asset boundary.
// Artifact sources, availability readers and stores stay real.

installSettingsViewCommonModuleMocks({
    router: async () => ({
        ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    }),
    // The real client store: the approval writer publishes the settled
    // Artifact into it and the mounted approval reader observes it there.
    storage: 'real',
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ACCOUNT_ID = 'account-a';
const TEAM_UPDATE_PATH = '/v1/teams/update';
const TEAM_GET_PATH = '/v1/teams/get';

/** One Team Home whose Account requires approval for a Team rename. */
async function addTeamHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home One',
        serverUrl: 'https://team-section.example',
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
    });
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
    });
    await harness.requireUiApproval(serverId, 'teams.update');
    return serverId;
}

/** The open approval a present-user Team rename leaves on its Home. */
async function openTeamRenameApproval(serverId: string, requestId: string): Promise<string> {
    return await createUiApprovalRequest({
        serverId,
        actionId: 'teams.update',
        actionInput: { v: 1, teamId: 'team-1', name: 'Renamed' },
        actionRequestId: requestId,
    });
}

let nextMountId = 0;
const renderedContexts: TeamSectionContext[] = [];
// Collect the real module after installing Home boundaries, outside fixture deadlines.
const { TeamSection } = await import('./TeamSection');

function ChildProbe(props: Readonly<{ context: TeamSectionContext }>) {
    const [mountId] = React.useState(() => ++nextMountId);
    renderedContexts.push(props.context);
    return React.createElement('TeamSectionProbe', {
        testID: 'team-section-child-probe',
        mountId,
        accountId: props.context.scope.accountId,
    });
}

describe('TeamSection Account binding', () => {
    afterAll(() => {
        standardCleanup();
    });

    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
        const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
        const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
        resetTeamsDirectoryEngineForTests();
        resetTeamsSnapshotsForTests();
        renderedContexts.length = 0;
        nextMountId = 0;
    });

    afterEach(() => standardCleanup());

    // One message per state: a Team this link cannot open (stale, malformed, or not the viewer's) says so in its
    // title and leads to Teams; only a real role refusal says the role does not include it.
    it('publishes only its visible approval navigation and retires the address after settlement', async () => {
        const serverId = await addTeamHome();
        await harness.switchAccount(serverId, ACCOUNT_ID, { currentAccount: true });
        await harness.selectHomes([serverId]);
        const home = harness.findByServerUrl('https://team-section.example');
        if (!home?.token) throw new Error('Expected the Team Home credentials');
        const { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } =
            await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        installDisconnectedServerSocketBoundary();
        const connection = await restoreServerAccountForTest({
            serverUrl: home.serverUrl, accountId: ACCOUNT_ID, credentials: { token: home.token },
            request: (input, init) => harness.request(input, init),
        });
        try {
            const artifactId = await openTeamRenameApproval(serverId, 'team-mounted-review');
            const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
            const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
            const { usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const { CurrentUiContextSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui/currentUiContext');
            const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
            const { router } = await import('expo-router');
            const { t } = await import('@/text');
            function Publication() {
                const commands = useCurrentUiContextComposedCommands();
                const enrichment = React.useMemo(() => ({ commands }), [commands]);
                usePublishCurrentUiContext(enrichment);
                return null;
            }
            const screen = await renderMountedCurrentUiContext(
                <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
                    <Publication />
                    <TeamSection serverId={serverId} teamId="team-1">
                        {(context) => <ChildProbe context={context} />}
                    </TeamSection>
                </CurrentUiContextCommandsProvider>,
            );
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-section-child-probe')).not.toBeNull());
            await act(async () => renderedContexts.at(-1)!.requestApproval(artifactId));
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-approval')).not.toBeNull());
            const executor = createDefaultActionExecutor();
            const commands = async () => {
                const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
                if (!read.ok) throw new Error('Expected Team approval context');
                return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
            };
            const inventory = await commands();
            expect(inventory.map(command => command.title)).toEqual([t('approvals.details')]);
            const review = inventory[0]!;
            vi.mocked(router.push).mockClear();
            const path = `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}`;
            await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
                { commandId: review.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
            expect(router.push).toHaveBeenLastCalledWith(path);
            const banner = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'team-approval')!;
            await act(async () => banner.props.action.onPress());
            expect(router.push).toHaveBeenCalledTimes(2);
            expect(router.push).toHaveBeenLastCalledWith(path);
            expect(harness.requestsFor(TEAM_UPDATE_PATH)).toEqual([]);
            await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-approval')).toBeNull());
            expect(await commands()).toEqual([]);
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: review.id }, { surface: 'agent' }))
                .toMatchObject({ ok: false });
            expect(router.push).toHaveBeenCalledTimes(2);
            await screen.unmount();
        } finally { await connection.dispose(); }
    });

    it.each([
        { status: 400, code: 'invalid_team_input', title: 'teams.errors.notFound', message: 'teams.errors.invalidTeamLink', action: 'teams.title' },
        { status: 404, code: 'team_not_found', title: 'teams.errors.notFound', message: null, action: 'teams.title' },
        { status: 403, code: 'team_forbidden', title: 'teams.denied.title', message: 'errors.permissionDenied', action: null },
        { status: 404, code: 'teams_unavailable', title: 'teams.unavailable.title', message: 'teams.unavailable.disabled', action: null },
        { status: 503, code: 'team_authentication_unavailable', title: 'teams.unavailable.title', message: 'teams.credentials.externalApi.authenticationUnavailable', action: null },
        { status: 503, code: null, title: 'teams.unavailable.title', message: 'teams.errors.loadFailed', action: 'teams.unavailable.retry' },
    ])('presents the Team read refusal $code with only a working next step', async ({ status, code, title, message, action }) => {
        const serverId = await addTeamHome();
        harness.answer(serverId, TEAM_GET_PATH, { status, body: code ? { error: code } : {} });
        const screen = await renderScreen(<TeamSection serverId={serverId} teamId="team-1">
            {(context) => <ChildProbe context={context} />}
        </TeamSection>);

        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const findNotice = () => screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'team-unavailable');
        await waitForHomeGovernance(() => expect(findNotice()).toBeDefined());
        expect(findNotice()?.props.title).toBe(title);
        expect(findNotice()?.props.reason ?? null).toBe(message);
        expect(findNotice()?.props.action?.label ?? null).toBe(action);
        expect(screen.findByTestId('team-section-child-probe')).toBeNull();
    });

    it('remounts section-local state and rejects a stale approval registration after AccountChange', async () => {
        const serverId = await addTeamHome();
        const staleArtifactId = await openTeamRenameApproval(serverId, 'team-rename-stale');
        const renderSection = (title: string) => (
            <TeamSection serverId={serverId} teamId="team-1" title={title}>
                {(context) => <ChildProbe context={context} />}
            </TeamSection>
        );
        const screen = await renderScreen(renderSection('Team A'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-section-child-probe')).not.toBeNull());
        const firstMountId = screen.findByTestId('team-section-child-probe')?.props.mountId;
        const staleRequestApproval = renderedContexts.at(-1)!.requestApproval;

        await act(async () => {
            await harness.switchAccount(serverId, 'account-b');
            await screen.update(renderSection('Team B'));
        });

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-section-child-probe')?.props.accountId).toBe('account-b'));
        expect(screen.findByTestId('team-section-child-probe')?.props.mountId).not.toBe(firstMountId);

        // A genuinely open approval begun as the previous Account must not be
        // handed to the Account now bound to this Team.
        await act(async () => staleRequestApproval(staleArtifactId));
        expect(screen.findByTestId('team-approval')).toBeNull();
    });

    it.each([
        {
            status: 'rejected' as const,
            decision: 'reject' as const,
            homeAnswer: null,
        },
        {
            // The Home refuses the replayed rename, so execution settles failed.
            status: 'failed' as const,
            decision: 'approve' as const,
            homeAnswer: { status: 409, body: { error: 'team_archived' } },
        },
    ])(
        'releases a $status approval without refreshing or redispatching the Team mutation',
        async ({ status, decision, homeAnswer }) => {
            const serverId = await addTeamHome();
            if (homeAnswer) harness.answer(serverId, TEAM_UPDATE_PATH, homeAnswer);
            const artifactId = await openTeamRenameApproval(serverId, `team-rename-${status}`);
            const screen = await renderScreen(
                <TeamSection serverId={serverId} teamId="team-1">
                    {(context) => <ChildProbe context={context} />}
                </TeamSection>,
            );
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-section-child-probe')).not.toBeNull());
            const initialReads = harness.requestsFor(TEAM_GET_PATH).length;
            const onTerminal = vi.fn();

            await act(async () => renderedContexts.at(-1)!.requestApproval({
                artifactId,
                onExecuted: vi.fn(async () => 'consumed' as const),
                onTerminal,
            }));
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-approval')).not.toBeNull());
            expect(renderedContexts.at(-1)!.canMutate).toBe(false);

            // Decided in the Inbox, not here: the section learns the outcome
            // only through the shared approval reader.
            await expect(decideApprovalAsInbox(serverId, artifactId, decision)).resolves.toMatchObject({ ok: true });

            await waitForHomeGovernance(() => expect(screen.findByTestId('team-approval')).toBeNull());
            expect(onTerminal).toHaveBeenCalledOnce();
            expect(onTerminal).toHaveBeenCalledWith(status, expect.objectContaining({ id: artifactId }));
            expect(renderedContexts.at(-1)!.approvalPending).toBe(false);
            expect(renderedContexts.at(-1)!.canMutate).toBe(true);
            expect(harness.requestsFor(TEAM_GET_PATH)).toHaveLength(initialReads);
            // The only Team mutation is the Inbox's own replay, if it approved.
            expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(decision === 'approve' ? 1 : 0);
        },
    );

    it('refreshes the exact Team and delivers its typed continuation exactly once after execution', async () => {
        const serverId = await addTeamHome();
        harness.answer(serverId, TEAM_UPDATE_PATH, {
            body: teamSummaryFixture({ name: 'Renamed', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
        });
        const artifactId = await openTeamRenameApproval(serverId, 'team-rename-executed');
        const renderSection = () => (
            <TeamSection serverId={serverId} teamId="team-1">
                {(context) => <ChildProbe context={context} />}
            </TeamSection>
        );
        const screen = await renderScreen(renderSection());
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-section-child-probe')).not.toBeNull());
        const initialReads = harness.requestsFor(TEAM_GET_PATH).length;
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ name: 'Renamed', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
        });
        const onExecuted = vi.fn(async () => 'consumed' as const);

        await act(async () => renderedContexts.at(-1)!.requestApproval({
            artifactId,
            onExecuted,
        }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-approval')).not.toBeNull());
        expect(renderedContexts.at(-1)!.canMutate).toBe(false);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await waitForHomeGovernance(() => expect(onExecuted).toHaveBeenCalledOnce());
        expect(onExecuted).toHaveBeenCalledWith(expect.objectContaining({ id: artifactId }));
        await waitForHomeGovernance(() => expect(renderedContexts.at(-1)!.team.name).toBe('Renamed'));
        expect(harness.requestsFor(TEAM_GET_PATH)).toHaveLength(initialReads + 1);
        const refreshRequest = harness.requestsFor(TEAM_GET_PATH).at(-1);
        expect({ serverId: refreshRequest?.serverId, input: refreshRequest?.input }).toMatchObject({ serverId, input: { teamId: 'team-1' } });
        expect(screen.findByTestId('team-approval')).toBeNull();
        expect(renderedContexts.at(-1)!.approvalPending).toBe(false);
        expect(renderedContexts.at(-1)!.canMutate).toBe(true);

        await screen.update(renderSection());
        expect(onExecuted).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(TEAM_GET_PATH)).toHaveLength(initialReads + 1);
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
    });
});
