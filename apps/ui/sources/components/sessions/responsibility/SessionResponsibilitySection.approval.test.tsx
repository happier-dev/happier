import * as React from 'react';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SetSessionResponsibilityResponseSchema } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { useSessionResponsibilityController as UseController } from './useSessionResponsibilityController';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

/**
 * Responsibility assignment awaiting an Account-required confirmation, end to end.
 *
 * The current Action declaration directly admits the present user's reversible
 * assignment. An explicit Ask-first Account policy still defers that intent to
 * an approval, which must never look like a completed assignment.
 *
 * The real controller reaches the shared Action front door, which persists an open
 * approval in the Home's stateful Artifact store; the Inbox decides it through the
 * generic executor, whose replay is the one assignment request; and the row
 * settles only through the real approval reader and continuation. The network,
 * the credential store, navigation and the OS live region are the replaced
 * boundaries.
 */

const routerPush = vi.hoisted(() => vi.fn());
const layout = vi.hoisted(() => ({ tablet: true }));
vi.mock('@/utils/platform/responsive', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/responsive')>('@/utils/platform/responsive');
    return { ...actual, useIsTablet: () => layout.tablet };
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return { LegendList: createCapturingLegendListMock({ renderItems: true, renderItemLimit: 20 }).module.LegendList };
});
// Only the portal/geometry boundary is replaced; selection and approval stay real.
vi.mock('@/components/ui/popover', async () => {
    const actual = await vi.importActual<typeof import('@/components/ui/popover')>('@/components/ui/popover');
    return {
        ...actual,
        Popover: (props: Record<string, unknown>) => React.createElement(
            'Popover',
            { testID: 'responsibility-popover', focusReturnRef: props.focusReturnRef },
            typeof props.children === 'function'
                ? (props.children as (input: { maxHeight: number }) => React.ReactNode)({ maxHeight: 480 })
                : props.children as React.ReactNode,
        ),
    };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

// The platform screen-reader live region is a genuine OS/DOM boundary.
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: vi.fn(),
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ACCOUNT_ID = 'account-owner';
const HOME_IDENTITY_ID = 'srv_responsibility_home';
const SESSION_ID = 'session-1';
const RESPONSIBILITY_SET_PATH = '/v2/sessions/responsibility/set';
let disposeRestoredAccount: (() => Promise<void>) | null = null;

function summary(accountId: string, firstName: string, username: string) {
    return { kind: 'account' as const, accountId, name: firstName, firstName, lastName: null, username, avatarUrl: null };
}

/**
 * One Home publishing Session sharing, with this device signed in to its Account
 * the way the sync owner establishes it (`activateAccountSettingsScope`: the
 * settings, profile and Session-local scopes together), and the Session row the
 * Home listed for it, assigned to Alice.
 */
async function addResponsibilityHome(): Promise<string> {
    let serverId = await harness.addHome({
        name: 'Home One',
        serverUrl: 'https://responsibility-home.example',
        accountId: ACCOUNT_ID,
        currentAccount: true,
        serverIdentityId: HOME_IDENTITY_ID,
    });
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: HOME_IDENTITY_ID },
    } });
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.session', true)) {
        throw new Error('The sharing.session feature bit could not be written by its own writer');
    }
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    harness.answer(serverId, '/v2/sessions/responsibility/candidates', { body: {
        candidates: [{ accountId: 'account-bob', profile: { firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null } }],
        nextCursor: null,
    } });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });

    const { storage } = await import('@/sync/domains/state/storage');
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const profile = getServerProfileById(serverId);
    const home = profile ? harness.findByServerUrl(profile.serverUrl) : null;
    if (!home?.accountId || !home.token) throw new Error('Responsibility fixture Home has no signed-in Account');
    const restoredAccount = await restoreServerAccountForTest({
        serverUrl: home.serverUrl,
        serverIdentityId: HOME_IDENTITY_ID,
        accountId: home.accountId,
        credentials: { token: home.token },
        request: createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            const method = (init?.method ?? 'GET').toUpperCase();
            if (method === 'GET' && path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (method === 'GET' && path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (method === 'GET' && path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
            if (method === 'GET' && path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (method === 'GET' && ['/v1/machines', '/v1/artifacts', '/v1/kv'].includes(path)) return Response.json([]);
            const bootstrapResponse = createEmptyAccountBootstrapHttpResponse(path, init);
            return bootstrapResponse ?? harness.request(input, init);
        }),
    });
    serverId = restoredAccount.serverId;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    disposeRestoredAccount = () => restoredAccount.dispose();
    harness.answer(serverId, RESPONSIBILITY_SET_PATH, { body: SetSessionResponsibilityResponseSchema.parse({
                changed: true,
                responsibleAccountId: 'account-bob',
                responsibleAccount: summary('account-bob', 'Bob', 'bob'),
                autoFollowed: false,
            }) });
    await harness.requireUiApproval(serverId, 'session.responsibility.set');
    // The Home's listing of this Session, written through the exact-Home list
    // row owner the Session cache uses (`concurrentSessionCache`).
    storage.getState().applyServerScopedSessionListRows(serverId, [createSessionListRenderableSessionFixture({
        id: SESSION_ID,
        responsibleAccountId: 'account-alice',
        responsibleAccount: summary('account-alice', 'Alice', 'alice'),
    })], { source: 'ordinary', mode: 'replace' });
    return serverId;
}

async function renderAssignment(serverId: string) {
    const { SessionResponsibilitySection } = await import('./SessionResponsibilitySection');
    const { useSessionResponsibilityController } = await import('./useSessionResponsibilityController');
    const { useSessionResponsibilityPickerHost } = await import('./useSessionResponsibilityPickerHost');
    const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
    const rowNode = { focus: vi.fn(), isConnected: true };
    const scope = { serverId, accountId: ACCOUNT_ID };
    let latest: ReturnType<typeof UseController> | null = null;
    function Mounted() {
        const controller = useSessionResponsibilityController(SESSION_ID, scope);
        latest = controller;
        const pickerHost = useSessionResponsibilityPickerHost({
            sessionId: SESSION_ID,
            scope,
            actingAccountId: ACCOUNT_ID,
            controller,
            editable: controller.availability === 'editable',
            available: controller.availability === 'editable' || controller.availability === 'read_only',
        });
        return <>
            <RetainedPanelSurface isActive={!pickerHost.compactStepOpen} testID="responsibility-main">
                <SessionResponsibilitySection controller={controller} pickerHost={pickerHost} />
            </RetainedPanelSurface>
            {pickerHost.compactStep}
        </>;
    }
    const screen = await renderScreen(<Mounted />, {
        createNodeMock: (element) => (
            element.props.testID === 'session-responsibility-row' ? rowNode : null
        ),
    });
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(latest!.availability, JSON.stringify({
        availability: latest?.availability,
        rows: storage.getState().sessionListRowsByServerId,
        requests: harness.requests.map((request) => request.path),
    })).toBe('editable'));
    // A runner-owned timeout can preempt the waiting assertion. Preserve the
    // deciding Account/Artifact phase without logging credentials or bodies.
    return { screen, rowNode, controller: () => latest! };
}

/** The one approval the Home persisted for this assignment, decoded as stored. */
async function storedApproval(serverId: string, controller: () => ReturnType<typeof UseController>): Promise<Readonly<{ id: string; request: Record<string, unknown> }>> {
    await waitForHomeGovernance(() => expect(controller().pendingApproval ?? controller().failure).not.toBeNull());
    const rows = harness.artifacts(serverId).list();
    expect(rows, JSON.stringify({ failure: controller().failure, pending: controller().pending,
        requests: harness.requests.map(request => request.path) })).toHaveLength(1);
    return { id: rows[0]!.id, request: JSON.parse(harness.artifacts(serverId).readPlainBody(rows[0]!.id)!) };
}

describe('responsibility assignment awaiting its required confirmation', () => {
    beforeEach(async () => {
        await harness.reset();



        routerPush.mockReset();
        layout.tablet = true;
    });

    afterEach(async () => {
        await standardCleanup();
        await disposeRestoredAccount?.();
        disposeRestoredAccount = null;
    });

    it.each([['compact', false], ['anchored', true]] as const)('returns from the %s picker to an accessible approval and settles once', async (_host, tablet) => {
        layout.tablet = tablet;
        const serverId = await addResponsibilityHome();
        const { screen, rowNode, controller } = await renderAssignment(serverId);

        if (tablet) {
            await screen.pressByTestIdAsync('session-responsibility-row');
        } else {
            act(() => { screen.pressByTestId('session-responsibility-row'); });
        }
        const choice = 'session-responsibility-picker.list:root:option:session-responsibility:account:account-bob';
        await waitForHomeGovernance(() => expect(screen.findByTestId(choice)).not.toBeNull());
        if (tablet) {
            expect(screen.findByTestId('responsibility-popover')!.props.focusReturnRef.current).toBe(rowNode);
        } else {
            expect(screen.findHostByTestId('responsibility-main')!.props.pointerEvents).toBe('none');
        }
        await screen.pressByTestIdAsync(choice);
        const approval = await storedApproval(serverId, controller);
        expect(approval.request).toMatchObject({
            status: 'open',
            actionId: 'session.responsibility.set',
            actionArgs: { sessionId: SESSION_ID, responsibleAccountId: 'account-bob' },
        });
        await waitForHomeGovernance(() => {
            expect(controller().pendingApproval).toMatchObject({ artifactId: approval.id, serverId });
            expect(controller().pending).toBe(true);
        });
        // Nothing committed: the row still names the committed assignee.
        expect(harness.requestsFor(RESPONSIBILITY_SET_PATH)).toHaveLength(0);
        expect(screen.findByTestId('session-responsibility-value')!.props.children).toBe('Alice');
        expect(screen.findByTestId('session-responsibility-approval')).not.toBeNull();
        expect(screen.findByTestId('session-responsibility-step')).toBeNull();
        expect(screen.findByTestId('session-responsibility-picker-anchored')).toBeNull();
        expect(screen.findHostByTestId('responsibility-main')!.props.pointerEvents).toBe('auto');
        expect(screen.findHostByTestId('responsibility-main')!.props['aria-hidden']).not.toBe(true);
        if (!tablet) expect(rowNode.focus).toHaveBeenCalled();

        // One approval at a time: a second intent is held, not a second request.
        await act(async () => { expect(await controller().setResponsibleAccount('account-carol')).toBe(false); });
        expect(harness.artifacts(serverId).list()).toHaveLength(1);

        await screen.pressByTestIdAsync('session-responsibility-approval');
        expect(routerPush).toHaveBeenCalledWith(`/inbox/approvals/${approval.id}?serverId=${serverId}`);

        // The Inbox approves: its replay is the one assignment on the Home.
        harness.answer(serverId, RESPONSIBILITY_SET_PATH, {
            body: {
                changed: true,
                responsibleAccountId: 'account-bob',
                responsibleAccount: summary('account-bob', 'Bob', 'bob'),
                autoFollowed: false,
            },
        });
        await expect(decideApprovalAsInbox(serverId, approval.id, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('session-responsibility-value')!.props.children).toBe('Bob');
            expect(screen.findByTestId('session-responsibility-approval')).toBeNull();
        });
        expect(controller().pending).toBe(false);
        expect(controller().failure).toBeNull();
        expect(harness.requestsFor(RESPONSIBILITY_SET_PATH)).toHaveLength(1);
        expect(screen.findByTestId('session-responsibility-step')).toBeNull();
        expect(screen.findByTestId('session-responsibility-picker-anchored')).toBeNull();
    });

    it.each([
        [404, 'session_access_session_not_found', 'not-found', 'read_only'],
        [403, 'session_access_authentication_required', 'session_access_authentication_required', 'editable'],
    ] as const)('honors a typed detail denial after an unknown approved mutation: %s %s', async (status, code, failure, availability) => {
        const serverId = await addResponsibilityHome();
        const { screen, controller } = await renderAssignment(serverId);
        await act(async () => { await controller().loadCandidates(); });
        expect(controller().candidates.candidates.map(candidate => candidate.accountId)).toEqual(['account-bob']);
        await act(async () => { expect(await controller().setResponsibleAccount('account-bob')).toBe(false); });
        const approval = await storedApproval(serverId, controller);
        harness.answer(serverId, RESPONSIBILITY_SET_PATH, { dispatchThenFail: true });
        harness.answer(serverId, `/v2/sessions/${SESSION_ID}?accessProjectionVersion=1`, { status, body: { error: code } });
        await decideApprovalAsInbox(serverId, approval.id, 'approve');
        await waitForHomeGovernance(() => {
            expect(controller().pending).toBe(false);
            expect(controller().failure).toBe(failure);
            expect(controller().candidates.candidates).toEqual([]);
            expect(controller().availability).toBe(availability);
        });
        expect(harness.requestsFor(RESPONSIBILITY_SET_PATH)).toHaveLength(1);
        if (availability === 'read_only') {
            await act(async () => { expect(await controller().setResponsibleAccount('account-bob')).toBe(false); });
            expect(harness.artifacts(serverId).list()).toHaveLength(1);
        } else {
            // Authentication loss is recoverable, unlike final access loss:
            // reopening shows its typed explanation and no private candidates.
            harness.answer(serverId, '/v2/sessions/responsibility/candidates', { status, body: { error: code } });
            await screen.pressByTestIdAsync('session-responsibility-row');
            await waitForHomeGovernance(() => expect(controller().candidates.failed).toBe(true));
            expect(screen.findByTestId('session-responsibility-picker-error')!.props.accessibilityRole).toBe('alert');
            expect(screen.findByTestId('session-responsibility-picker.list:root:option:session-responsibility:account:account-bob')).toBeNull();
            harness.answer(serverId, '/v2/sessions/responsibility/candidates', { body: {
                candidates: [{ accountId: 'account-bob', profile: { firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null } }],
                nextCursor: null,
            } });
            await screen.pressByTestIdAsync('session-responsibility-picker.list:pagination:retry');
            await waitForHomeGovernance(() => {
                expect(controller().failure).toBeNull();
                expect(screen.findByTestId('session-responsibility-picker.list:root:option:session-responsibility:account:account-bob')).not.toBeNull();
            });
            expect(harness.requestsFor(RESPONSIBILITY_SET_PATH)).toHaveLength(1);
        }
    });

    it('releases the wait without changing anything when the approval is declined', async () => {
        const serverId = await addResponsibilityHome();
        const { screen, controller } = await renderAssignment(serverId);

        await act(async () => { expect(await controller().setResponsibleAccount('account-bob')).toBe(false); });
        const approval = await storedApproval(serverId, controller);
        await waitForHomeGovernance(() => expect(controller().pendingApproval).not.toBeNull());

        await expect(decideApprovalAsInbox(serverId, approval.id, 'reject')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => {
            expect(controller().pendingApproval).toBeNull();
            expect(controller().pending).toBe(false);
            expect(screen.findByTestId('session-responsibility-approval')).toBeNull();
        });
        expect(controller().failure).toBeNull();
        expect(harness.requestsFor(RESPONSIBILITY_SET_PATH)).toHaveLength(0);
        expect(screen.findByTestId('session-responsibility-value')!.props.children).toBe('Alice');
    });
});
