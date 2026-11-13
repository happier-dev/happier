import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountDisplayProfileFixture, renderScreen, standardCleanup, teamGroupFixture, teamMembershipFixture, withPopoverWebGlobals } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ShownModal = Readonly<{
    component: React.ComponentType<Record<string, unknown>>;
    props: Record<string, unknown>;
    chrome?: Readonly<{ anchor?: unknown; phonePresentation?: string; title?: string }>;
}>;

const shownModals = vi.hoisted(() => [] as ShownModal[]);
let restorePopoverWebGlobals: (() => void) | null = null;

// The third-party virtualizer needs measured native rows; render them at this boundary in source tests.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});

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
const { TeamCredentialAudiencePicker } = await import('./TeamCredentialAudiencePicker');

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

async function renderOpenedPicker(serverId: string, excludedMemberIds: readonly string[] = [], allowedKinds: readonly ('member' | 'group')[] = ['member']) {
    const onChoose = vi.fn();
    const trigger = await renderScreen(
        <TeamCredentialAudiencePicker
            scope={{ serverId, accountId: 'account-owner' }}
            address={{ serverId, teamId: 'team-1' }}
            excludedGroupIds={[]}
            excludedMemberIds={excludedMemberIds}
            disabled={false}
            allowedKinds={allowedKinds}
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
    it('keeps searched member and Group sources loading until their directory answers arrive', async () => {
        const serverId = await addHome();
        let release!: () => void;
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        harness.answer(serverId, MEMBERS_LIST_PATH, { respondAfter, body: {
            items: [teamMembershipFixture({ id: 'membership-ada', accountId: 'account-ada', account: accountDisplayProfileFixture('Ada') })], nextCursor: null,
        } });
        harness.answer(serverId, GROUPS_LIST_PATH, { respondAfter, body: {
            items: [teamGroupFixture({ id: 'group-ada', name: 'Ada group' })], nextCursor: null,
        } });
        const { picker } = await renderOpenedPicker(serverId, [], ['member', 'group']);
        try {
            await act(async () => { picker.changeTextByTestId('team-credential-audience-picker:header:input', 'Ada'); });
            await vi.waitFor(() => expect(harness.requestsFor(GROUPS_LIST_PATH)).toHaveLength(1));
            const { t } = await import('@/text');
            expect(picker.findByTestId('team-credential-audience-picker:status')?.props.role).toBe('status');
            expect(picker.getTextContent()).toContain(t('common.loading'));
            expect(picker.getTextContent()).not.toContain(t('common.noMatches'));
        } finally {
            await act(async () => { release(); });
        }
        await vi.waitFor(() => {
            expect(picker.findByTestId('team-credential-audience-pick-member:membership-ada')).not.toBeNull();
            expect(picker.findByTestId('team-credential-audience-pick-group:group-ada')).not.toBeNull();
        });
    });

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
        await vi.waitFor(() => {
            expect(picker.findByTestId('team-credential-audience-pick-member:membership-1')).not.toBeNull();
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
        await vi.waitFor(() => {
            expect(picker.findByTestId('team-credential-audience-pick-member:membership-2')).not.toBeNull();
        });
        expect(harness.requestsFor(MEMBERS_LIST_PATH).at(-1)?.input).toMatchObject({ cursor: 'members-next' });
        await picker.pressByTestIdAsync('team-credential-audience-pick-member:membership-2');
        expect(onClose).toHaveBeenCalledOnce();
        expect(onChoose).toHaveBeenCalledWith({
            kind: 'member', id: 'membership-2', accountId: 'account-grace', name: 'Grace',
        });
    });
});

describe('TeamCredentialAudiencePicker presentation', () => {
    it('opens as the shared share sheet, hanging from the row that opened it (a bottom sheet on a phone)', async () => {
        const serverId = await addHome();
        const trigger = await renderScreen(
            <TeamCredentialAudiencePicker
                scope={{ serverId, accountId: 'account-owner' }}
                address={{ serverId, teamId: 'team-1' }}
                excludedGroupIds={[]}
                excludedMemberIds={[]}
                disabled={false}
                label="Add people or Groups"
                onChoose={vi.fn()}
                testID="audience-trigger"
            />,
        );
        // The press event's target is the row the person pressed (the platform's measurable host).
        const row = { getBoundingClientRect: () => ({ x: 900, y: 40, width: 280, height: 44 }) };
        const { act } = await import('react-test-renderer');
        const pressable = trigger.findAll(node => node.props?.testID === 'audience-trigger' && typeof node.props?.onPress === 'function')[0]!;
        await act(async () => { pressable.props.onPress({ currentTarget: row }); });
        const shown = shownModals.at(-1);
        expect(shown?.chrome).toMatchObject({ title: 'Add people or Groups', phonePresentation: 'sheet' });
        expect(shown?.chrome?.anchor).toMatchObject({ kind: 'view', ref: { current: row } });
    });
});
