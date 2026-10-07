import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    accountDisplayProfileFixture,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamGroupFixture,
    teamMembershipFixture,
    withPopoverWebGlobals,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ShownModal = Readonly<{
    component: React.ComponentType<Record<string, unknown>>;
    props: Record<string, unknown>;
}>;

const shownModals = vi.hoisted(() => [] as ShownModal[]);
let restorePopoverWebGlobals: (() => void) | null = null;

installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (config) => {
                    shownModals.push(config as unknown as ShownModal);
                    return 'audience-picker';
                },
            },
        }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const MEMBERS_LIST_PATH = '/v1/teams/members/list';
const GROUPS_LIST_PATH = '/v1/teams/groups/list';

async function addHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-owner',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    return serverId;
}

async function renderOpenedPicker(serverId: string, excludedMemberIds: readonly string[] = []) {
    const { TeamCredentialAudiencePicker } = await import('./TeamCredentialAudiencePicker');
    const onChoose = vi.fn();
    const trigger = await renderScreen(
        <TeamCredentialAudiencePicker
            scope={{ serverId, accountId: 'account-owner' }}
            address={{ serverId, teamId: 'team-1' }}
            excludedGroupIds={[]}
            excludedMemberIds={excludedMemberIds}
            disabled={false}
            allowedKinds={['member']}
            onChoose={onChoose}
            testID="member-picker-trigger"
        />,
    );
    await trigger.pressByTestIdAsync('member-picker-trigger');
    const shown = shownModals.at(-1);
    if (!shown) throw new Error('audience_picker_not_opened');
    // The real Modal renderer injects its close port; the captured native modal does the same.
    const onClose = vi.fn();
    return { picker: await renderScreen(React.createElement(shown.component, { ...shown.props, onClose })), onChoose, onClose };
}

beforeEach(async () => {
    restorePopoverWebGlobals = withPopoverWebGlobals();
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    shownModals.length = 0;
});

afterEach(() => {
    standardCleanup();
    restorePopoverWebGlobals?.();
    restorePopoverWebGlobals = null;
});

describe('TeamCredentialAudiencePicker exact member mode', () => {
    it('keeps a failed member page retryable without querying or offering Groups', async () => {
        const serverId = await addHome();
        harness.answer(serverId, MEMBERS_LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture({ id: 'group-1', name: 'Must stay hidden' })], nextCursor: null },
        });

        const { picker } = await renderOpenedPicker(serverId);
        await vi.waitFor(() => expect(picker.findByTestId('team-credential-audience-picker:pagination:retry')).not.toBeNull());
        expect(harness.requestsFor(GROUPS_LIST_PATH)).toHaveLength(0);

        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-1',
                    accountId: 'account-ada',
                    account: accountDisplayProfileFixture('Ada'),
                })],
                nextCursor: null,
            },
        });
        await picker.pressByTestIdAsync('team-credential-audience-picker:pagination:retry');
        await vi.waitFor(() => expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(2));
        const { SelectionList } = await import('@/components/ui/selectionList');
        let option: { testID?: string } | undefined;
        await vi.waitFor(() => {
            option = picker.findByType(SelectionList).props.rootStep.sections[0]?.options?.find(
                (candidate: { testID?: string }) => candidate.testID === 'team-credential-audience-pick-member:membership-1',
            );
            expect(option).toBeDefined();
        });
    });

    it('continues the exact member directory through its canonical cursor owner', async () => {
        const serverId = await addHome();
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-1',
                    accountId: 'account-ada',
                    account: accountDisplayProfileFixture('Ada'),
                })],
                nextCursor: 'members-next',
            },
        });

        const { picker, onChoose, onClose } = await renderOpenedPicker(serverId, ['membership-1']);
        await vi.waitFor(() => expect(picker.findByTestId('team-credential-audience-picker:pagination:more')).not.toBeNull());
        expect(picker.findByTestId('team-credential-audience-pick-member:membership-1')).toBeNull();
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-2',
                    accountId: 'account-grace',
                    account: accountDisplayProfileFixture('Grace'),
                })],
                nextCursor: null,
            },
        });
        await picker.pressByTestIdAsync('team-credential-audience-picker:pagination:more');
        await vi.waitFor(() => expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(2));
        const { SelectionList } = await import('@/components/ui/selectionList');
        let option: { testID?: string; onSelect?: () => void } | undefined;
        await vi.waitFor(() => {
            option = picker.findByType(SelectionList).props.rootStep.sections[0]?.options?.find(
                (candidate: { testID?: string }) => candidate.testID === 'team-credential-audience-pick-member:membership-2',
            );
            expect(option).toBeDefined();
        });
        expect(harness.requestsFor(MEMBERS_LIST_PATH).at(-1)?.input).toMatchObject({ cursor: 'members-next' });
        option?.onSelect?.();
        expect(onClose).toHaveBeenCalledOnce();
        expect(onChoose).toHaveBeenCalledWith({
            kind: 'member', id: 'membership-2', accountId: 'account-grace', name: 'Grace',
        });
    });
});
