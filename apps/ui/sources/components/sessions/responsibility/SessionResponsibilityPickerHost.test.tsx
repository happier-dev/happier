import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { ModalProvider } from '@/modal';

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true, renderItemLimit: 20 }).module.LegendList };
});

// Window geometry is the platform boundary that selects the responsive host.
const layout = vi.hoisted(() => ({ tablet: true }));
vi.mock('@/utils/platform/responsive', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/responsive')>('@/utils/platform/responsive');
    return { ...actual, useIsTablet: () => layout.tablet };
});

// The overlay/portal hosts are the boundary; the responsive choice and every
// candidate/mutation decision below them stays real.
vi.mock('@/components/ui/popover', async () => {
    const actual = await vi.importActual<typeof import('@/components/ui/popover')>('@/components/ui/popover');
    return {
        ...actual,
        Popover: (props: Record<string, unknown>) => React.createElement(
            'Popover',
            { testID: 'session-responsibility-popover', open: props.open, anchorRef: props.anchorRef, focusReturnRef: props.focusReturnRef },
            typeof props.children === 'function'
                ? (props.children as (input: { maxHeight: number }) => React.ReactNode)({ maxHeight: 480 })
                : (props.children as React.ReactNode),
        ),
    };
});
vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Readonly<{ children?: React.ReactNode }>) =>
        React.createElement('FloatingOverlay', null, props.children),
}));

const responsibilityApi = vi.hoisted(() => ({
    setSessionResponsibleAccount: vi.fn(),
    listSessionResponsibilityCandidates: vi.fn(),
    readSessionResponsibleAccount: vi.fn(),
}));
vi.mock('@/sync/api/session/apiSessionResponsibility', async () => {
    const actual = await vi.importActual<typeof import('@/sync/api/session/apiSessionResponsibility')>(
        '@/sync/api/session/apiSessionResponsibility',
    );
    return {
        ...actual,
        setSessionResponsibleAccount: responsibilityApi.setSessionResponsibleAccount,
        listSessionResponsibilityCandidates: responsibilityApi.listSessionResponsibilityCandidates,
        readSessionResponsibleAccount: responsibilityApi.readSessionResponsibleAccount,
    };
});
vi.mock('@/hooks/session/useSessionCollaborationAvailability', async () => {
    const actual = await vi.importActual<typeof import('@/hooks/session/useSessionCollaborationAvailability')>('@/hooks/session/useSessionCollaborationAvailability');
    return { ...actual, useSessionCollaborationAvailabilityState: () => 'available' };
});
vi.mock('@/sync/sync', () => ({
    sync: { getCredentials: () => ({ token: 'test-token', secret: new Uint8Array() }) },
}));

const storeState = vi.hoisted(() => ({
    sessionsByKey: {} as Record<string, Record<string, unknown> | null>,
    applied: [] as Array<Readonly<{ sessionId: string; serverId: string; value: string | null }>>,
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSessionListRenderableWithServerScope: (serverId: string | null | undefined, sessionId: string) =>
            storeState.sessionsByKey[`${serverId ?? ''}:${sessionId}`] ?? null,
        storage: {
            getState: () => ({
                applySessionResponsibleAccount: (
                    sessionId: string,
                    value: string | null,
                    scope: Readonly<{ serverId: string }>,
                ) => {
                    storeState.applied.push({ sessionId, serverId: scope.serverId, value });
                },
            }),
        },
    });
});

import { SessionResponsibilitySection } from './SessionResponsibilitySection';
import { useSessionResponsibilityController } from './useSessionResponsibilityController';
import { useSessionResponsibilityPickerHost } from './useSessionResponsibilityPickerHost';

const scope = { serverId: 'home-1', accountId: 'account-owner' };
const otherHomeScope = { serverId: 'home-2', accountId: 'account-owner' };

/**
 * The Collaboration surface's own wiring of the one controller and one picker
 * host. The surface test owns the proof that the real surface deactivates its
 * body for the compact step; here the step is rendered as the surface would, so
 * host selection, target binding and focus return stay observable.
 */
function MountedResponsibilitySection(props: Readonly<{
    sessionId: string;
    scope: typeof scope;
    actingAccountId: string | null;
}>) {
    const controller = useSessionResponsibilityController(props.sessionId, props.scope);
    const pickerHost = useSessionResponsibilityPickerHost({
        sessionId: props.sessionId,
        scope: props.scope,
        actingAccountId: props.actingAccountId,
        controller,
        editable: controller.availability === 'editable',
        available: controller.availability === 'editable' || controller.availability === 'read_only',
    });
    return (
        <>
            <SessionResponsibilitySection controller={controller} pickerHost={pickerHost} />
            {pickerHost.compactStep}
        </>
    );
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function editableSession() {
    return { id: 'session-1', responsibleAccountId: null, responsibleAccount: null, access: { capabilities: { assignResponsibility: true } } };
}

function Probe(props: Readonly<{
    sessionId: string;
    scope: typeof scope;
    onReady: (controller: ReturnType<typeof useSessionResponsibilityController>) => void;
}>) {
    const controller = useSessionResponsibilityController(props.sessionId, props.scope);
    props.onReady(controller);
    return null;
}

describe('responsibility picker host lifetime', () => {
    beforeEach(() => {
        responsibilityApi.setSessionResponsibleAccount.mockReset();
        responsibilityApi.setSessionResponsibleAccount.mockResolvedValue({
            changed: true,
            responsibleAccountId: 'account-bob',
            responsibleAccount: { kind: 'account', accountId: 'account-bob', firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null },
            autoFollowed: false,
        });
        responsibilityApi.listSessionResponsibilityCandidates.mockReset();
        responsibilityApi.listSessionResponsibilityCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
        responsibilityApi.readSessionResponsibleAccount.mockReset();
        storeState.sessionsByKey = {
            'home-1:session-1': editableSession(),
            'home-1:session-2': { ...editableSession(), id: 'session-2' },
            'home-2:session-1': { ...editableSession() },
        };
        storeState.applied = [];
        layout.tablet = true;
    });

    it('refuses a mutation from a controller whose surface already unmounted', async () => {
        let latest: ReturnType<typeof useSessionResponsibilityController> | null = null;
        const screen = await renderScreen(
            <Probe sessionId="session-1" scope={scope} onReady={(controller) => { latest = controller; }} />,
        );
        const retained = latest!;
        await screen.unmount();

        let applied: boolean | null = null;
        await act(async () => { applied = await retained.setResponsibleAccount('account-bob'); });

        expect(applied).toBe(false);
        expect(responsibilityApi.setSessionResponsibleAccount).not.toHaveBeenCalled();
        expect(storeState.applied).toEqual([]);
    });

    it('refuses a mutation from a picker retained across an exact Home change', async () => {
        let latest: ReturnType<typeof useSessionResponsibilityController> | null = null;
        const screen = await renderScreen(
            <Probe sessionId="session-1" scope={scope} onReady={(controller) => { latest = controller; }} />,
        );
        const retainedForHomeOne = latest!;
        await screen.update(
            <Probe sessionId="session-1" scope={otherHomeScope} onReady={(controller) => { latest = controller; }} />,
        );

        let applied: boolean | null = null;
        await act(async () => { applied = await retainedForHomeOne.setResponsibleAccount('account-bob'); });

        expect(applied).toBe(false);
        expect(responsibilityApi.setSessionResponsibleAccount).not.toHaveBeenCalled();
        expect(storeState.applied).toEqual([]);
    });

    it('ignores an older mutation after the mounted target cycles A to B to A', async () => {
        const older = deferred<{
            changed: true;
            responsibleAccountId: string;
            responsibleAccount: { kind: 'account'; accountId: string; firstName: string; lastName: null; username: string; avatarUrl: null };
            autoFollowed: boolean;
        }>();
        const newer = deferred<{
            changed: true;
            responsibleAccountId: string;
            responsibleAccount: { kind: 'account'; accountId: string; firstName: string; lastName: null; username: string; avatarUrl: null };
            autoFollowed: boolean;
        }>();
        responsibilityApi.setSessionResponsibleAccount
            .mockImplementationOnce(() => older.promise)
            .mockImplementationOnce(() => newer.promise);

        let latest: ReturnType<typeof useSessionResponsibilityController> | null = null;
        const screen = await renderScreen(
            <Probe sessionId="session-1" scope={scope} onReady={(controller) => { latest = controller; }} />,
        );
        const retainedOlderA = latest!;
        let olderResult: Promise<boolean> | null = null;
        await act(async () => {
            olderResult = retainedOlderA.setResponsibleAccount('account-bob');
        });

        await screen.update(
            <Probe sessionId="session-2" scope={scope} onReady={(controller) => { latest = controller; }} />,
        );
        await screen.update(
            <Probe sessionId="session-1" scope={scope} onReady={(controller) => { latest = controller; }} />,
        );

        let newerResult: Promise<boolean> | null = null;
        await act(async () => {
            newerResult = latest!.setResponsibleAccount('account-owner');
        });
        await act(async () => {
            newer.resolve({
                changed: true,
                responsibleAccountId: 'account-owner',
                responsibleAccount: { kind: 'account', accountId: 'account-owner', firstName: 'Owner', lastName: null, username: 'owner', avatarUrl: null },
                autoFollowed: true,
            });
            expect(await newerResult!).toBe(true);
        });

        expect(storeState.applied).toEqual([
            { sessionId: 'session-1', serverId: 'home-1', value: 'account-owner' },
        ]);
        expect(latest!.assignmentAutoFollowed).toBe(true);
        expect(latest!.failure).toBeNull();

        await act(async () => {
            older.resolve({
                changed: true,
                responsibleAccountId: 'account-bob',
                responsibleAccount: { kind: 'account', accountId: 'account-bob', firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null },
                autoFollowed: false,
            });
            expect(await olderResult!).toBe(false);
        });

        expect(storeState.applied).toEqual([
            { sessionId: 'session-1', serverId: 'home-1', value: 'account-owner' },
        ]);
        expect(latest!.assignmentAutoFollowed).toBe(true);
        expect(latest!.failure).toBeNull();
    });

    it('presents the wide anchored SelectionList host without a global modal', async () => {
        layout.tablet = true;
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );
        await screen.pressByTestIdAsync('session-responsibility-row');

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-picker-anchored')).not.toBeNull();
        });
        expect(screen.findByTestId('session-responsibility-popover')!.props.open).toBe(true);
        expect(screen.findByTestId('session-responsibility-picker.list')).not.toBeNull();
        expect(screen.findByTestId('session-responsibility-modal')).toBeNull();
    });

    it('pushes a step the surface can host, not a modal, on a compact layout', async () => {
        layout.tablet = false;
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );
        await screen.pressByTestIdAsync('session-responsibility-row');

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-step')).not.toBeNull();
        });
        // The step is an ordinary child of the surface that mounted this host, so
        // it renders with no modal host present at all. A `Modal.show` card would
        // have needed the `ModalProvider` above and would leave this tree empty.
        expect(screen.findByTestId('session-responsibility-picker-screen')).not.toBeNull();
        expect(screen.findByTestId('session-responsibility-step-back')).not.toBeNull();
        expect(screen.findByTestId('session-responsibility-modal')).toBeNull();
        expect(screen.findByTestId('session-responsibility-picker-anchored')).toBeNull();
    });

    it.each([
        ['wide anchored', true],
        ['compact screen', false],
    ])('retries a failed initial candidate request through the %s host', async (_host, tablet) => {
        layout.tablet = tablet;
        const initial = deferred<{ candidates: []; nextCursor: null }>();
        const retry = deferred<{
            candidates: Array<{ accountId: string; profile: { firstName: string; lastName: null; username: string; avatarUrl: null } }>;
            nextCursor: null;
        }>();
        responsibilityApi.listSessionResponsibilityCandidates
            .mockImplementationOnce(() => initial.promise)
            .mockImplementationOnce(() => retry.promise);
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );
        await screen.pressByTestIdAsync('session-responsibility-row');
        await vi.waitFor(() => expect(responsibilityApi.listSessionResponsibilityCandidates).toHaveBeenCalledTimes(1));

        await act(async () => { initial.reject(new Error('initial candidates unavailable')); });
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-picker.list:pagination:retry')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('session-responsibility-picker.list:pagination:retry');
        expect(responsibilityApi.listSessionResponsibilityCandidates).toHaveBeenCalledTimes(2);
        expect(responsibilityApi.listSessionResponsibilityCandidates.mock.calls[1]?.[1]).toEqual({ sessionId: 'session-1' });

        await act(async () => {
            retry.resolve({
                candidates: [{
                    accountId: 'account-alice',
                    profile: { firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null },
                }],
                nextCursor: null,
            });
        });
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-picker.list:root:option:session-responsibility:account:account-alice')).not.toBeNull();
        });
    });

    it.each([
        ['wide anchored', true],
        ['compact screen', false],
    ])('retries the retained failed continuation cursor through the %s host without duplicating rows', async (_host, tablet) => {
        layout.tablet = tablet;
        const initial = deferred<{
            candidates: Array<{ accountId: string; profile: { firstName: string; lastName: null; username: string; avatarUrl: null } }>;
            nextCursor: string;
        }>();
        const continuation = deferred<{ candidates: []; nextCursor: null }>();
        const retry = deferred<{
            candidates: Array<{ accountId: string; profile: { firstName: string; lastName: null; username: string; avatarUrl: null } }>;
            nextCursor: null;
        }>();
        responsibilityApi.listSessionResponsibilityCandidates
            .mockImplementationOnce(() => initial.promise)
            .mockImplementationOnce(() => continuation.promise)
            .mockImplementationOnce(() => retry.promise);
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );
        await screen.pressByTestIdAsync('session-responsibility-row');
        await vi.waitFor(() => expect(responsibilityApi.listSessionResponsibilityCandidates).toHaveBeenCalledTimes(1));
        await act(async () => {
            initial.resolve({
                candidates: [{
                    accountId: 'account-bob',
                    profile: { firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null },
                }],
                nextCursor: 'cursor-page-2',
            });
        });
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-picker.list:pagination:more')).not.toBeNull();
        });

        await screen.pressByTestIdAsync('session-responsibility-picker.list:pagination:more');
        expect(responsibilityApi.listSessionResponsibilityCandidates.mock.calls[1]?.[1]).toEqual({
            sessionId: 'session-1',
            cursor: 'cursor-page-2',
        });
        await act(async () => { continuation.reject(new Error('continuation unavailable')); });
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-picker.list:pagination:retry')).not.toBeNull();
        });

        await screen.pressByTestIdAsync('session-responsibility-picker.list:pagination:retry');
        expect(responsibilityApi.listSessionResponsibilityCandidates).toHaveBeenCalledTimes(3);
        expect(responsibilityApi.listSessionResponsibilityCandidates.mock.calls[2]?.[1]).toEqual({
            sessionId: 'session-1',
            cursor: 'cursor-page-2',
        });
        await act(async () => {
            retry.resolve({
                candidates: [{
                    accountId: 'account-alice',
                    profile: { firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null },
                }],
                nextCursor: null,
            });
        });
        await vi.waitFor(() => {
            // Painted rows only: the composite-walking query also counts every
            // component that forwards this `testID`, so it can never express
            // "appears once on screen".
            expect(screen.findAllHostsByTestId('session-responsibility-picker.list:root:option:session-responsibility:account:account-bob')).toHaveLength(1);
            expect(screen.findAllHostsByTestId('session-responsibility-picker.list:root:option:session-responsibility:account:account-alice')).toHaveLength(1);
        });
    });

    it('returns focus to the invoking row when the compact step is popped', async () => {
        layout.tablet = false;
        // The invoking control is the boundary that owns focus. The compact step
        // has no overlay host above it, so the picker host itself returns focus
        // to the row the user activated.
        const rowNode = { focus: vi.fn(), isConnected: true };
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
            {
                createNodeMock: (element) => (
                    element.props.testID === 'session-responsibility-row'
                        ? rowNode
                        : null
                ),
            },
        );
        await screen.pressByTestIdAsync('session-responsibility-row');
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-step')).not.toBeNull());

        await screen.pressByTestIdAsync('session-responsibility-step-back');

        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-step')).toBeNull());
        expect(rowNode.focus).toHaveBeenCalled();
    });

    it('gives the wide anchored host the same invoking control for focus return', async () => {
        layout.tablet = true;
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );
        await screen.pressByTestIdAsync('session-responsibility-row');
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-picker-anchored')).not.toBeNull());

        // Not the wrapping anchor view: the popover returns focus to the row the
        // user actually activated, exactly as the compact modal now does.
        const popover = screen.findByTestId('session-responsibility-popover');
        expect(popover?.props.focusReturnRef).toBeTruthy();
        expect(popover?.props.focusReturnRef).not.toBe(popover?.props.anchorRef);
    });

    it('dismisses an open picker when the mounted exact target changes', async () => {
        layout.tablet = true;
        const screen = await renderScreen(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );
        await screen.pressByTestIdAsync('session-responsibility-row');
        await vi.waitFor(() => expect(screen.findByTestId('session-responsibility-picker-anchored')).not.toBeNull());

        await screen.update(
            <ModalProvider>
                <MountedResponsibilitySection sessionId="session-2" scope={scope} actingAccountId="account-owner" />
            </ModalProvider>,
        );

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-responsibility-picker-anchored')).toBeNull();
        });
    });
});
