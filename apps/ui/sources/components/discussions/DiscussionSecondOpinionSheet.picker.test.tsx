import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionCreateRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { createDeferred, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { answerDiscussionThreadForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { DetailsStartSheetHost } from '@/components/appShell/panes/panePresentation';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import { SessionDiscussionSourceLinksProvider, DiscussionSourceMarkers } from './SessionDiscussionSourceLinks';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
  renderCustomModals: true, confirmResult: true,
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Dimensions: { get: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
}));

const { Modal, ModalProvider } = await import('@/modal');
const { WorkflowProjectTargetControl } = await import('@/components/workflows/editor/WorkflowProjectTargetControl');
const { SessionPlacementChips } = await import('@/components/sessions/new/placement/SessionPlacementChips');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { SessionServerStartDraftRecipeEditor } = await import('@/components/sessions/new/SessionServerStartDraftRecipeEditor');
const { storage } = await import('@/sync/domains/state/storageStore');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { SessionServerStartSpawnDraftV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
// Load the real pane harness before the timed behavior checks; its first import
// prepares every Session detail renderer, independently of opening this sheet.
const { useOpenDiscussionSecondOpinion } = await import('./useOpenDiscussionSecondOpinion');
const { createSessionDetailsSurfaceRenderers } = await import('@/components/sessions/panes/surfaces/sessionDetailsSurfaceRenderers');
const { createDetailsSurfaceDescriptor } = await import('@/components/appShell/panes/details/surfaces');
let boundary: SessionListQuerySourceHarness;
let sourcePane: AppPaneScopeApi;
function SourcePaneProbe(props: { scopeId: string }) {
  sourcePane = useAppPaneScope(props.scopeId);
  return null;
}
beforeEach(async () => {
  boundary = await createSessionListQuerySourceHarness();
});
afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); await boundary.dispose(); });

async function expectDiagnostic(screen: Awaited<ReturnType<typeof renderScreen>>, state: 'failed' | 'pending', code: string) {
  const prefix = `second-opinion.${state}`;
  await vi.waitFor(() => expect(screen.findByTestId(`${prefix}-details-toggle`)).not.toBeNull());
  await screen.pressByTestIdAsync(`${prefix}-details-toggle`);
  expect(screen.findByTestId(`${prefix}-details-code`)).not.toBeNull();
  expect(screen.getTextContent()).toContain(code);
}

function setSharing(serverId: string, enabled: boolean) {
  const features = createRootLayoutFeaturesResponse({ features: { sharing: { session: { enabled } },
    sessions: { enabled: true, filteredListing: { enabled: true }, conversations: { enabled: true } },
    encryption: { plaintextStorage: { enabled: true } } } });
  boundary.http.answer(serverId, '/v1/features', { body: features });
  boundary.http.answer(serverId, '/v1/features/authenticated', { body: features });
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
}

async function mount(options: { sharingEnabled?: boolean; intent?: 'second_opinion' | 'discuss'; pane?: boolean; sheet?: boolean; longList?: boolean;
  sourceText?: string; directory?: string; resultAndMarkers?: boolean } = {}) {
  const serverId = boundary.serverIds[1]!;
  const sourceText = options.sourceText ?? 'The source answer.';
  setSharing(serverId, options.sharingEnabled ?? true);
  const sessionIds = ['source-session', 'reviewer-session', 'unopened-session', ...(options.longList ? ['extra-reviewer-1', 'extra-reviewer-2', 'extra-reviewer-3'] : [])];
  boundary.setRows(serverId, sessionIds);
  boundary.http.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null } });
  for (const id of sessionIds) {
    const session = createSessionFixture({ id, serverId, encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
      metadata: { machineId: 'review-machine', path: options.directory ?? '/work', host: 'laptop', flavor: 'codex' } });
    boundary.http.answer(serverId, `/v2/sessions/${id}`, { body: createPlainSessionByIdResponseFixture(session) });
    if (options.sheet && id === 'source-session') storage.getState().applySessions([session]);
  }
  boundary.http.answer(serverId, '/v1/sessions/source-session/messages', { body: { messages: [{
    id: 'committed-answer', seq: 7, localId: null, createdAt: 1, messageRole: 'agent',
    content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: sourceText } } },
  }], hasMore: false, nextBeforeSeq: null } });
  const source = { kind: 'session' as const, message: { kind: 'session' as const,
    session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } };
  const previewPath = '/v1/discussions/second-opinion/preview';
  boundary.http.answer(serverId, `POST ${previewPath}`, { select: input => {
    const request = input as { reviewers: Array<{ selection: unknown; participantSlotId?: string; sourceAccess?: string }> };
    return { body: { ok: true, value: DiscussionSecondOpinionPreviewV1Schema.parse({ source,
      sourceAudienceAccountIds: [boundary.accountId(serverId)], sourceContentReady: true,
      discussionAudienceAccountIds: [boundary.accountId(serverId)], missingDiscussionSourceAccountIds: [],
      discussionDisclosure: { ok: true }, canGrantSource: true, reviewers: request.reviewers.map(reviewer => ({
        ...reviewer, sourceAccess: reviewer.sourceAccess ?? 'read', runtimeAccountId: boundary.accountId(serverId),
        audienceAccountIds: [boundary.accountId(serverId)], missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true },
      })) }) } };
  } });
  boundary.http.answer(serverId, 'POST /v1/discussions', { status: 503, body: { error: 'unavailable' } });
  storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId,
    [serverId]: [createMachineFixture({ id: 'review-machine', active: false, activeAt: 0 })] } });
  const sourcePaneScopeId = createSessionPaneScopeId('source-session', serverId, 'second-opinion-source');
  let setActive: (active: boolean) => void = () => {};
  let commits = 0;
  const markerNavigation = vi.fn();
  if (options.resultAndMarkers) boundary.http.answer(serverId, 'GET /v1/discussions', { body: { discussions: [], nextCursor: null } });
  const renderers = createSessionDetailsSurfaceRenderers({ sessionId: 'source-session', serverId, scopeId: sourcePaneScopeId,
    sessionScreenTestIdsEnabled: true,
    openFileTab: () => {}, getStartEditingFileHandler: () => () => {}, closeDetailsTab: () => {} });
  const paneScope = { kind: 'session' as const, sessionId: 'source-session', serverId, machineId: 'review-machine' };
  function Pane() {
    const [active, updateActive] = React.useState(true);
    setActive = updateActive;
    const pane = useAppPaneScope(sourcePaneScopeId);
    const open = useOpenDiscussionSecondOpinion(sourcePaneScopeId);
    React.useEffect(() => { open({ source, sourceText, intent: options.intent ?? 'second_opinion', onNavigate: () => {} }); }, [open]);
    const tab = pane.scopeState?.details.tabs.find(tab => tab.kind === 'secondOpinion'
      || (options.resultAndMarkers && tab.kind === 'discussion'));
    if (!tab) return null;
    const input: DetailsSurfaceRenderInputV1 = { tab, scope: paneScope, region: 'details', active, callbacks: { replaceTab: pane.replaceDetailsTab },
      descriptor: createDetailsSurfaceDescriptor({ tab, scope: paneScope, region: 'details' }) };
    return <React.Profiler id="second-opinion" onRender={() => { commits += 1; }}>
      {renderers.find(renderer => renderer.id === (tab.kind === 'discussion' ? 'session-discussion' : 'session-second-opinion'))!.render(input)}
    </React.Profiler>;
  }
  function NoPane() {
    const open = useOpenDiscussionSecondOpinion(sourcePaneScopeId);
    React.useEffect(() => { open({ source, sourceText, intent: options.intent ?? 'second_opinion', onNavigate: () => {} }); }, [open]);
    return null;
  }
  const screen = await renderScreen(<AppPaneProvider><SourcePaneProbe scopeId={sourcePaneScopeId} />{options.sheet
    ? <ModalProvider><DetailsStartSheetHost><NoPane /></DetailsStartSheetHost></ModalProvider>
    : options.resultAndMarkers ? <SessionDiscussionSourceLinksProvider sessionId="source-session" serverId={serverId}>
      <DiscussionSourceMarkers source={source.message} navigate={markerNavigation} />
      <DiscussionSourceMarkers source={{ ...source.message, messageId: 'unselected-answer' }} navigate={markerNavigation} />
      <Pane />
    </SessionDiscussionSourceLinksProvider> : <Pane />}</AppPaneProvider>);
  return { screen, serverId, previewPath, markerNavigation, setActive: (active: boolean) => setActive(active), commits: () => commits };
}

it('mounts the real Start form inside a wide transcript host without a Details renderer', async () => {
  const { screen } = await mount({ sheet: true });
  await vi.waitFor(() => expect(screen.findByTestId('contextual-start-composer')).not.toBeNull());
  const { PhoneDetailsStartSheet } = await import('@/components/appShell/panes/details/PhoneDetailsStartSheet');
  expect(screen.findAllByType(PhoneDetailsStartSheet)).toHaveLength(1);
  expect(screen.findByTestId('second-opinion.question')).not.toBeNull();
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await act(async () => Modal.hideAll());
  expect(screen.findByTestId('contextual-start-composer')).toBeNull();
  await screen.unmount();
});

it.each([false, true])('offers selectable Account people with folded=%s and makes each Who and Where decision once', async (longList) => {
  const { screen, serverId, previewPath } = await mount({ pane: true, longList });
  const { SelectionList } = await import('@/components/ui/selectionList');
  const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
  await vi.waitFor(() => expect(screen.findByTestId('contextual-start-composer')).not.toBeNull());
  const whoSections = () => screen.findAllByType(SelectionList).find(node => node.props.testID === 'contextual-start-who')!
    .props.rootStep.sections as Array<{ id: string; options?: Array<{ id: string }> }>;
  // A short list exposes People; a folded list reaches the same owner through Show all.
  if (longList) {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewers-more')).not.toBeNull());
    expect(whoSections().map(section => section.id)).not.toContain('people');
    await screen.pressByTestIdAsync('second-opinion.reviewers-more');
  } else {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
    expect(screen.findByTestId('second-opinion.reviewers-more')).toBeNull();
  }
  expect(whoSections().map(section => section.id)).toContain('people');
  expect(screen.findAllByType(SelectionList).filter(node => node.props.testID === 'contextual-start-who')).toHaveLength(1);
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(1);
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(2);
  expect(screen.findAllByType(WorkflowProjectTargetControl)).toHaveLength(1);
  const target = { machineId: 'review-machine', directory: '/chosen-once' };
  await act(async () => screen.findByType(WorkflowProjectTargetControl).props.onChange(target));
  expect(screen.findByType(WorkflowProjectTargetControl).props.target).toBe(target);
  expect(screen.findAllByType(FieldTextInput).filter(node => node.props.testID === 'second-opinion.question')).toHaveLength(1);
  boundary.http.answer(serverId, '/v1/user/search', { body: { users: [{
    id: 'human-reviewer', firstName: 'Ada', lastName: null, username: 'ada', avatar: null,
    bio: null, status: 'none', publicKey: null,
  }], nextCursor: null } });
  await act(async () => screen.changeTextByTestId('contextual-start-who:header:input', 'Ada'));
  await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-person-human-reviewer')).not.toBeNull());
  await screen.pressByTestIdAsync('discussion-invite-person-human-reviewer');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(3));
  expect(boundary.http.requestsFor(previewPath).at(-1)?.input).toMatchObject({ participants: [{ kind: 'account', accountId: 'human-reviewer' }] });
  expect(screen.findAllByType(SelectionList).find(node => node.props.testID === 'contextual-start-who')!.props.selection.selectedIds)
    .toContain('account:human-reviewer');
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('quotes the answer as the person read it, without its Markdown syntax', async () => {
  const { screen } = await mount({ sheet: true, sourceText: 'The alert references a **failed rollback** (`rollback_id_7`).' });
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('The alert references a failed rollback (rollback_id_7).'));
  expect(screen.getTextContent()).not.toContain('**');
  await screen.unmount();
});

it('replaces its start destination immediately with the accepted Discussion and publishes one source message', async () => {
  const directory = `/work/${'nested-review-source/'.repeat(96)}`;
  const sourceText = Array.from({ length: 128 }, (_, index) => `Source line ${index}: ${directory}/answer.ts`).join('\n');
  const { screen, serverId, markerNavigation } = await mount({ pane: true, intent: 'discuss', sharingEnabled: true,
    sourceText, directory, resultAndMarkers: true });
  const thread = answerDiscussionThreadForTests(boundary.http, serverId, { accountId: boundary.accountId(serverId),
    loseCreate: false, loseFirstRejoin: false });
  const selectedResultReads = () => ({
    summaries: boundary.http.requestsFor('/v1/discussions/committed-thread').length,
    messages: boundary.http.requests.filter(request => request.path.split('?')[0]
      === '/v1/discussions/committed-thread/messages').length,
  });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  expect(selectedResultReads()).toEqual({ summaries: 0, messages: 0 });
  await act(async () => screen.changeTextByTestId('second-opinion.question', 'Please discuss this tradeoff.'));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(sourcePane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['discussion']));
  expect(screen.findByTestId('second-opinion.open')).toBeNull();
  expect(thread.messages).toHaveLength(1);
  const creates = boundary.http.requestsFor('/v1/discussions').filter(request => request.input !== null);
  expect(creates).toHaveLength(1);
  expect(creates[0]?.input).toMatchObject({
    firstMessage: { content: { t: 'plain', v: { parts: [
      { t: 'text', text: sourceText }, { t: 'text', text: 'Please discuss this tradeoff.' },
    ] } } },
  });
  // Opening the result projects its summary, then the message Action reads the
  // raw Discussion mode/key separately because its message response carries neither.
  await vi.waitFor(() => expect(selectedResultReads()).toEqual({ summaries: 2, messages: 1 }));
  expect(boundary.http.requests.filter(request => /^\/v1\/discussions\/[^/]+\/messages$/.test(request.path.split('?')[0]!))
    .map(request => request.path.split('?')[0])).toEqual(['/v1/discussions/committed-thread/messages']);
  // The synthetic HTTP Home has no server push producer. Deliver its committed
  // resource change at the existing Account-change transport sink; the real
  // repository/list projection, marker and detail readers remain intact.
  await act(async () => publishMountedDiscussionChanges({ serverId, accountId: boundary.accountId(serverId),
    changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 1 }] }));
  await vi.waitFor(() => expect(screen.findAllHostsByTestId('transcript-message-discussion:committed-thread')).toHaveLength(1));
  expect(markerNavigation).toHaveBeenCalledTimes(0);
  await screen.pressByTestIdAsync('transcript-message-discussion:committed-thread');
  expect(markerNavigation).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/discussions/committed-thread?'));
  // A relevant push repeats the projected-summary + message/key pair. This
  // Session anchor has no Doc firstMessage root to reopen as a third message read.
  await vi.waitFor(() => expect(selectedResultReads()).toEqual({ summaries: 4, messages: 2 }));
  expect(boundary.http.requests.filter(request => request.path.split('?')[0]
    === '/v1/discussions/committed-thread/messages').map(request => {
      const query = new URL(request.path, 'https://home.invalid').searchParams;
      return { messageId: query.get('messageId'), afterSeq: query.get('afterSeq') };
    })).toEqual([{ messageId: 'committed-root', afterSeq: null }, { messageId: null, afterSeq: null }]);
  expect(boundary.http.requests.filter(request => /^\/v1\/discussions\/[^/]+\/messages$/.test(request.path.split('?')[0]!))
    .every(request => request.path.split('?')[0] === '/v1/discussions/committed-thread/messages')).toBe(true);
  await screen.unmount();
});

it('publishes no unchanged opinion draft and keeps retry identities through a real question edit', async () => {
  const { screen, serverId } = await mount({ pane: true, intent: 'discuss' });
  const { createDiscussionSecondOpinionController } = await import('./discussionSecondOpinionController');
  const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: boundary.accountId(serverId) },
    availability: 'available', source: { kind: 'session', message: { kind: 'session',
      session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } },
    draft: { title: 'Review', question: 'Question', reviewers: [] } });
  const publication = vi.fn();
  const unsubscribe = controller.subscribe(publication);
  const initial = controller.getSnapshot();
  controller.updateDraft({ ...initial.draft, reviewers: [...initial.draft.reviewers] });
  expect(controller.getSnapshot()).toBe(initial);
  expect(publication).not.toHaveBeenCalled();
  controller.updateDraft({ ...initial.draft, question: 'Edited' });
  expect(publication).toHaveBeenCalledOnce();
  expect(controller.getSnapshot().retry).toBe(initial.retry);
  unsubscribe();
  await screen.unmount();
});

it.each(['preview', 'ask'] as const)('presents an approval pending during %s instead of failure and retry', async phase => {
  const { screen, serverId, previewPath } = await mount();
  try {
    if (phase === 'preview') await boundary.http.requireUiApproval(serverId, 'discussion.second_opinion.start');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
    if (phase === 'ask') {
      await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
      await boundary.http.requireUiApproval(serverId, 'discussion.second_opinion.start');
      await screen.pressByTestIdAsync('second-opinion.ask');
    }
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.approval-pending')).not.toBeNull());
    expect(screen.findByTestId('second-opinion.failed')).toBeNull();
    expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
    if (phase === 'preview') expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  } finally { await screen.unmount(); }
});

it.each(['approve', 'reject'] as const)('settles a pending Discuss %s from Inbox without resubmitting the form', async decision => {
  const { screen, serverId } = await mount({ pane: true, intent: 'discuss', resultAndMarkers: true, sharingEnabled: true });
  const thread = answerDiscussionThreadForTests(boundary.http, serverId, { accountId: boundary.accountId(serverId),
    loseCreate: false, loseFirstRejoin: false });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await boundary.http.requireUiApproval(serverId, 'discussion.create');
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.approval-pending')).not.toBeNull());
  const approvals = () => boundary.http.artifacts(serverId).list().filter(artifact =>
    boundary.http.artifacts(serverId).readPlainBody(artifact.id)?.includes('"actionId":"discussion.create"'));
  const artifactId = approvals()[0]?.id;
  if (!artifactId) throw new Error('missing_approval');
  expect(thread.messages).toHaveLength(0);
  expect(await decideApprovalAsInbox(serverId, artifactId, decision)).toMatchObject({ ok: true });
  if (decision === 'approve') {
    await vi.waitFor(() => expect(sourcePane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['discussion']));
    expect(thread.messages).toHaveLength(1);
    expect(boundary.http.requestsFor('/v1/discussions').filter(request => request.input !== null)).toHaveLength(1);
    await act(async () => publishMountedDiscussionChanges({ serverId, accountId: boundary.accountId(serverId),
      changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 1 }] }));
    await vi.waitFor(() => expect(screen.findAllHostsByTestId('transcript-message-discussion:committed-thread')).toHaveLength(1));
  } else {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.approval-pending')).toBeNull());
    expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false);
    await act(async () => screen.changeTextByTestId('second-opinion.question', 'A revised question'));
    expect(screen.findByTestId('second-opinion.question')?.props.value).toBe('A revised question');
    expect(thread.messages).toHaveLength(0);
  }
  expect(approvals()).toHaveLength(1);
  await screen.unmount();
});

it.each(['approve', 'reject'] as const)('settles a pending opinion Ask %s without another admission', async decision => {
  const { screen, serverId } = await mount({ pane: true, resultAndMarkers: true, sharingEnabled: true });
  const thread = answerDiscussionThreadForTests(boundary.http, serverId, { accountId: boundary.accountId(serverId),
    loseCreate: false, loseFirstRejoin: false });
  boundary.http.answer(serverId, 'POST /v1/discussions/committed-thread/participants/invite', { body: {
    discussionId: 'committed-thread', ownerAccountId: boundary.accountId(serverId), access: 'owner', grants: [], changed: true,
  } });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await boundary.http.requireUiApproval(serverId, 'discussion.second_opinion.start');
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.approval-pending')).not.toBeNull());
  const approvals = () => boundary.http.artifacts(serverId).list().filter(artifact =>
    boundary.http.artifacts(serverId).readPlainBody(artifact.id)?.includes('"actionId":"discussion.second_opinion.start"'));
  const artifactId = approvals()[0]?.id;
  if (!artifactId) throw new Error('missing_approval');
  expect(await decideApprovalAsInbox(serverId, artifactId, decision)).toMatchObject({ ok: true });
  if (decision === 'approve') {
    await vi.waitFor(() => expect(sourcePane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['discussion']));
    expect(thread.messages).toHaveLength(2); // One source quote and one addressed question, one anchored Discussion.
    expect(boundary.http.requestsFor('/v1/discussions').filter(request => request.input !== null)).toHaveLength(1);
    expect(thread.stored()?.discussion.anchor).toMatchObject({ kind: 'session', sessionId: 'source-session', messageId: 'committed-answer' });
    await act(async () => publishMountedDiscussionChanges({ serverId, accountId: boundary.accountId(serverId),
      changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 1 }] }));
    await vi.waitFor(() => expect(screen.findAllHostsByTestId('transcript-message-discussion:committed-thread')).toHaveLength(1));
  } else {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.approval-pending')).toBeNull());
    expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false);
    expect(thread.messages).toHaveLength(0);
  }
  expect(approvals()).toHaveLength(1);
  await screen.unmount();
});

it('retains a pending opinion preview instead of admitting it again when the Start body returns', async () => {
  const { screen, serverId } = await mount();
  const { createDiscussionSecondOpinionController } = await import('./discussionSecondOpinionController');
  const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: boundary.accountId(serverId) },
    availability: 'available', source: { kind: 'session', message: { kind: 'session',
      session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } },
    draft: { title: 'Review', question: 'Question', reviewers: [] } });
  await boundary.http.requireUiApproval(serverId, 'discussion.second_opinion.start');
  await act(async () => { await controller.preview(); });
  const pending = controller.getSnapshot().approval;
  expect(pending).not.toBeNull();
  await act(async () => { await controller.preview(); });
  expect(controller.getSnapshot().approval).toBe(pending);
  expect(boundary.http.artifacts(serverId).list().filter(artifact =>
    boundary.http.artifacts(serverId).readPlainBody(artifact.id)?.includes('"actionId":"discussion.second_opinion.start"'))).toHaveLength(1);
  await screen.unmount();
});

it('submits an edited question once using the shown disclosure consent', async () => {
  const { screen, serverId, previewPath } = await mount();
  try {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    const previews = boundary.http.requestsFor(previewPath).length;
    await act(async () => screen.changeTextByTestId('second-opinion.question', 'An edited question'));
    await screen.pressByTestIdAsync('second-opinion.ask');
    await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(1));
    // Ask owns one fresh admission. Editing text does not add another preview request.
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(previews + 1);
    expect(boundary.http.requestsFor('/v1/discussions')[0]?.input).toMatchObject({
      firstMessage: { content: { t: 'plain', v: { parts: [{ t: 'text', text: 'The source answer.' }] } } },
    });
  } finally { await screen.unmount(); }
});

it('shows the executor consent change when a recipient is added after editing the question', async () => {
  const { screen, serverId, previewPath } = await mount();
  try {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    const accountId = boundary.accountId(serverId);
    boundary.http.answer(serverId, `POST ${previewPath}`, { select: raw => {
      const request = raw as { reviewers: Array<{ selection: unknown; participantSlotId?: string; sourceAccess?: string }> };
      return { body: { ok: true, value: DiscussionSecondOpinionPreviewV1Schema.parse({
        source: { kind: 'session', message: { kind: 'session', session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } },
        sourceAudienceAccountIds: [accountId], sourceContentReady: true,
        discussionAudienceAccountIds: [accountId], missingDiscussionSourceAccountIds: [],
        discussionDisclosure: { ok: true }, canGrantSource: true,
        reviewers: request.reviewers.map(reviewer => ({ ...reviewer, sourceAccess: reviewer.sourceAccess ?? 'read',
          runtimeAccountId: accountId, audienceAccountIds: [accountId, 'new-reader'], missingSourceAccountIds: ['new-reader'],
          canGrantSource: true, disclosure: { ok: false, reason: 'destination_audience_broader' } })),
      }) } };
    } });
    await act(async () => screen.changeTextByTestId('second-opinion.question', 'An edited question'));
    await screen.pressByTestIdAsync('second-opinion.ask');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.changed')).not.toBeNull());
    expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
    expect(boundary.http.requestsFor('/v1/sessions/source-session/access/grants')).toHaveLength(0);
  } finally { await screen.unmount(); }
});

it('retains the edited question, reviewers and explicit placement across withdrawn and renewed same-Account credentials', async () => {
  const { screen, serverId, previewPath } = await mount({ pane: true });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  const placement = { machineId: 'review-machine', directory: '/explicit-review' };
  await act(async () => screen.findByType(WorkflowProjectTargetControl).props.onChange(placement));
  const question = 'Keep the question edited after choosing the reviewers';
  await act(async () => screen.changeTextByTestId('second-opinion.question', question));
  const release = createDeferred<void>();
  const originalRead = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
  const reader = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (...args) => {
    if (args[1]?.serverId === serverId) await release.promise;
    return originalRead(...args);
  });
  try {
    await act(async () => boundary.switchAccount(serverId, boundary.accountId(serverId)));
    expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
    expect(screen.findByTestId('second-opinion.question')?.props.value).toBe(question);
    expect(screen.findByType(WorkflowProjectTargetControl).props.target).toEqual(placement);
    const selectedDuringRenewal = screen.findAllByType(Item).filter(item => item.props.testID?.startsWith('second-opinion.reviewer:') && item.props.selected);
    expect(selectedDuringRenewal).toHaveLength(2);
    expect(selectedDuringRenewal.every(item => item.props.disabled)).toBe(true);
    const requests = boundary.http.requestsFor('/v1/discussions').length;
    await screen.pressByTestIdAsync('second-opinion.ask');
    expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(requests);
    await act(async () => release.resolve());
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    expect(screen.findByTestId('second-opinion.question')?.props.value).toBe(question);
    expect(screen.findByType(WorkflowProjectTargetControl).props.target).toEqual(placement);
    expect(screen.findAllByType(Item).filter(item => item.props.testID?.startsWith('second-opinion.reviewer:') && item.props.selected)).toHaveLength(2);
    await act(async () => setSharing(serverId, false));
    const previews = boundary.http.requestsFor(previewPath).length;
    await screen.pressByTestIdAsync('second-opinion.ask');
    expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(requests);
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(previews);
    await act(async () => setSharing(serverId, true));
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('second-opinion.ask');
    await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(requests));
    expect(boundary.http.requestsFor(previewPath).at(-1)?.input).toMatchObject({ reviewers: [expect.anything(), expect.anything()] });
  } finally {
    release.resolve(); reader.mockRestore(); await screen.unmount();
  }
});

it('withdraws hidden detail work on Session and Machine arrivals and reopens with current choices and the draft', async () => {
  const { screen, serverId, previewPath, setActive, commits } = await mount({ pane: true });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await act(async () => screen.changeTextByTestId('second-opinion.question', 'Retain the hidden draft'));
  await act(async () => setActive(false));
  const before = commits();
  const previews = boundary.http.requestsFor(previewPath).length;
  await act(async () => {
    storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId,
      [serverId]: Array.from({ length: 120 }, (_, index) => createMachineFixture({ id: `new-machine-${index}` })) } });
    boundary.setRows(serverId, Array.from({ length: 1000 }, (_, index) => `new-session-${index}`));
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    publishHomeAccountChange(serverId, ['new-session-0'], { sessionListQueryAffects: true });
  });
  await act(async () => {});
  expect(commits() - before).toBe(0);
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(previews);
  await act(async () => setActive(true));
  const { SelectionList } = await import('@/components/ui/selectionList');
  const choices = () => screen.findAllByType(SelectionList).find(node => node.props.testID === 'contextual-start-who')!
    .props.rootStep.sections.flatMap((section: { options?: readonly { id: string }[] }) => section.options ?? []).map((option: { id: string }) => option.id);
  // Machines are reached through Add an agent, which opens on a current Machine.
  await vi.waitFor(() => expect(choices()).toContain('who:add-agent'));
  await vi.waitFor(() => expect(choices()).toContain('session:new-session-0'));
  expect(screen.findByTestId('second-opinion.question')?.props.value).toBe('Retain the hidden draft');
  await screen.unmount();
});

it('keeps an Ask in flight while hidden and stops detail work after completion', async () => {
  const { screen, serverId, setActive, commits } = await mount({ pane: true });
  const thread = answerDiscussionThreadForTests(boundary.http, serverId, { accountId: boundary.accountId(serverId), loseCreate: false, loseFirstRejoin: false });
  boundary.http.answer(serverId, 'POST /v1/discussions/committed-thread/participants/invite', { body: {
    discussionId: 'committed-thread', ownerAccountId: boundary.accountId(serverId), access: 'owner', grants: [], changed: true,
  } });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  const release = createDeferred<void>();
  setRuntimeFetch(async (url, init) => {
    if (String(url).endsWith('/v1/discussions') && init?.method === 'POST') await release.promise;
    return boundary.http.request(url, init);
  });
  try {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('second-opinion.ask'));
    await vi.waitFor(() => expect(screen.findAllByType(RoundButton).find(button => button.props.testID === 'second-opinion.ask')?.props.loading).toBe(true));
    await act(async () => setActive(false));
    await act(async () => release.resolve());
    await vi.waitFor(() => expect(sourcePane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['discussion']));
    await act(async () => setActive(true));
    const previews = boundary.http.requestsFor('/v1/discussions/second-opinion/preview').length;
    await act(async () => storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId,
      [serverId]: [createMachineFixture({ id: 'after-completion' })] } }));
    expect(screen.findByTestId('contextual-start-composer')).toBeNull();
    expect(boundary.http.requestsFor('/v1/discussions/second-opinion/preview')).toHaveLength(previews);
    expect(boundary.http.requestsFor('/v1/discussions').filter(request => request.input != null)).toHaveLength(1);
    expect(thread.messages).toHaveLength(2);
  } finally {
    release.resolve(); await screen.unmount();
  }
});

it('adds an agent in place on this Session\'s Machine and folder, keeps its row through Change and cancel, and creates only on explicit Ask', async () => {
  // The answer's own Session is held, as it is whenever its answer is open.
  const { screen, serverId, previewPath } = await mount({ sheet: true });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  // Only what exists is listed: no default "new session on a Machine" rows (owner R2.1).
  expect(screen.findAllByType(Item).some(item => String(item.props.testID ?? '').startsWith('discussion-invite-model-'))).toBe(false);
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.pressByTestIdAsync('contextual-start-add-agent');
  await vi.waitFor(() => expect(screen.findAllByType(SessionServerStartDraftRecipeEditor)).toHaveLength(1));
  expect(screen.findByType(SessionServerStartDraftRecipeEditor).props).toMatchObject({
    target: { machineId: 'review-machine' }, seed: { directory: '/work' } });
  // Machine and folder are New Session's two chips and pickers (owner 2026-11-12), on the consumer's place.
  expect(screen.findAllByType(SessionPlacementChips).filter(chips => chips.props.serverId === serverId
    && chips.props.path === '/work')).toHaveLength(1);
  // The genuine presentation boundary returns the ordinary author's strict draft. It never allocates a Session.
  const draft = SessionServerStartSpawnDraftV1Schema.parse({ executionTarget: { serverId, machineId: 'review-machine' },
    directory: { kind: 'path', path: '/work' }, permissionMode: 'read-only', title: 'Migration reviewer',
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
  await act(async () => screen.findByType(SessionServerStartDraftRecipeEditor).props.onResolve(draft));
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  const previewInput = boundary.http.requestsFor(previewPath)[0]!.input as { reviewers: Array<{ selection: unknown; participantSlotId: string }> };
  expect(previewInput.reviewers).toEqual([{ selection: { kind: 'model', launch: expect.objectContaining({
    executionTarget: draft.executionTarget, permissionMode: 'read-only',
  }) }, participantSlotId: expect.any(String) }]);
  await screen.pressByTestIdAsync('second-opinion.change-model');
  expect(screen.findByType(SessionServerStartDraftRecipeEditor).props.seed.existingDraft).toMatchObject({ title: 'Migration reviewer' });
  await screen.pressByTestIdAsync('participant-recipe-cancel');
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(1);
  expect(screen.getTextContent()).toContain('Migration reviewer');
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  expect(boundary.http.requests.some(request => request.path.includes('/participants/invite'))).toBe(false);
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(0));
  const allPreviews = boundary.http.requestsFor(previewPath).map(request => request.input as { reviewers: unknown });
  expect(allPreviews.every(request => JSON.stringify(request.reviewers) === JSON.stringify(previewInput.reviewers))).toBe(true);
  await screen.unmount();
});

it('lists existing Sessions, each naming its type, with Add an agent as the last row', async () => {
  const { screen } = await mount();
  const { t } = await import('@/text');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  const rows = screen.findAllByType(Item).filter(item => /^(second-opinion\.reviewer:|contextual-start-add-agent$)/.test(item.props.testID ?? ''));
  // The type is a chip after the name, not a group heading the rows sit under.
  expect(rows.find(row => row.props.testID === 'second-opinion.reviewer:reviewer-session')?.props.titleAccessory?.props.label)
    .toBe(t('session.collaboration.discussion.participants.session'));
  expect(rows.at(-1)?.props.testID).toBe('contextual-start-add-agent');
  await screen.unmount();
});

it('lists a Bot after Sessions with the Bot chip and previews its ordinary Session identity', async () => {
  const { screen, serverId, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:unopened-session')).not.toBeNull());
  await act(async () => storage.getState().applySessions([createSessionFixture({ id: 'unopened-session', serverId,
    encryptionMode: 'plain', seq: 2, metadataVersion: 2, access: createSessionAccessFixture('owner'),
    metadata: { bot: { kind: 'bot' }, name: 'Release bot', machineId: 'review-machine', host: 'laptop', path: '/work', flavor: 'codex' },
  })]));
  const rows = () => screen.findAllByType(Item).filter(item => item.props.testID?.startsWith('second-opinion.reviewer:'));
  // The real listing owner may already have hydrated its next page. Every Session still precedes this Bot.
  expect(rows().map(row => row.props.testID)).toContain('second-opinion.reviewer:reviewer-session');
  expect(rows().at(-1)?.props.testID).toBe('second-opinion.reviewer:unopened-session');
  const bot = rows().find(row => row.props.testID === 'second-opinion.reviewer:unopened-session')!;
  expect(bot.props.titleAccessory?.props.label).toBe((await import('@/text')).t('sessionsList.conditionBot'));
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  const { SelectionList } = await import('@/components/ui/selectionList');
  expect(screen.findAllByType(SelectionList).find(node => node.props.testID === 'contextual-start-who')?.props.selection)
    .toEqual({ kind: 'multiple', selectedIds: new Set(['session:unopened-session']) });
  expect(boundary.http.requestsFor(previewPath)[0]!.input).toMatchObject({ reviewers: [{ selection: {
    kind: 'session', session: { serverId, sessionId: 'unopened-session' },
  } }] });
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('demands only the highlighted Session readiness and asks two reviewers as Fresh opinions where Workflows run', async () => {
  const { screen, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  expect(screen.findByTestId('second-opinion.reviewer:source-session')).toBeNull();
  // Compact lists open display metadata through the batch owner. Only a highlighted row
  // additionally demands fresh readiness; another listed Session must issue no extra read.
  const readsFor = (sessionId: string) => boundary.http.requests.filter(request =>
    request.path.split('?')[0] === `/v2/sessions/${sessionId}`).length;
  const reviewerReads = readsFor('reviewer-session');
  const unopenedReads = readsFor('unopened-session');
  const row = screen.findAllByTestId('second-opinion.reviewer:reviewer-session').find(node => typeof node.props.onHoverIn === 'function');
  if (!row) throw new Error('Expected the shared readiness hover boundary');
  await act(async () => row.props.onHoverIn());
  await vi.waitFor(() => expect(readsFor('reviewer-session')).toBeGreaterThan(reviewerReads));
  expect(readsFor('unopened-session')).toBe(unopenedReads);
  expect(boundary.http.requests.some(request => request.path.split('?')[0] === '/v1/sessions/unopened-session/turns')).toBe(false);
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(2));
  const { t } = await import('@/text');
  const ask = () => screen.findByTestId('second-opinion.ask');
  await vi.waitFor(() => expect(ask()?.props.disabled).toBe(false));
  expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.secondOpinion.askFreshOpinions', { count: 2 }));
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.pressByTestIdAsync('second-opinion.ask');
  // The Machine and folder Discussion Workflows run in is the multi-reviewer placement: without it the
  // composed Action refuses before any grant or create, so reaching create proves it travelled.
  await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(0));
  expect(screen.findAllByType(SurfaceStateCard).some(card => card.props.diagnosticCode === 'target_unavailable')).toBe(false);
  await screen.unmount();
});

it('keeps Fresh opinions from asking until it knows where to run, and surfaces the typed refusal', async () => {
  const { screen, serverId, previewPath } = await mount();
  storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId, [serverId]: [] } });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(2));
  expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
  expect(screen.findByTestId('second-opinion-machine-row')).not.toBeNull();
  // The controller boundary: a multi-reviewer Ask with no placement returns the Action's typed refusal.
  const { createDiscussionSecondOpinionController } = await import('./discussionSecondOpinionController');
  const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: boundary.accountId(serverId) },
    availability: 'available', source: { kind: 'session', message: { kind: 'session',
      session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } },
    draft: { title: 'Second opinion', question: 'Is this right?', reviewers: [
      { selection: { kind: 'session', session: { serverId, sessionId: 'reviewer-session' } } },
      { selection: { kind: 'session', session: { serverId, sessionId: 'unopened-session' } } }] } });
  await controller.preview();
  const refused = await controller.ask({ project: null });
  expect(refused).toEqual({ kind: 'failed', errorCode: 'target_unavailable' });
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('retains the actual preview refusal code on the shared sheet error state', async () => {
  const { screen, serverId, previewPath } = await mount();
  boundary.http.answer(serverId, `POST ${previewPath}`, {
    status: 403, body: { error: 'discussion_access_forbidden' },
  });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed')).not.toBeNull());
  await expectDiagnostic(screen, 'failed', 'discussion_access_forbidden');
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
  await screen.unmount();
});

it('retains the actual failed start code when the sheet holds partial progress', async () => {
  const { screen, serverId } = await mount();
  boundary.http.answer(serverId, 'POST /v1/discussions', {
    status: 403, body: { error: 'discussion_access_forbidden' },
  });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.pending')).not.toBeNull());
  await expectDiagnostic(screen, 'pending', 'discussion_access_forbidden');
  await screen.unmount();
});

it('uses newly available sharing on the same mounted sheet without losing question or reviewer selection', async () => {
  const { screen, serverId, previewPath } = await mount({ sharingEnabled: false });
  const question = 'Keep this edited question';
  act(() => screen.changeTextByTestId('second-opinion.question', question));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await expectDiagnostic(screen, 'failed', 'unsupported_action');
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  const selected = () => screen.findAllByType(Item).find(item => item.props.testID === 'second-opinion.reviewer:reviewer-session');
  expect(selected()?.props.selected).toBe(true);
  // A new canonical feature snapshot, without closing/reopening the Home or draft.
  await act(async () => setSharing(serverId, true));
  expect(screen.findByTestId('second-opinion.question')?.props.value).toBe(question);
  expect(selected()?.props.selected).toBe(true);
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(0));
  const previewInput = boundary.http.requestsFor(previewPath)[0]!.input as { reviewers: unknown[] };
  expect(previewInput.reviewers).toEqual([{ selection: { kind: 'session', session: { serverId, sessionId: 'reviewer-session' } } }]);
  expect(screen.findByTestId('second-opinion.question')?.props.value).toBe(question);
  await screen.unmount();
});

it('lets a retained Discuss draft preview, create and retry with the same identities after sharing changes', async () => {
  const { screen, serverId, previewPath } = await mount({ sharingEnabled: false, intent: 'discuss' });
  const thread = answerDiscussionThreadForTests(boundary.http, serverId, { accountId: boundary.accountId(serverId),
    loseCreate: true, loseFirstRejoin: false });
  await expectDiagnostic(screen, 'failed', 'unsupported_action');
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  await act(async () => setSharing(serverId, true));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed')).not.toBeNull());
  expect(thread.stored()?.firstMessage.content).toEqual({ t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'The source answer.' }] } });
  const creates = () => boundary.http.requestsFor('/v1/discussions').filter(request => request.input != null)
    .map(request => DiscussionCreateRequestV1Schema.parse(request.input));
  const original = creates()[0]!;
  await act(async () => setSharing(serverId, false));
  await act(async () => setSharing(serverId, true));
  const retry = screen.findAllByType(SurfaceStateCard).find(card => card.props.testID === 'second-opinion.failed')?.props.action;
  if (!retry) throw new Error('Expected the retained creation retry control');
  await act(async () => { retry.onPress(); });
  await vi.waitFor(() => expect(sourcePane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['discussion']));
  expect(creates()).toHaveLength(2);
  expect(creates().every(request => request.creationLocalId === original.creationLocalId
    && request.firstMessage.localId === original.firstMessage.localId)).toBe(true);
  expect(thread.messages).toHaveLength(1);
  expect(sourcePane.scopeState?.details.tabs).toEqual([expect.objectContaining({
    resource: { kind: 'discussion', target: { kind: 'discussion', address: { serverId, sessionId: 'source-session' },
      discussionId: thread.stored()!.discussion.id, messageId: thread.messages[0]!.id } },
  })]);
  await screen.unmount();
});

it('keeps an unavailable sheet closed when another Home publishes sharing enabled', async () => {
  const { screen, previewPath } = await mount({ sharingEnabled: false });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await expectDiagnostic(screen, 'failed', 'unsupported_action');
  await act(async () => setSharing(boundary.serverIds[2]!, true));
  expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('recovers after availability changes during a pending preview without replacing the selected reviewer', async () => {
  const { screen, serverId, previewPath } = await mount();
  const release = createDeferred<void>();
  let pending = true;
  boundary.http.answer(serverId, `POST ${previewPath}`, { select: input => {
    if (pending) return { respondAfter: release.promise, status: 503, body: { error: 'unsupported_action' } };
    const request = input as { source: unknown; reviewers: Array<{ selection: unknown }> };
    return { body: { ok: true, value: DiscussionSecondOpinionPreviewV1Schema.parse({ source: request.source,
      sourceAudienceAccountIds: [boundary.accountId(serverId)], sourceContentReady: true,
      discussionAudienceAccountIds: [boundary.accountId(serverId)], missingDiscussionSourceAccountIds: [],
      discussionDisclosure: { ok: true }, canGrantSource: true, reviewers: request.reviewers.map(reviewer => ({
        ...reviewer, sourceAccess: 'read', runtimeAccountId: boundary.accountId(serverId),
        audienceAccountIds: [boundary.accountId(serverId)], missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true },
      })) }) } };
  } });
  try {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
    await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
    await act(async () => setSharing(serverId, false));
    pending = false;
    await act(async () => setSharing(serverId, true));
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(1);
    expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
    await act(async () => release.resolve());
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(2);
    const inputs = boundary.http.requestsFor(previewPath).map(request => request.input);
    expect(inputs[1]).toEqual(inputs[0]);
    await act(async () => setSharing(serverId, true));
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(2);
    expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  } finally {
    release.resolve();
    await screen.unmount();
  }
});

it('refuses an already previewed Ask when sharing becomes disabled on its Home', async () => {
  const { screen, serverId, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  const previews = boundary.http.requestsFor(previewPath).length;
  await act(async () => setSharing(serverId, false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await expectDiagnostic(screen, 'failed', 'unsupported_action');
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(previews);
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('does not let a retained Ask use a replacement Account on the same Home', async () => {
  const { screen, serverId } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  const action = screen.findAllByType(RoundButton).find(button => button.props.testID === 'second-opinion.ask')?.props.action;
  expect(typeof action).toBe('function');
  await act(async () => { await boundary.switchAccount(serverId, 'replacement-account'); });
  await act(async () => { await action(); });
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('rechecks source access before creating from a previously successful preview', async () => {
  const { screen, serverId, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  boundary.http.answer(serverId, `POST ${previewPath}`, { status: 403, body: { error: 'discussion_access_forbidden' } });
  await screen.pressByTestIdAsync('second-opinion.ask');
  await expectDiagnostic(screen, 'pending', 'discussion_access_forbidden');
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});
