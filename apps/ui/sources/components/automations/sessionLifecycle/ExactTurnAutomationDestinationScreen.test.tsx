import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';

const routerMock = vi.hoisted(() => ({
    push: vi.fn(),
    back: vi.fn(),
    setParams: vi.fn(),
}));
const refreshState = vi.hoisted(() => ({ reject: false }));
const refreshAutomationsSpy = vi.hoisted(() => vi.fn(async () => {
    if (refreshState.reject) throw new Error('offline');
}));
const state = vi.hoisted(() => ({
    session: {
        id: 'source-session',
        serverId: 'server-1',
        latestTurnId: 'turn-observed',
        latestTurnStatus: 'in_progress',
    } as any,
    automations: [] as any[],
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: routerMock }).module;
});
vi.mock('@/components/ui/selectionList', () => createPassThroughModule(['SelectionListScreen']));
vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => createPassThroughModule(['SurfaceStateCard']));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: () => state.session,
        useAutomations: () => state.automations,
        storage: {
            getState: () => ({ sessions: { [state.session.id]: state.session } }),
        },
    });
});
vi.mock('@/sync/sync', () => ({ sync: { refreshAutomations: refreshAutomationsSpy } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: (action: () => void) => action(),
}));

const observed = {
    sourceSessionId: 'source-session',
    sourceTurnId: 'turn-observed',
    sourceServerId: 'server-1',
} as const;

describe('ExactTurnAutomationDestinationScreen', () => {
    beforeEach(() => {
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.setParams.mockClear();
        refreshAutomationsSpy.mockClear();
        refreshState.reject = false;
        state.session = {
            id: 'source-session',
            serverId: 'server-1',
            latestTurnId: 'turn-observed',
            latestTurnStatus: 'in_progress',
        };
        state.automations = Array.from({ length: 70 }, (_, index) => ({
            id: `automation-${index}`,
            name: `Automation ${index}`,
            targetType: 'executionRun',
            linkedExistingSessionId: null,
        }));
        state.automations.push({
            id: 'same-session-target',
            name: 'Must not target its source',
            targetType: 'existingSession',
            linkedExistingSessionId: 'source-session',
        });
        state.automations.push({
            id: 'missing-session-target',
            name: 'Target was not proven',
            targetType: 'existingSession',
            linkedExistingSessionId: null,
        });
    });

    it('uses one searchable virtualized destination list for create and existing writer routes', async () => {
        const { ExactTurnAutomationDestinationScreen } = await import('./ExactTurnAutomationDestinationScreen');
        const screen = await renderScreen(<ExactTurnAutomationDestinationScreen observed={observed} />);
        await act(async () => {});

        const picker = screen.findByProps({ testID: 'exact-turn-automation-destination' });
        expect(picker.props.rootStep).toMatchObject({
            inputPlaceholder: 'automations.exactTurn.searchPlaceholder',
            sections: [{ virtualization: 'force' }],
        });
        expect(picker.props.rootStep.sections[0].options).toHaveLength(71);
        expect(picker.props.rootStep.sections[0].options).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'existing:same-session-target' }),
            expect.objectContaining({ id: 'existing:missing-session-target' }),
        ]));
        expect(picker.props.listAccessibilityLabel).toBe('automations.exactTurn.destinationA11y');
        expect(picker.props.keyboardHintsEnabled).toBe(true);
        expect(picker.props.autoFocusInputOnWeb).toBe(true);

        await act(async () => picker.props.onSelect('create-new'));
        expect(routerMock.push).toHaveBeenNthCalledWith(1, {
            pathname: '/automations/new',
            params: observed,
        });

        await act(async () => picker.props.onSelect('existing:automation-69'));
        expect(routerMock.push).toHaveBeenNthCalledWith(2, {
            pathname: '/automations/edit',
            params: { id: 'automation-69', ...observed },
        });
    });

    it('shows explicit current-turn recovery when the observed turn is stale without silently navigating', async () => {
        state.session = { ...state.session, latestTurnId: 'turn-current' };
        const { ExactTurnAutomationDestinationScreen } = await import('./ExactTurnAutomationDestinationScreen');
        const screen = await renderScreen(<ExactTurnAutomationDestinationScreen observed={observed} />);

        const stale = screen.findByProps({ testID: 'exact-turn-automation-stale' });
        expect(stale.props.accessibilitySemantics).toBe('alert');
        expect(stale.props.action.label).toBe('automations.exactTurn.useCurrentTurn');
        expect(routerMock.push).not.toHaveBeenCalled();
        expect(routerMock.setParams).not.toHaveBeenCalled();

        await act(async () => stale.props.action.onPress());
        expect(routerMock.setParams).toHaveBeenCalledWith({
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-current',
            sourceServerId: 'server-1',
        });
        expect(routerMock.push).not.toHaveBeenCalled();
    });

    it('revalidates exact identity at activation and refuses a changed turn', async () => {
        const { ExactTurnAutomationDestinationScreen } = await import('./ExactTurnAutomationDestinationScreen');
        const screen = await renderScreen(<ExactTurnAutomationDestinationScreen observed={observed} />);
        const picker = screen.findByProps({ testID: 'exact-turn-automation-destination' });

        state.session = { ...state.session, latestTurnId: 'turn-raced' };
        await act(async () => picker.props.onSelect('create-new'));

        expect(routerMock.push).not.toHaveBeenCalled();
    });

    it('shows a typed retry state instead of presenting cached destinations as current after refresh fails', async () => {
        refreshState.reject = true;
        const { ExactTurnAutomationDestinationScreen } = await import('./ExactTurnAutomationDestinationScreen');
        const screen = await renderScreen(<ExactTurnAutomationDestinationScreen observed={observed} />);
        await act(async () => {});

        const failed = screen.findByProps({ testID: 'exact-turn-automation-refresh-failed' });
        expect(failed.props.accessibilitySemantics).toBe('alert');
        expect(failed.props.action.label).toBe('common.retry');
        expect(screen.findAllByProps({ testID: 'exact-turn-automation-destination' })).toHaveLength(0);

        refreshState.reject = false;
        await act(async () => failed.props.action.onPress());
        await act(async () => {});
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(2);
    });
});
