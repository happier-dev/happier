import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema} from '@happier-dev/protocol/providers/ids';
import { type MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';

import { collectRenderedTestIds, createDeferred, renderScreen, standardCleanup, teamCredentialResourceFixture, teamCredentialSourceResourceFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const CONNECTION_ID = ProviderConnectionIdSchema.parse('connection-1');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const confirm = vi.hoisted(() => vi.fn(async () => false));
installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm } }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createMachineAdministrationTargetSelectionMock, installMachineAdministrationTargetSelectionBoundary } = await import('@/dev/testkit/mocks/machineAdministrationTargetSelection');
const machineSelection = createMachineAdministrationTargetSelectionMock({
    serverId: 'server-a',
    machines: [{ machineId: 'machine-exact', displayName: 'Exact broker' }],
    selectedMachineId: null,
});
installMachineAdministrationTargetSelectionBoundary(machineSelection);

const poolProjection = vi.hoisted(() => ({ pools: [] as MachinePoolViewV1[] }));
vi.mock('@/sync/engine/machines/useMachinePoolProjections', () => ({
    useMachinePoolProjections: () => [{
        serverId: 'server-a', accountId: 'owner', featureStatus: 'enabled', featureEnabled: true,
        pools: poolProjection.pools, status: 'idle', ready: true,
    }],
}));

const LIST_PATH = '/v1/teams/credential-resources/source-resources/list';
const UPDATE_PATH = '/v1/teams/credential-resources/update';

function selectBrokerMachine(
    screen: Readonly<{ findByType: (type: string) => ReactTestInstance }>,
    machineId: string,
): void {
    const selection = screen.findByType('MachineAdministrationTargetSelector').props.selection;
    const row = selection.pickerRows.find((candidateRow: { candidate: { target: { machineId: string } } }) => (
        candidateRow.candidate.target.machineId === machineId
    ));
    if (!row) throw new Error(`missing broker Machine ${machineId}`);
    act(() => selection.selectTarget(row.candidate.target));
}

type RowScreen = Awaited<ReturnType<typeof renderScreen>>;
/** Opens a row's ⋯ menu (where its actions live) unless it is already open. */
async function openRowMenu(screen: RowScreen, rowId: string): Promise<void> {
    await vi.waitFor(() => expect(screen.findByTestId(`shared-with-teams:more:${rowId}`), screen.getTextContent()).not.toBeNull());
    // The trigger says whether its menu is open; a closing menu can keep its last items on screen.
    const open = screen.findAllByTestId(`shared-with-teams:more:${rowId}`)
        .some((node) => node.props.accessibilityState?.expanded === true);
    if (!open) await screen.pressByTestIdAsync(`shared-with-teams:more:${rowId}`);
}
/** Whether a ⋯ menu action is shown unavailable (its row's write is still settling or held). */
function menuActionDisabled(screen: RowScreen, testID: string): boolean {
    return screen.findAllByTestId(testID).some((node) => node.props.disabled === true);
}
/** Opens the row's ⋯ menu and expects that action to be shown unavailable. */
async function expectMenuActionDisabled(screen: RowScreen, rowId: string, action: string): Promise<void> {
    await openRowMenu(screen, rowId);
    await vi.waitFor(() => expect(menuActionDisabled(screen, `shared-with-teams:${action}:${rowId}`)).toBe(true));
}
/** Chooses one action from a row's ⋯ menu. */
async function pressRowAction(screen: RowScreen, rowId: string, action: string): Promise<void> {
    await openRowMenu(screen, rowId);
    await vi.waitFor(() => expect(screen.findByTestId(`shared-with-teams:${action}:${rowId}`)).not.toBeNull());
    await screen.pressByTestIdAsync(`shared-with-teams:${action}:${rowId}`);
    // The menu closes first, then runs the action.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

// The component and its menu's Popover load once before the per-test budget starts.
beforeAll(async () => { await import('./SharedWithTeamsSourceAdministration'); }, 300_000);
// A row's ⋯ menu opens in a Popover, which measures against the web window.
let restorePopoverGlobals: (() => void) | null = null;
afterEach(() => { restorePopoverGlobals?.(); restorePopoverGlobals = null; });
beforeEach(async () => {
    restorePopoverGlobals = withPopoverWebGlobals();
    poolProjection.pools = [];
    machineSelection.controller.reset();
    confirm.mockReset();
    confirm.mockResolvedValue(false);
    await harness.reset();
    await harness.selectHomes([]);
});
afterEach(standardCleanup);

describe('SharedWithTeamsSourceAdministration', () => {
    it('reads readiness once across equal parent renders and re-reads a changed source', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const row = teamCredentialSourceResourceFixture();
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const render = (connectionId = CONNECTION_ID) => <SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId }}
        />;
        const screen = await renderScreen(render());
        await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH)).toHaveLength(1));
        // A minute of unrelated parent updates must not become readiness polling.
        for (let second = 0; second < 60; second++) await screen.update(render());
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        await screen.update(render(ProviderConnectionIdSchema.parse('connection-2')));
        await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH)).toHaveLength(2));
        expect(harness.requestsFor(LIST_PATH)[1]?.input).toMatchObject({
            source: { kind: 'provider_connection', connectionId: 'connection-2' },
        });
    });

    it.each([
        { operation: 'narrow', refreshFails: false },
        { operation: 'delete', refreshFails: false },
        { operation: 'narrow', refreshFails: true },
        { operation: 'delete', refreshFails: true },
    ] as const)('settles acknowledged $operation with retained rows read-only (refreshFails=$refreshFails)', async ({ operation, refreshFails }) => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const row = teamCredentialSourceResourceFixture({
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: true, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: true,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: row.id, revision: row.revision + 1 } });
        harness.answer(serverId, '/v1/teams/credential-resources/delete', { body: { resourceId: row.id, revision: row.revision + 1 } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        if (operation === 'delete') confirm.mockResolvedValue(true);
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        // Broker location opens its editor below the list; the operation then comes from the row's ⋯ menu.
        await pressRowAction(screen, row.id, 'broker-location');
        const refresh = createDeferred<void>();
        harness.answer(serverId, LIST_PATH, {
            ...(refreshFails ? { status: 503 } : { body: { resources: operation === 'delete' ? [] : [{ ...row, revision: row.revision + 1, deliveryPolicy: { preferredAllowedModes: ['brokered'] } }] } }),
            respondAfter: refresh.promise,
        });
        const control = `shared-with-teams:${operation}:${row.id}`;
        await pressRowAction(screen, row.id, operation);
        try {
            await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH)).toHaveLength(2));
            await openRowMenu(screen, row.id);
            await vi.waitFor(() => {
                const node = screen.findByTestId(control);
                expect(node).not.toBeNull();
                expect(menuActionDisabled(screen, control)).toBe(true);
                const save = screen.findAllByTestId(`shared-with-teams:broker:${row.id}:save`)[0];
                expect(save?.props.loading).toBe(false);
            });
            await screen.pressByTestIdAsync(control);
            expect(harness.requestsFor(operation === 'delete' ? '/v1/teams/credential-resources/delete' : UPDATE_PATH)).toHaveLength(1);
        } finally {
            await act(async () => { refresh.resolve(); });
        }
        if (refreshFails) {
            await expectMenuActionDisabled(screen, row.id, operation);
            await screen.pressByTestIdAsync(control);
            expect(harness.requestsFor(operation === 'delete' ? '/v1/teams/credential-resources/delete' : UPDATE_PATH)).toHaveLength(1);
        } else {
            await vi.waitFor(() => expect(screen.findByTestId(control)).toBeNull());
        }
    });

    it('loads source-owner continuation explicitly without replacing prior rows', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, LIST_PATH, { body: {
            resources: [teamCredentialSourceResourceFixture({ id: 'resource-1', displayName: 'Same' })],
            nextCursor: 'cursor-1',
        } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:load-more')).not.toBeNull());
        harness.answer(serverId, LIST_PATH, { body: {
            resources: [teamCredentialSourceResourceFixture({ id: 'resource-2', displayName: 'Same' })],
            nextCursor: null,
        } });
        await screen.pressByTestIdAsync('shared-with-teams:load-more');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toEqual(expect.arrayContaining([
            'shared-with-teams:resource:resource-1', 'shared-with-teams:resource:resource-2',
        ])));
        expect(harness.requestsFor(LIST_PATH).at(-1)?.input).toMatchObject({ cursor: 'cursor-1' });
    });

    it('renders only server-authorized source-owner controls without needing Team membership', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        machineSelection.controller.setMachines([{
            machineId: 'machine-exact', displayName: 'Exact broker', serverId, serverIdentityId: serverId,
        }]);
        harness.answer(serverId, LIST_PATH, { body: { resources: [teamCredentialSourceResourceFixture({
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: false, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: true, enable: false, delete: true,
            },
        })] } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await openRowMenu(screen, 'resource-1');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('shared-with-teams:narrow:resource-1');
        expect(ids).toContain('shared-with-teams:disable:resource-1');
        expect(ids).toContain('shared-with-teams:delete:resource-1');
        expect(ids).not.toContain('shared-with-teams:enable:resource-1');
        expect(ids).not.toContain('shared-with-teams:broker:resource-1.current');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('teamId');
        // Disable reads as an operation, not a checkbox: no square "stop" glyph beside it.
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const menuActions = screen.findAllByType(ItemRowActions)[0]?.props.actions as ReadonlyArray<{ id: string; icon?: string }>;
        expect(menuActions.find(action => action.id === 'shared-with-teams:disable:resource-1')?.icon).not.toBe('stop');
    });

    it('keeps authorized narrowing available after the source owner disabled the resource', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, LIST_PATH, { body: { resources: [teamCredentialSourceResourceFixture({
            enabled: false,
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: false, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: true,
            },
        })] } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await openRowMenu(screen, 'resource-1');

        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('shared-with-teams:narrow:resource-1');
    });

    it('holds native UI confirmation and suspends another source mutation through refresh', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const row = teamCredentialSourceResourceFixture({
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: false, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: true, enable: false, delete: true,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        await harness.requireUiApproval(serverId, 'teams.credentials.update');
        const decision = createDeferred<boolean>();
        confirm.mockImplementationOnce(() => decision.promise);
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: row.id, revision: row.revision + 1 } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await pressRowAction(screen, 'resource-1', 'narrow');
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
        expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(0);
        expect(harness.artifacts(serverId).list()).toEqual([]);
        expect(screen.findByTestId('shared-with-teams:approval')).toBeNull();

        await openRowMenu(screen, 'resource-1');
        await expectMenuActionDisabled(screen, 'resource-1', 'disable');

        const refresh = createDeferred<void>();
        const readsBeforeConfirmation = harness.requestsFor(LIST_PATH).length;
        harness.answer(serverId, LIST_PATH, { status: 503, respondAfter: refresh.promise });
        try {
            await act(async () => { decision.resolve(true); });
            await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH).length).toBeGreaterThan(readsBeforeConfirmation));
            expect(harness.artifacts(serverId).list()).toEqual([]);
            expect(screen.findByTestId('shared-with-teams:approval')).toBeNull();
            await expectMenuActionDisabled(screen, 'resource-1', 'narrow');
            await screen.pressByTestIdAsync('shared-with-teams:narrow:resource-1');
            expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1);
        } finally {
            await act(async () => { refresh.resolve(); });
        }
        await expectMenuActionDisabled(screen, 'resource-1', 'narrow');
    });

    it('submits one exact eligible Machine placement when the row grants that operation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        machineSelection.controller.setMachines([{
            machineId: 'machine-exact', displayName: 'Exact broker', serverId, serverIdentityId: serverId,
        }]);
        const row = teamCredentialSourceResourceFixture({
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-exact', displayName: 'Exact broker', availability: 'available' }],
                selectedPool: null,
                eligiblePools: [],
            },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: true, narrowDisclosure: false, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: false,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 4 } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await pressRowAction(screen, 'resource-1', 'broker-location');
        // The editor opens under the row it edits and names that credential.
        const order = collectRenderedTestIds(screen.tree.toJSON());
        expect(order.indexOf('shared-with-teams:broker:resource-1:save')).toBeGreaterThan(order.indexOf('shared-with-teams:resource:resource-1'));
        expect(JSON.stringify(screen.tree.toJSON())).toContain(`teams.credentials.detail.brokerLabel · ${row.displayName}`);
        selectBrokerMachine(screen, 'machine-exact');
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled)
            .toBe(false));
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:save');
        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
        expect(JSON.stringify(harness.requestsFor(UPDATE_PATH).at(-1)?.input)).toContain('"brokerPlacement":{"kind":"machine","machineId":"machine-exact"}');
        // The editor closes with its own Cancel button; the row itself is not a disclosure.
        expect(screen.findByTestId('shared-with-teams:resource:resource-1')?.props.onPress).toBeUndefined();
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:cancel');
        expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')).toBeNull();
    });

    it('keeps the original revision as the CAS basis when a dirty broker draft receives a newer row', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        machineSelection.controller.setMachines([{
            machineId: 'machine-exact', displayName: 'Exact broker', serverId, serverIdentityId: serverId,
        }]);
        const capabilities = {
            manageAudience: false, managePolicy: false, manageLimits: false,
            updateBrokerPlacement: true, narrowDisclosure: true, widenDisclosure: false,
            refreshDirectMaterial: false, disable: false, enable: false, delete: false,
        } as const;
        const initial = teamCredentialSourceResourceFixture({
            revision: 3,
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-exact', displayName: 'Exact broker', availability: 'available' }],
                selectedPool: null,
                eligiblePools: [],
            },
            capabilities,
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [initial] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 4 } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await pressRowAction(screen, 'resource-1', 'broker-location');
        selectBrokerMachine(screen, 'machine-exact');
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled)
            .toBe(false));

        harness.answer(serverId, LIST_PATH, { body: { resources: [{ ...initial, revision: 4 }] } });
        await pressRowAction(screen, 'resource-1', 'narrow');
        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:save');

        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(2));
        expect(harness.requestsFor(UPDATE_PATH).at(-1)?.input).toMatchObject({
            expectedRevision: 3,
            brokerPlacement: { kind: 'machine', machineId: 'machine-exact' },
        });
    });

    it('allows an eligible offline Pool to be saved as a repairable exact placement', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const poolId = '00000000-0000-4000-8000-000000000001';
        poolProjection.pools = [{
            pool: {
                id: poolId, name: 'Travel Pool', description: null, revision: 1,
                createdAt: 1, updatedAt: 1,
                members: [{ machineId: 'machine-exact', priorityTier: 0, enabled: true, state: 'offline' }],
            },
            availability: { state: 'known', connectedCount: 0, enabledCount: 1 },
        }];
        const row = teamCredentialSourceResourceFixture({
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null, eligibleTargets: [], selectedPool: null,
                eligiblePools: [{ poolId, displayName: 'Travel Pool', availability: 'unavailable', availableMachineCount: 0 }],
            },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: true, narrowDisclosure: false, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: false,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 4 } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await pressRowAction(screen, 'resource-1', 'broker-location');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain(`shared-with-teams:broker:resource-1:machine_pool:${poolId}`));
        await screen.pressByTestIdAsync(`shared-with-teams:broker:resource-1:machine_pool:${poolId}`);
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled)
            .toBe(false));
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:save');

        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(UPDATE_PATH).at(-1)?.input).toMatchObject({
            expectedRevision: 3,
            brokerPlacement: { kind: 'machine_pool', poolId },
        });
    });

    it('explains a state every share has once, above the Teams it applies to', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const readiness = { kind: 'source_unavailable' } as const;
        harness.answer(serverId, LIST_PATH, { body: { resources: ['resource-1', 'resource-2', 'resource-3'].map((id) =>
            teamCredentialSourceResourceFixture({ id, displayName: `Team ${id}`, readiness })), nextCursor: null } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const { resourceStateLabel } = await import('./teamCredentialPresentation');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('shared-with-teams:resource:resource-3'));
        expect(screen.getTextContent().split(resourceStateLabel(readiness)).length - 1).toBe(1);
    });

    it('stays quiet while nothing is shared: no section that only says "none"', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, LIST_PATH, { body: { resources: [] } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await expect.poll(() => harness.requestsFor(LIST_PATH).length).toBeGreaterThan(0);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('shared-with-teams:loading');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('shared-with-teams:empty');
        expect(screen.getTextContent()).not.toContain('teams.credentials.sourceAdministration.title');
    });
});
