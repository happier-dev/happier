import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { DiscussionParticipantManagement } from '@/components/discussions/DiscussionParticipantsPopover';
import type { SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { HappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Platform: { OS: 'android', select: <T,>(options: { android?: T; default?: T; native?: T }) => options.android ?? options.native ?? options.default },
}));

// Match app startup: install transport boundaries, initialize Sync, then load runtime consumers.
await loadSyncSingletonForTests();
const { ExecutableParticipantSelectionV1Schema } = await import('@happier-dev/protocol/discussions/executableParticipants');
const { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createPlainSessionWithDisplayRecordFixture } = await import('@/dev/testkit/fixtures/sessionDisplayFixtures');
const { storage } = await import('@/sync/domains/state/storageStore');
const { DiscussionParticipantsListResponseV1Schema } = await import('@happier-dev/protocol/discussions/participants');
const { DiscussionInviteButton } = await import('@/components/discussions/DiscussionInviteSheet');
const { createSessionListQuerySourceHarness } = await import('@/dev/testkit/harness/sessionListQuerySourceHarness');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useInlineExecutableParticipantPicker } = await import('./useInlineExecutableParticipantPicker');
const { ContextualStartComposerBody } = await import('./ContextualStartComposer');
let openParticipantPicker: ReturnType<typeof useInlineExecutableParticipantPicker>['pick'];
function InlinePickerHost() {
  const picker = useInlineExecutableParticipantPicker();
  React.useLayoutEffect(() => { openParticipantPicker = picker.pick; }, [picker.pick]);
  return picker.body;
}
const { useExecutableParticipantSections } = await import('@/components/discussions/useExecutableParticipantSections');
const { SessionServerStartSpawnDraftV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { parseDecryptedSessionMetadata } = await import('@/sync/engine/sessions/parsePlainSessionPayload');
const { Modal } = await import('@/modal');
let boundary: SessionListQuerySourceHarness;
beforeEach(async () => {
  boundary = await createSessionListQuerySourceHarness();
});
afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); await boundary.dispose(); });

async function captureHome(home = boundary.serverIds[1]!) {
  boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
  const hook = await renderHook(() => useServerCredentialAccountScopeBindings([home]));
  await vi.waitFor(() => expect(hook.getCurrent().get(home)?.isCurrent()).toBe(true));
  return hook.getCurrent().get(home)!;
}

describe('inline executable participant selection', () => {
  it('finds a renamed owner Session by its current title while Browse is open', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['renamed-reviewer']);
    const screen = await renderScreen(<InlinePickerHost />);
    let result!: ReturnType<typeof openParticipantPicker>;
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: false,
      signal: new AbortController().signal }); });
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:renamed-reviewer')).not.toBeNull());
    await act(async () => storage.getState().applySessions([createSessionFixture({
      id: 'renamed-reviewer', serverId: home, encryptionMode: 'plain', seq: 2, metadataVersion: 2,
      metadataLayoutVersion: 1, metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
      ownerMetadataView: { name: 'REPLAY3-ASK-1107', machineId: 'run-host', path: '/work', host: 'run-host' },
      access: createSessionAccessFixture('owner'),
    })]));
    await screen.changeTextByTestId('executable-participant-picker-search', 'REPLAY3');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:renamed-reviewer')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:renamed-reviewer');
    await expect(result).resolves.toEqual({ kind: 'session', session: { serverId: home, sessionId: 'renamed-reviewer' } });
    await screen.unmount();
  });

  it('cancels Back and unmount through the existing pending input port, retaining the caller value', async () => {
    const accountLifetime = await captureHome();
    const selected = ExecutableParticipantSelectionV1Schema.parse({ kind: 'session', session: {
      serverId: accountLifetime.scope.serverId, sessionId: 'existing-reviewer',
    } });
    const screen = await renderScreen(<InlinePickerHost />);
    let result!: ReturnType<typeof openParticipantPicker>;
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: true, selected,
      signal: new AbortController().signal }); });
    await screen.pressByTestIdAsync('executable-participant-picker-back');
    await expect(result).resolves.toBeNull();
    expect(screen.findByTestId('executable-participant-picker')).toBeNull();
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: true, selected,
      signal: new AbortController().signal }); });
    await screen.pressByTestIdAsync('executable-participant-picker-done');
    await expect(result).resolves.toEqual([selected]);
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: false,
      signal: new AbortController().signal }); });
    await screen.unmount();
    await expect(result).resolves.toBeNull();
  });

  it('browses Back and selects a capture step participant inline without starting work', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['capture-reviewer']);
    const { DiscussionPatternCapturePanel } = await import('@/components/discussions/DiscussionPatternCapturePanel');
    const { WorkflowDefinitionCaptureResultV1Schema } = await import('@happier-dev/protocol/workflows/actionsV1');
    const discussion = { serverId: home, discussionId: 'captured-discussion' };
    const source = { kind: 'discussion', discussion, messageId: 'captured-answer' } as const;
    const draft = WorkflowDefinitionCaptureResultV1Schema.parse({ status: 'needs_review', name: 'Review', definition: null,
      steps: [{ messageId: source.messageId, source, role: 'step', text: 'Review the patch',
        dependsOnMessageIds: [], perRun: true }], inputs: {},
      unresolved: [{ messageId: source.messageId, reason: 'participant_required' }],
      provenance: { discussion, messages: [{ source, authorAccountId: accountLifetime.scope.accountId }] } });
    const review = vi.fn(async () => undefined);
    const capture: React.ComponentProps<typeof DiscussionPatternCapturePanel>['capture'] = {
      state: { status: 'review', request: { discussion, messageIds: [source.messageId] }, draft, error: null },
      canOpenEditor: false, open: async () => undefined, close: () => undefined, review,
      setInputPerRun: () => undefined, openEditor: () => undefined,
    };
    const before = vi.mocked(Modal.show).mock.calls.length;
    const screen = await renderScreen(<DiscussionPatternCapturePanel capture={capture} accountLifetime={accountLifetime}
      anchorRef={React.createRef()} discussionTitle="Review" messages={[]} />);
    await screen.pressByTestIdAsync('discussion-pattern-capture-participant:captured-answer');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:capture-reviewer')).not.toBeNull());
    await screen.pressByTestIdAsync('executable-participant-picker-back');
    expect(review).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('discussion-pattern-capture-participant:captured-answer');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:capture-reviewer')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:capture-reviewer');
    expect(review).toHaveBeenCalledWith({ choices: [{ messageId: source.messageId, role: 'step', participant: {
      kind: 'session', session: { serverId: home, sessionId: 'capture-reviewer' },
    } }] });
    expect(screen.findByTestId('executable-participant-picker')).toBeNull();
    expect(vi.mocked(Modal.show).mock.calls).toHaveLength(before);
    expect(boundary.http.requests.filter(request => /spawn|participants\/invite/.test(request.path))).toHaveLength(0);
    await screen.unmount();
  });

  it('authors a selected model in its current host with no nested modal and no Session admission', async () => {
    const accountLifetime = await captureHome();
    const serverId = accountLifetime.scope.serverId;
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'inline-model', active: false, activeAt: 0 })] } });
    const screen = await renderScreen(<InlinePickerHost />);
    let result!: ReturnType<typeof openParticipantPicker>;
    const resolved = vi.fn();
    await act(async () => {
      result = openParticipantPicker({ accountLifetime, multiple: true, signal: new AbortController().signal });
      void result.then(resolved);
    });
    const before = vi.mocked(Modal.show).mock.calls.length;
    await vi.waitFor(() => expect(screen.findByTestId('contextual-start-add-agent')).not.toBeNull());
    await screen.pressByTestIdAsync('contextual-start-add-agent');
    const { SessionServerStartDraftComposerBody } = await import('@/components/sessions/new/SessionServerStartDraftComposerBody');
    await vi.waitFor(() => expect(screen.findAllByType(SessionServerStartDraftComposerBody)).toHaveLength(1));
    expect(screen.findByTestId('executable-participant-picker')).not.toBeNull();
    expect(vi.mocked(Modal.show).mock.calls).toHaveLength(before);
    expect(resolved).not.toHaveBeenCalled();
    expect(boundary.http.requests.some(request => request.path.includes('/spawn') || request.path.includes('/participants/invite'))).toBe(false);
    await screen.pressByTestIdAsync('participant-recipe-cancel');
    expect(screen.findAllByType(SessionServerStartDraftComposerBody)).toHaveLength(0);
    expect(screen.findByTestId('executable-participant-picker')).not.toBeNull();
    expect(resolved).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('executable-participant-picker-back');
    await expect(result).resolves.toBeNull();
    await screen.unmount();
  });

  it.each([
    { target: 'run-host', active: true, expected: 'run-host', offline: false },
    { target: 'run-host', active: false, expected: 'run-host', offline: true },
    { target: 'foreign-only', active: true, expected: 'prior-host', offline: false },
  ])('keeps public presenter target $target with active=$active on its captured Home', async ({ target, active, expected, offline }) => {
    const accountLifetime = await captureHome();
    const foreign = await captureHome(boundary.serverIds[0]!);
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['prior-agent']);
    await publishMachineInventoryForTest(accountLifetime.scope, [
      createMachineFixture({ id: 'prior-host', active: true, activeAt: Date.now() }),
      createMachineFixture({ id: 'run-host', active, activeAt: active ? Date.now() : 0 }),
    ]);
    await publishMachineInventoryForTest(foreign.scope, [
      createMachineFixture({ id: 'foreign-only', active: true, activeAt: Date.now() }),
    ]);
    const session = createSessionFixture({ id: 'prior-agent', serverId: home,
      encryptionMode: 'plain', seq: 2, metadataVersion: 2, metadataLayoutVersion: 1,
      metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1),
      ownerMetadataView: { machineId: 'prior-host', path: '/work', host: 'prior-host' },
      access: createSessionAccessFixture('owner') });
    const screen = await renderScreen(<InlinePickerHost />);
    const controller = new AbortController();
    let result!: ReturnType<typeof openParticipantPicker>;
    await act(async () => { result = openParticipantPicker({ accountLifetime, machineId: target,
      multiple: false, signal: controller.signal }); });
    await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[home]?.['prior-agent']).toBeDefined());
    await act(async () => storage.getState().applySessions([session]));
    
    // Add an agent starts on the run's Machine when this Home has it, else on one of this Home's Machines.
    await vi.waitFor(() => expect(screen.findByTestId('contextual-start-add-agent')).not.toBeNull());
    await screen.pressByTestIdAsync('contextual-start-add-agent');
    const { SessionServerStartDraftRecipeEditor } = await import('@/components/sessions/new/SessionServerStartDraftRecipeEditor');
    await vi.waitFor(() => expect(screen.findAllByType(SessionServerStartDraftRecipeEditor)).toHaveLength(1));
    const machineId = screen.findByType(SessionServerStartDraftRecipeEditor).props.target.machineId;
    if (target === 'foreign-only') expect(['prior-host', 'run-host']).toContain(machineId);
    else expect(machineId).toBe(expected);
    // A Machine that cannot start the agent says so under the chips.
    await vi.waitFor(() => expect(screen.findByTestId('server-start-draft-machine-not-ready') !== null).toBe(offline));
    await act(async () => controller.abort());
    await expect(result).resolves.toBeNull();
    await screen.unmount();
  });

  it('passes the invoking Run machine rather than the plugin projection relay to participant setup', async () => {
    const accountLifetime = await captureHome();
    const { InputTypePickerHostProvider } = await import('@/components/sessions/actions/InputTypePickerHostProvider');
    const { useHappierInputPickerPort } = await import('@happier-dev/plugin-ui/presentation');
    const picker: { current: HappierInputPickerPort | null } = { current: null };
    function ParticipantPortProbe() {
      const port = useHappierInputPickerPort();
      React.useEffect(() => { picker.current = port; }, [port]);
      return null;
    }
    const pickAgentParticipant = vi.fn(async () => null);
    const screen = await renderScreen(<InputTypePickerHostProvider enabled
      accountLifetime={accountLifetime} serverId={accountLifetime.scope.serverId}
      machineId="run-host" pluginUiMachineId="catalog-relay" pluginUiProjection={null}
      pickAgentParticipant={pickAgentParticipant}>
      <ParticipantPortProbe />
    </InputTypePickerHostProvider>);
    expect(picker.current).not.toBeNull();
    await act(async () => { await picker.current!.pick({
      field: { path: 'participants', title: 'Participants', widget: 'multiselect', inputType: { hostType: 'agentParticipant' } },
      value: undefined, signal: new AbortController().signal,
    }); });
    expect(pickAgentParticipant).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'run-host', serverId: accountLifetime.scope.serverId, accountLifetime,
    }));
    await screen.unmount();
  });

  it('withdraws a model setup result when its actual captured Account retires before selection', async () => {
    const accountLifetime = await captureHome();
    const serverId = accountLifetime.scope.serverId;
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'late-model', active: false, activeAt: 0 })] } });
    const choose = vi.fn();
    let source!: ReturnType<typeof useExecutableParticipantSections>;
    function Host() {
      source = useExecutableParticipantSections({ accountLifetime, enabled: true, sessionsContext: 'Reviewer', onChoose: choose });
      return source.recipeEditor;
    }
    const screen = await renderScreen(<Host />);
    await vi.waitFor(() => expect(source.addAgent).not.toBeNull());
    await act(async () => source.addAgent?.());
    const { SessionServerStartDraftRecipeEditor } = await import('@/components/sessions/new/SessionServerStartDraftRecipeEditor');
    await vi.waitFor(() => expect(screen.findAllByType(SessionServerStartDraftRecipeEditor)).toHaveLength(1));
    const complete = screen.findByType(SessionServerStartDraftRecipeEditor).props.onResolve;
    await act(async () => { await boundary.http.switchAccount(serverId, 'replacement-account'); });
    await vi.waitFor(() => expect(accountLifetime.isCurrent()).toBe(false));
    const draft = SessionServerStartSpawnDraftV1Schema.parse({ executionTarget: { serverId, machineId: 'late-model' },
      directory: { kind: 'path', path: '/work' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
    await act(async () => complete(draft));
    expect(choose).not.toHaveBeenCalled();
    await screen.unmount();
  });
  it('demands an existing Session from the real Discussion participant sheet', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['discussion-bot', 'unopened-bot']);
    for (const id of ['discussion-bot', 'unopened-bot']) {
      const session = createSessionFixture({ id, serverId: home, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex',
          summary: { text: `Display ${id}`, updatedAt: 1 } }, access: createSessionAccessFixture('owner') });
      const response = createPlainSessionByIdResponseFixture(session);
      // Readiness is measured independently of the separate display-backfill lifecycle.
      const { displayProjectionV1 } = createPlainSessionWithDisplayRecordFixture({
        id, metadata: session.metadata, metadataVersion: session.metadataVersion,
      });
      boundary.http.answer(home, `/v2/sessions/${id}`, { body: {
        session: { ...response.session, displayProjectionV1 },
      } });
    }
    storage.setState({ machineListByServerId: { [home]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'discussion',
      ownerAccountId: accountLifetime.scope.accountId, access: 'owner', grants: [], participants: [] });
    const noEffect = async () => undefined;
    // Controlled management inputs are inert here: this test exercises highlight reads, never invitation.
    const management: DiscussionParticipantManagement = { roster, status: 'ready', errorCode: null, operation: { kind: 'idle' },
      modelParticipants: [], ownerLeave: { kind: 'closed' }, refresh: noEffect, inviteExecutable: noEffect,
      setPolicy: noEffect, remove: noEffect, sessionAddress: () => null, requestLeave: noEffect,
      transferAndLeave: noEffect, archiveInsteadOfLeave: noEffect, cancelLeave: () => true, retry: noEffect };
    const screen = await renderScreen(<DiscussionInviteButton scope={accountLifetime.scope} accountLifetime={accountLifetime}
      discussionId="discussion" discussionTitle="Release review" roster={roster} management={management}
       />);
    await screen.pressByTestIdAsync('session-discussion-invite');
    await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-session-discussion-bot')).not.toBeNull());
    await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-session-unopened-bot')).not.toBeNull());
    await vi.waitFor(() => {
      expect(screen.getTextContent()).toContain('Display discussion-bot');
      expect(screen.getTextContent()).toContain('Display unopened-bot');
    });
    // Compact list rows demand visible display documents before readiness is opened.
    // Measure the additional authoritative read caused by highlighting one row.
    const reads = () => boundary.http.requests.filter(request => /^\/v2\/sessions\/(discussion-bot|unopened-bot)$/.test(request.path.split('?')[0]!));
    const displayReads = reads().length;
    const row = screen.findAllByTestId('discussion-invite-session-discussion-bot').find(node => typeof node.props.onHoverIn === 'function');
    if (!row) throw new Error('Expected the Discussion option hover boundary');
    await act(async () => row.props.onHoverIn());
    await vi.waitFor(() => expect(reads().slice(displayReads).map(request => request.path.split('?')[0]))
      .toEqual(['/v2/sessions/discussion-bot']));
    await vi.waitFor(async () => expect(screen.getTextContent()).toContain(
      (await import('@/text')).t('session.collaboration.readiness.cause.machineOffline')));
    await screen.unmount();
  });
  it('demands only the highlighted existing Session through the real picker host', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['first-bot', 'second-bot']);
    storage.setState({ machineListByServerId: { [home]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    for (const id of ['first-bot', 'second-bot']) {
      const session = createSessionFixture({ id, serverId: home, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex',
          summary: { text: `Display ${id}`, updatedAt: 1 } }, access: createSessionAccessFixture('owner') });
      const response = createPlainSessionByIdResponseFixture(session);
      const { displayProjectionV1 } = createPlainSessionWithDisplayRecordFixture({
        id, metadata: session.metadata, metadataVersion: session.metadataVersion,
      });
      boundary.http.answer(home, `/v2/sessions/${id}`, { body: {
        session: { ...response.session, displayProjectionV1 },
      } });
    }
    const reads = () => boundary.http.requests.filter(request => /^\/v2\/sessions\/(first-bot|second-bot)$/.test(request.path.split('?')[0]!));
    const screen = await renderScreen(<InlinePickerHost />);
    const signal = new AbortController();
    let result!: ReturnType<typeof openParticipantPicker>;
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: true, signal: signal.signal }); });
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:first-bot')).not.toBeNull());
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:second-bot')).not.toBeNull());
    await vi.waitFor(() => {
      expect(screen.getTextContent()).toContain('Display first-bot');
      expect(screen.getTextContent()).toContain('Display second-bot');
    });
    // The list has opened its compact-row display documents; readiness is a fresh read.
    const displayReads = reads().length;
    const row = screen.findAllByTestId('second-opinion.reviewer:first-bot').find(node => typeof node.props.onHoverIn === 'function');
    if (!row) throw new Error('Expected the real participant option hover boundary');
    await act(async () => row.props.onHoverIn());
    await vi.waitFor(() => expect(reads().slice(displayReads).map(request => request.path.split('?')[0])).toEqual(['/v2/sessions/first-bot']));
    expect(screen.getTextContent()).toContain((await import('@/text')).t('session.collaboration.readiness.cause.machineOffline'));
    await act(async () => signal.abort());
    await expect(result).resolves.toBeNull();
    expect(reads().slice(displayReads).some(request => request.path.split('?')[0]?.endsWith('/second-bot'))).toBe(false);
    await screen.unmount();
  });
  it('says a Session read failed in the real picker and recovers the choices from its Retry', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['recovered-bot']);
    boundary.failQueries(home, 'all');
    const screen = await renderScreen(<InlinePickerHost />);
    const signal = new AbortController();
    let result!: ReturnType<typeof openParticipantPicker>;
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: true, signal: signal.signal }); });
    const { t } = await import('@/text');
    await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-sessions-retry')).not.toBeNull());
    expect(screen.getTextContent()).toContain(t('workflows.conversation.sessionsFailed'));
    expect(screen.findByTestId('discussion-invite-sessions-more')).toBeNull();
    boundary.failQueries(home, null);
    await screen.pressByTestIdAsync('discussion-invite-sessions-retry');
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:recovered-bot')).not.toBeNull());
    expect(screen.findByTestId('discussion-invite-sessions-retry')).toBeNull();
    await act(async () => signal.abort());
    await expect(result).resolves.toBeNull();
    await screen.unmount();
  });
  it('confirms an already configured model without a selected Session option id', async () => {
    const accountLifetime = await captureHome();
    const selected = ExecutableParticipantSelectionV1Schema.parse({ kind: 'model', launch: {
      executionTarget: { serverId: accountLifetime.scope.serverId, machineId: 'model-machine' },
      directory: { kind: 'path', path: '/work' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    } });
    const screen = await renderScreen(<InlinePickerHost />);
    let result!: ReturnType<typeof openParticipantPicker>;
    await act(async () => { result = openParticipantPicker({ accountLifetime, selected, multiple: true, signal: new AbortController().signal }); });
    expect(screen.findByTestId('executable-participant-picker-done')?.props.disabled).toBe(false);
    await act(async () => screen.pressByTestId('executable-participant-picker-done'));
    await expect(result).resolves.toEqual([selected]);
    await screen.unmount();
  });

  it('returns the selected captured-Home Session immediately without a separate confirmation', async () => {
    const accountLifetime = await captureHome();
    boundary.setRows(accountLifetime.scope.serverId, ['review-session']);
    const screen = await renderScreen(<InlinePickerHost />);
    let result!: ReturnType<typeof openParticipantPicker>;
    const presentations = vi.mocked(Modal.show).mock.calls.length;
    await act(async () => { result = openParticipantPicker({ accountLifetime, multiple: false, signal: new AbortController().signal }); });
    // F U3: the host's Browse mounts the same participant body in its current surface.
    expect(vi.mocked(Modal.show).mock.calls).toHaveLength(presentations);
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:review-session')).not.toBeNull());
    expect(screen.findByTestId('executable-participant-picker-done')).toBeNull();
    await act(async () => screen.pressByTestId('second-opinion.reviewer:review-session'));
    await expect(result).resolves.toEqual({ kind: 'session', session: { serverId: accountLifetime.scope.serverId, sessionId: 'review-session' } });
    await screen.unmount();
  });
});
