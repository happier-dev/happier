import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDisplayProfileV1Schema } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SessionAccessAccountSummaryV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import { SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1, SessionResponsibilityCandidatesRequestSchema,
    SessionResponsibilityCandidatesResponseSchema, SetSessionResponsibilityRequestSchema,
    SetSessionResponsibilityResponseSchema } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture,
    createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries,
    waitForHomeGovernance, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionResponsibilityController } from './useSessionResponsibilityController';

vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true, renderItemLimit: 20 });
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return await createInlinePopoverModuleMock(importOriginal);
});
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useIsTablet: () => true,
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// The platform screen-reader live region is a genuine OS/DOM boundary.
const announceAccessibilityMessage = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage }));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { SessionResponsibilitySection } = await import('./SessionResponsibilitySection');
const { SessionResponsibilityPicker } = await import('./SessionResponsibilityPicker');
const { useSessionResponsibilityController } = await import('./useSessionResponsibilityController');
const { useSessionResponsibilityPickerHost } = await import('./useSessionResponsibilityPickerHost');
const { t } = await import('@/text');

const CANDIDATES_PATH = '/v2/sessions/responsibility/candidates';
const SET_PATH = '/v2/sessions/responsibility/set';
const DETAIL_PATH = '/v2/sessions/session-1';
const BOB_OPTION = 'session-responsibility-picker.list:root:option:session-responsibility:account:account-bob';
const SELF_OPTION = 'session-responsibility-picker.list:root:option:session-responsibility:account:account-owner:self';
let scope = { serverId: '', accountId: 'account-owner' };
let session: SessionListRenderableSession | null = null;
// These delegates answer external HTTP requests; no API, Action, store,
// collaboration policy or controller implementation is replaced.
const candidateResponse = vi.fn<(input: unknown) => Promise<HomeDomainAnswer>>();
const mutationResponse = vi.fn<(input: unknown) => Promise<HomeDomainAnswer>>();

function summary(accountId: string, firstName: string, username: string) {
    return SessionAccessAccountSummaryV1Schema.parse({
        kind: 'account', accountId, firstName, lastName: null, username, avatarUrl: null,
    });
}
function profile(firstName: string, username: string) {
    return AccountDisplayProfileV1Schema.parse({ firstName, lastName: null, username, avatarUrl: null });
}
function candidatePage(name = 'Bob', username = 'bob', accountId = 'account-bob', nextCursor: string | null = null) {
    return { body: SessionResponsibilityCandidatesResponseSchema.parse({
        candidates: [{ accountId, profile: profile(name, username) }], nextCursor,
    }) };
}
function assigned(accountId = 'account-bob', name = 'Bob', username = 'bob', autoFollowed = false) {
    return { body: SetSessionResponsibilityResponseSchema.parse({
        changed: true, responsibleAccountId: accountId,
        responsibleAccount: summary(accountId, name, username), autoFollowed,
    }) };
}
function publishSession(overrides: Partial<SessionListRenderableSession> | null = {}) {
    session = overrides === null ? null : createSessionListRenderableSessionFixture(overrides);
    storage.getState().applyServerScopedSessionListRows(scope.serverId, session ? [session] : [], {
        source: 'ordinary', mode: 'replace',
    });
}
function editableSession(overrides: Partial<SessionListRenderableSession> = {}) {
    publishSession({ responsibleAccountId: null, responsibleAccount: null, ...overrides });
}
function publishSharing(enabled: boolean) {
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.session', enabled)) throw new Error('Missing sharing.session bit');
    harness.answer(scope.serverId, '/v1/features', { body: features });
    harness.answer(scope.serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId: scope.serverId, snapshot: { status: 'ready', features } });
}
function deny(status: number, error: string): HomeDomainAnswer { return { status, body: { error } }; }
function denyDetail(status: number, error: string) { harness.answer(scope.serverId, DETAIL_PATH, deny(status, error)); }
function detailReads() { return harness.requests.filter(request => request.path.startsWith(DETAIL_PATH)); }

function ResponsibilityPickerHarness(props: Omit<React.ComponentProps<typeof SessionResponsibilityPicker>, 'controller'>) {
    const controller = useSessionResponsibilityController(props.sessionId, props.scope);
    return <SessionResponsibilityPicker {...props} controller={controller} />;
}
function MountedResponsibilitySection(props: Readonly<{
    sessionId: string; scope: typeof scope; actingAccountId: string | null;
    onController?: (controller: SessionResponsibilityController) => void;
}>) {
    const controller = useSessionResponsibilityController(props.sessionId, props.scope);
    props.onController?.(controller);
    const pickerHost = useSessionResponsibilityPickerHost({ ...props, controller,
        editable: controller.availability === 'editable',
        available: controller.availability === 'editable' || controller.availability === 'read_only',
    });
    return <><SessionResponsibilitySection controller={controller} pickerHost={pickerHost} />{pickerHost.compactStep}</>;
}
function Probe(props: Readonly<{ onReady: (controller: SessionResponsibilityController) => void }>) {
    const controller = useSessionResponsibilityController('session-1', scope);
    props.onReady(controller);
    return null;
}
function renderSection() {
    return renderScreen(<MountedResponsibilitySection sessionId="session-1" scope={scope} actingAccountId="account-owner" />);
}
function renderPicker(onResolved = vi.fn(), onClose = vi.fn()) {
    return renderScreen(<ResponsibilityPickerHarness sessionId="session-1" scope={scope} actingAccountId="account-owner"
        onResolved={onResolved} onClose={onClose} />);
}
async function renderController() {
    let current!: SessionResponsibilityController;
    const capture = (controller: SessionResponsibilityController) => { current = controller; };
    const screen = await renderScreen(<Probe onReady={capture} />);
    return { screen, controller: () => current };
}

beforeEach(async () => {
    await harness.reset();
    candidateResponse.mockReset().mockResolvedValue({ body: { candidates: [], nextCursor: null } });
    mutationResponse.mockReset().mockResolvedValue(deny(500, 'unexpected_assignment'));
    announceAccessibilityMessage.mockClear();
    const serverId = await harness.addHome({ name: 'Responsibility Home', serverUrl: 'https://responsibility-row.example',
        accountId: 'account-owner', currentAccount: true });
    scope = { serverId, accountId: 'account-owner' };
    publishSharing(true);
    await storage.getState().activateSettingsScope(scope, []);
    storage.getState().activateProfileScope(scope, []);
    storage.getState().activateSessionLocalStateScope(scope);
    // Direct-mutation cases explicitly waive confirmation through the shared
    // Account policy. The separate approval suite exercises Ask first.
    const actionsSettingsV1 = setActionApprovalOverride({ settings: normalizeActionsSettingsV1(null),
        actionId: 'session.responsibility.set', surface: 'ui', approvalRequired: false });
    harness.answer(serverId, '/v2/account/settings', { body: {
        content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1,
    } });
    storage.getState().applySettingsLocal({ actionsSettingsV1 });
    harness.answer(serverId, CANDIDATES_PATH, { select: input => candidateResponse(SessionResponsibilityCandidatesRequestSchema.parse(input)) });
    harness.answer(serverId, SET_PATH, { select: input => mutationResponse(SetSessionResponsibilityRequestSchema.parse(input)) });
    denyDetail(404, 'session_access_session_not_found');
    publishSession(null);
});
afterEach(() => standardCleanup());

describe('SessionResponsibilitySection', () => {
    it('reserves a stable section row while the scoped Session has no cached projection', async () => {
        const screen = await renderSection();
        expect(screen.findByTestId('session-responsibility-loading')).not.toBeNull();
        expect(screen.findByTestId('session-responsibility-row')).toBeNull();
    });
    it('keeps one line saying the Home does not track responsibility, never collapsing or claiming "No one"', async () => {
        publishSession({});
        const screen = await renderSection();
        expect(screen.findByTestId('session-responsibility-row')).toBeNull();
        expect(screen.findByTestId('session-responsibility-unsupported')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('No one');
    });
    it('hides the section when Session sharing is unavailable on the Home, never claiming "No one"', async () => {
        publishSharing(false);
        editableSession();
        const screen = await renderSection();
        expect(screen.findByTestId('session-responsibility-row')).toBeNull();
        expect(screen.getTextContent()).not.toContain('No one');
    });
    it('renders authoritative unassigned responsibility without an editable action for a read-only collaborator', async () => {
        editableSession({ access: createSessionAccessFixture('view') });
        const screen = await renderSection();
        expect(screen.findByTestId('session-responsibility-value')!.props.children).toBe('No one');
        expect(screen.findByTestId('session-responsibility-row')!.props.disabled).toBe(true);
        expect(harness.requestsFor(CANDIDATES_PATH)).toEqual([]);
    });
    it('shows an explicit "No one" for an authoritative unassigned Session', async () => {
        editableSession();
        const screen = await renderSection();
        expect(screen.findByTestId('session-responsibility-row')).not.toBeNull();
        expect(screen.findByTestId('session-responsibility-value')!.props.children).toBe('No one');
    });
    it('loads and selects an eligible person from the next candidate page', async () => {
        editableSession();
        candidateResponse.mockResolvedValueOnce(candidatePage('Bob', 'bob', 'account-bob', 'next-page'))
            .mockResolvedValueOnce(candidatePage('Alice', 'alice', 'account-alice'));
        mutationResponse.mockResolvedValue(assigned('account-alice', 'Alice', 'alice'));
        const resolved = vi.fn();
        const screen = await renderPicker(resolved);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-responsibility-picker.list:pagination:more')).not.toBeNull());
        await screen.pressByTestIdAsync('session-responsibility-picker.list:pagination:more');
        const alice = 'session-responsibility-picker.list:root:option:session-responsibility:account:account-alice';
        await waitForHomeGovernance(() => expect(screen.findByTestId(alice)).not.toBeNull());
        await screen.pressByTestIdAsync(alice);
        await waitForHomeGovernance(() => expect(resolved).toHaveBeenCalled());
        expect(harness.requestsFor(CANDIDATES_PATH)[1]?.input).toMatchObject({ cursor: 'next-page' });
        expect(harness.requestsFor(SET_PATH).map(request => request.input)).toEqual([
            { sessionId: 'session-1', responsibleAccountId: 'account-alice' },
        ]);
    });
    it('announces a committed responsibility change and never the value already on screen', async () => {
        editableSession();
        await renderSection();
        expect(announceAccessibilityMessage).not.toHaveBeenCalled();
        await act(async () => editableSession({ responsibleAccountId: 'account-bob', responsibleAccount: summary('account-bob', 'Bob', 'bob') }));
        await waitForHomeGovernance(() => expect(announceAccessibilityMessage).toHaveBeenCalledWith(
            t('session.responsibilityA11yReadOnly', { name: 'Bob' }),
        ));
    });
    it('keeps the opened production modal subscribed to candidate, projection, and capability updates', async () => {
        editableSession();
        const reply = createDeferred<void>();
        candidateResponse.mockResolvedValue({ ...candidatePage(), respondAfter: reply.promise });
        const screen = await renderSection();
        await screen.pressByTestIdAsync('session-responsibility-row');
        await waitForHomeGovernance(() => expect(harness.requestsFor(CANDIDATES_PATH)).toHaveLength(1));
        await act(async () => { reply.resolve(); });
        await waitForHomeGovernance(() => expect(screen.findByTestId(BOB_OPTION)).not.toBeNull());
        await act(async () => editableSession({ responsibleAccountId: 'account-bob', responsibleAccount: summary('account-bob', 'Bob', 'bob') }));
        await waitForHomeGovernance(() => expect(screen.findByTestId(BOB_OPTION)?.props.accessibilityState).toMatchObject({ selected: true }));
        await act(async () => editableSession({ access: createSessionAccessFixture('owner', { assignResponsibility: false }) }));
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('session-responsibility-picker-error')?.props.children).toBe(t('session.responsibilityAccessChanged'));
            expect(screen.findByTestId(BOB_OPTION)).toBeNull();
        });
    });
    it('propagates pending and typed authentication failure into the opened production modal and clears identities', async () => {
        editableSession();
        candidateResponse.mockResolvedValue(candidatePage());
        const reply = createDeferred<void>();
        mutationResponse.mockResolvedValue({ ...deny(503, 'session_access_authentication_unavailable'), respondAfter: reply.promise });
        const screen = await renderSection();
        await screen.pressByTestIdAsync('session-responsibility-row');
        await waitForHomeGovernance(() => expect(screen.findByTestId(BOB_OPTION)).not.toBeNull());
        await screen.pressByTestIdAsync(BOB_OPTION);
        await waitForHomeGovernance(() => expect(screen.findByTestId(BOB_OPTION)?.props.accessibilityState).toMatchObject({ disabled: true }));
        await act(async () => { reply.resolve(); });
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('session-responsibility-picker-error')?.props.children).toBe(t('session.access.authenticationUnavailable'));
            expect(screen.findByTestId(BOB_OPTION)).toBeNull();
        });
    });
    it('offers Assign to me even when self is absent from candidate page one', async () => {
        editableSession();
        candidateResponse.mockResolvedValue(candidatePage());
        mutationResponse.mockResolvedValue(assigned('account-owner', 'Owner', 'owner'));
        const resolved = vi.fn();
        const screen = await renderPicker(resolved);
        await waitForHomeGovernance(() => expect(screen.findByTestId(SELF_OPTION)).not.toBeNull());
        await screen.pressByTestIdAsync(SELF_OPTION);
        await waitForHomeGovernance(() => expect(resolved).toHaveBeenCalled());
        expect(harness.requestsFor(SET_PATH)[0]).toMatchObject({ serverId: scope.serverId,
            input: { sessionId: 'session-1', responsibleAccountId: 'account-owner' } });
    });
    it('shares one controller between section and picker with no duplicate candidate owner', async () => {
        editableSession();
        candidateResponse.mockResolvedValue(candidatePage());
        let current!: SessionResponsibilityController;
        const screen = await renderScreen(<MountedResponsibilitySection sessionId="session-1" scope={scope}
            actingAccountId="account-owner" onController={controller => { current = controller; }} />);
        await screen.pressByTestIdAsync('session-responsibility-row');
        await waitForHomeGovernance(() => expect(screen.findByTestId(BOB_OPTION)).not.toBeNull());
        expect(current.candidates.candidates.map(candidate => candidate.accountId)).toEqual(['account-bob']);
        expect(harness.requestsFor(CANDIDATES_PATH)).toHaveLength(1);
    });
    it('routes SelectionList close requests through the modal close owner', async () => {
        editableSession();
        const close = vi.fn();
        const screen = await renderPicker(vi.fn(), close);
        await act(async () => screen.findByTestId('session-responsibility-picker.list:header:input')!.props.onKeyPress({
            nativeEvent: { key: 'Escape' }, preventDefault: vi.fn(),
        }));
        expect(close).toHaveBeenCalledTimes(1);
    });
    it('resolves the assignee name from the canonical Session projection without loading candidates', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        candidateResponse.mockResolvedValue({ dispatchThenFail: true });
        const screen = await renderSection();
        expect(screen.findByTestId('session-responsibility-value')!.props.children).toBe('Alice');
        expect(harness.requestsFor(CANDIDATES_PATH)).toEqual([]);
    });
    it('presents shared Team authentication remediation when candidate loading is unavailable', async () => {
        editableSession();
        candidateResponse.mockResolvedValue(deny(503, 'session_access_authentication_unavailable'));
        const screen = await renderPicker();
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-responsibility-picker-error')?.props.children)
            .toBe(t('session.access.authenticationUnavailable')));
    });
});

describe('useSessionResponsibilityController', () => {
    it('never attributes a previous assignee summary to a newly projected account id', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        const { controller } = await renderController();
        expect(controller().responsibleAccount?.accountId).toBe('account-alice');
        await act(async () => editableSession({ responsibleAccountId: 'account-bob', responsibleAccount: undefined }));
        expect(controller().responsibleAccountId).toBe('account-bob');
        expect(controller().responsibleAccount).toBeNull();
    });
    it('applies the authoritative server value and never a locally guessed one', async () => {
        editableSession();
        mutationResponse.mockResolvedValue(assigned());
        const { controller } = await renderController();
        await act(async () => expect(await controller().setResponsibleAccount('account-bob')).toBe(true));
        expect(controller().responsibleAccountId).toBe('account-bob');
        expect(controller().responsibleAccount).toEqual(summary('account-bob', 'Bob', 'bob'));
        expect(harness.requestsFor(SET_PATH)).toHaveLength(1);
    });
    it('shows the localized assignment explanation only to a self-assignee whose committed transition auto-followed', async () => {
        editableSession();
        mutationResponse.mockResolvedValue(assigned('account-owner', 'Owner', 'owner', true));
        const screen = await renderSection();
        await screen.pressByTestIdAsync('session-responsibility-row');
        await waitForHomeGovernance(() => expect(screen.findByTestId(SELF_OPTION)).not.toBeNull());
        await screen.pressByTestIdAsync(SELF_OPTION);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-responsibility-auto-follow-explanation')?.props.children)
            .toBe(t('session.follow.assignedExplanation')));
    });
    it('does not show another assignee\'s auto-Follow explanation to the assigning actor', async () => {
        editableSession();
        mutationResponse.mockResolvedValue(assigned('account-bob', 'Bob', 'bob', true));
        let current!: SessionResponsibilityController;
        const screen = await renderScreen(<MountedResponsibilitySection sessionId="session-1" scope={scope}
            actingAccountId="account-owner" onController={controller => { current = controller; }} />);
        await act(async () => expect(await current.setResponsibleAccount('account-bob')).toBe(true));
        expect(screen.findByTestId('session-responsibility-auto-follow-explanation')).toBeNull();
    });
    it('admits only one mutation while the accepted value remains visible', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        const reply = createDeferred<void>();
        mutationResponse.mockResolvedValue({ ...assigned(), respondAfter: reply.promise });
        const { controller } = await renderController();
        let first!: Promise<boolean>;
        let second!: Promise<boolean>;
        act(() => {
            first = controller().setResponsibleAccount('account-bob');
            second = controller().setResponsibleAccount('account-bob');
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SET_PATH)).toHaveLength(1));
        expect(await second).toBe(false);
        expect(controller().responsibleAccountId).toBe('account-alice');
        reply.resolve();
        await act(async () => expect(await first).toBe(true));
        expect(controller().responsibleAccountId).toBe('account-bob');
        expect(harness.requestsFor(SET_PATH)).toHaveLength(1);
    });
    it('keeps the last accepted value and surfaces the typed conflict when access changed', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        mutationResponse.mockResolvedValue(deny(409, SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1));
        const { controller } = await renderController();
        await act(async () => expect(await controller().setResponsibleAccount('account-bob')).toBe(false));
        expect(controller().responsibleAccountId).toBe('account-alice');
        expect(controller().failure).toBe('assignee-unavailable');
    });
    it('retains a canonical Team authentication failure without reconciling a rejected mutation', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        candidateResponse.mockResolvedValue(candidatePage());
        mutationResponse.mockResolvedValue(deny(403, 'session_access_authentication_required'));
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        await act(async () => expect(await controller().setResponsibleAccount('account-bob')).toBe(false));
        expect(controller().failure).toBe('session_access_authentication_required');
        expect(controller().responsibleAccountId).toBe('account-alice');
        expect(controller().candidates.candidates).toEqual([]);
        expect(detailReads()).toEqual([]);
    });
    it('clears private candidates when assignment capability is lost while mounted', async () => {
        editableSession();
        candidateResponse.mockResolvedValue(candidatePage());
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        await act(async () => editableSession({ access: createSessionAccessFixture('owner', { assignResponsibility: false }) }));
        expect(controller().availability).toBe('read_only');
        expect(controller().candidates.candidates).toEqual([]);
    });
    it('clears previously loaded candidate identities when Team authentication becomes unavailable', async () => {
        editableSession();
        candidateResponse.mockResolvedValueOnce(candidatePage());
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        candidateResponse.mockResolvedValueOnce(deny(503, 'session_access_authentication_unavailable'));
        await act(async () => controller().loadCandidates());
        expect(controller().failure).toBe('session_access_authentication_unavailable');
        expect(controller().candidates.candidates).toEqual([]);
    });
    it('stops offering assignment and drops disclosed candidates after a proven denial', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        candidateResponse.mockResolvedValue(candidatePage());
        mutationResponse.mockResolvedValue(deny(403, 'session_access_forbidden'));
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        await act(async () => expect(await controller().setResponsibleAccount('account-bob')).toBe(false));
        expect(controller().failure).toBe('forbidden');
        expect(controller().availability).toBe('read_only');
        expect(controller().candidates.candidates).toEqual([]);
        expect(harness.requestsFor(CANDIDATES_PATH)).toHaveLength(1);
        expect(detailReads()).toEqual([]);
    });
    it('drops disclosed candidates when the candidate page itself is refused', async () => {
        editableSession();
        candidateResponse.mockResolvedValueOnce(candidatePage()).mockResolvedValueOnce(deny(403, 'session_access_forbidden'));
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        await act(async () => controller().loadCandidates());
        expect(controller().failure).toBe('forbidden');
        expect(controller().candidates.candidates).toEqual([]);
        expect(controller().availability).toBe('read_only');
    });
    it('withdraws candidates and the control on a definitive not-found from a page or a mutation', async () => {
        editableSession();
        candidateResponse.mockResolvedValue(candidatePage());
        mutationResponse.mockResolvedValue(deny(404, 'session_access_session_not_found'));
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        await act(async () => expect(await controller().setResponsibleAccount('account-bob')).toBe(false));
        expect(controller().failure).toBe('not-found');
        expect(controller().availability).toBe('read_only');
        expect(controller().candidates.candidates).toEqual([]);
        expect(detailReads()).toEqual([]);
    });
    it('withdraws candidates when the candidate page answers a definitive not-found', async () => {
        editableSession();
        candidateResponse.mockResolvedValueOnce(candidatePage()).mockResolvedValueOnce(deny(404, 'session_access_session_not_found'));
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        await act(async () => controller().loadCandidates({ query: 'b' }));
        expect(controller().candidates.candidates).toEqual([]);
        expect(controller().availability).toBe('read_only');
    });
    it('keeps last-good candidate rows for an unproven transport failure', async () => {
        editableSession();
        candidateResponse.mockResolvedValueOnce(candidatePage()).mockResolvedValueOnce({ dispatchThenFail: true });
        const { controller } = await renderController();
        await act(async () => controller().loadCandidates());
        await act(async () => controller().loadCandidates());
        expect(controller().candidates.candidates).toHaveLength(1);
        expect(controller().candidates.failed).toBe(true);
        expect(controller().availability).toBe('editable');
    });
    it('reconciles an unknown mutation outcome from the exact Home before retry', async () => {
        editableSession({ responsibleAccountId: 'account-alice', responsibleAccount: summary('account-alice', 'Alice', 'alice') });
        mutationResponse.mockResolvedValue({ dispatchThenFail: true });
        harness.answer(scope.serverId, DETAIL_PATH, { body: { session: createPlainSessionCurrentProjectionRecordFixture({
            responsibleAccountId: 'account-bob', responsibleAccount: summary('account-bob', 'Bob', 'bob'),
        }) } });
        const { controller } = await renderController();
        await act(async () => { await controller().setResponsibleAccount('account-bob'); });
        expect(detailReads()).toHaveLength(1);
        expect(detailReads()[0]?.serverId).toBe(scope.serverId);
        expect(controller().responsibleAccountId).toBe('account-bob');
        expect(controller().failure).toBe('unknown');
    });
});
