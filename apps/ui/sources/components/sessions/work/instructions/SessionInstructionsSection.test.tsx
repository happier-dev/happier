import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionPromptStackV1StoredSchema } from '@happier-dev/protocol/sessions/context/sessionContextV1';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { Modal } from '@/modal';
import type { SessionInstructionsSource } from '../useSessionInstructionsSource';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const actionOutcomes = vi.hoisted(() => ({ results: [] as ActionExecuteResult[] }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});
vi.mock('@react-navigation/native', async importOriginal => ({
  ...await importOriginal<typeof import('@react-navigation/native')>(),
  ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
}));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  const create = createFrontDoorActionExecuteForVitest(original);
  return { ...original, createFrontDoorActionExecute: (...args: Parameters<typeof create>) => {
    const execute = create(...args);
    return Object.assign(async (...operation: Parameters<typeof execute>) => {
      const result = await execute(...operation);
      actionOutcomes.results.push(result);
      return result;
    }, { prepare: execute.prepare });
  } };
});
// Install the genuine transport boundary before eager Account harness imports.
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const originalState = storage.getState();

afterEach(() => {
  standardCleanup();
  navigation.push.mockClear();
  actionOutcomes.results.length = 0;
  storage.setState(originalState, true);
});

const { SessionInstructionsBody, resolveSessionInstructionsAccess } =
  await import('./SessionInstructionsSection');

const ref = {
  kind: 'doc',
  serverId: 'home-a',
  artifactId: 'instructions-doc',
} as const;
const revision = { headerVersion: 2, bodyVersion: 3 };
function source(
  overrides: Partial<SessionInstructionsSource>,
): SessionInstructionsSource {
  return {
    status: 'none',
    document: null,
    stale: false,
    ref: null,
    retry: async () => {},
    ...overrides,
  } as SessionInstructionsSource;
}
function documentOf(markdown: string) {
  return {
    ok: true,
    artifactId: 'instructions-doc',
    title: 'Release captain',
    markdown,
    revision,
  } as unknown as NonNullable<SessionInstructionsSource['document']>;
}

async function render(state: SessionInstructionsSource, serverId = 'home-a') {
  const session = createSessionFixture({ id: 'bot', serverId });
  return renderScreen(
    <SessionInstructionsBody
      session={session}
      serverId={serverId}
      source={state}
    />,
  );
}

describe('Work › Instructions', () => {
  it.each(['approve', 'reject'] as const)('continues Work Instructions Create after its document approval (%s)', async decision => {
    const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
    const fixture = await createPlainArtifactHomeFixture(`https://work-instructions-${decision}.test`, {
      handleRequest: async (path, init) => {
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
          actionsSettingsV1: { v: 1, actions: { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } },
        } } });
        return sessionRequest(`https://work-instructions-${decision}.test${path}`, init);
      },
    });
    try {
      // The app entry loads Sync before mounting Work; keep its metadata writer real here too.
      await loadSyncSingletonForTests();
      await fixture.hydrateAccountSettings();
      const session = createSessionFixture({ id: 'bot', serverId: fixture.home.id, metadataVersion: 1,
        metadata: { path: '/worktree', host: 'localhost', work: { promptStack: [{ id: 'neighbor',
          ref: { kind: 'doc', artifactId: 'neighbor-doc' }, enabled: true, placement: 'system_append' }] } } });
      storage.setState({ sessions: { ...storage.getState().sessions, bot: session } });
      const screen = await renderScreen(<SessionInstructionsBody session={session} serverId={fixture.home.id} source={source({})} />);
      await screen.pressByTestIdAsync('session-work-instructions.create');
      const rowsOfKind = (kind: string) => fixture.boundary.list().filter(row => {
        const header = decodePlainArtifactStoredContent(row.header);
        return header && typeof header === 'object' && 'kind' in header && header.kind === kind;
      });
      await vi.waitFor(() => expect(rowsOfKind('approval_request.v1')).toHaveLength(1));
      expect(rowsOfKind('prompt_doc.v2')).toHaveLength(0);
      expect(sessionHttp.writes).toEqual([]);
      expect(navigation.push).not.toHaveBeenCalled();
      const approvalId = rowsOfKind('approval_request.v1')[0]!.id;
      // Inbox decides and replays the approved create through the shared
      // lifecycle; the mounted writer resumes attachment from its terminal result.
      expect(await decideApprovalAsInbox(fixture.home.id, approvalId, decision))
        .toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed' : 'rejected' } });
      if (decision === 'approve') {
        await vi.waitFor(() => expect(ApprovalRequestV2Schema.parse(JSON.parse(
          fixture.boundary.readPlainBody(approvalId)!,
        ))).toMatchObject({ status: 'executed', execution: { ok: true } }));
        await vi.waitFor(() => expect(navigation.push, JSON.stringify({ outcomes: actionOutcomes.results,
          writes: sessionHttp.writes,
          refusal: ['conflict', 'refused', 'failed'].filter(reason => screen.findByTestId(`session-work-instructions.${reason}`))
        })).toHaveBeenCalledTimes(1));
        const created = rowsOfKind('prompt_doc.v2');
        expect(created).toHaveLength(1);
        expect(navigation.push).toHaveBeenCalledWith(`/settings/prompts/docs/${created[0]!.id}?serverId=${fixture.home.id}`);
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const work = readSessionOwnerMetadataView(storage.getState().sessions.bot!)?.work;
        if (!work || typeof work !== 'object' || !('promptStack' in work)) throw new Error('Expected retained Session prompt stack');
        expect(SessionPromptStackV1StoredSchema.parse(work.promptStack)).toMatchObject([
          { id: 'neighbor', ref: { artifactId: 'neighbor-doc' } },
          { id: 'session.instructions', ref: { artifactId: created[0]!.id, serverId: fixture.home.id } },
        ]);
      } else {
        await vi.waitFor(() => expect(screen.findByTestId('session-work-instructions.failed')).not.toBeNull());
        expect(rowsOfKind('prompt_doc.v2')).toHaveLength(0);
        expect(sessionHttp.writes).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();
      }
      await screen.unmount();
    } finally { standardCleanup(); await fixture.dispose(); }
  });

  it('admits the exact Agent edits mode and preserves current neighboring Account policies', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ actionsSettingsV1: { v: 1, actions: {} } }));
    try {
      const screen = await render(source({ status: 'ready', ref, document: documentOf('Current instructions') }), account.scope.serverId);
      await act(async () => account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1, actions: {
        'prompt_doc.create': { disabledSurfaces: ['mcp'] },
        'prompt_doc.update': { disabledSurfaces: ['cli'] },
      } } })));
      await screen.pressByTestIdAsync('session-work-instructions.agentEdits:mode:allowed');
      await act(async () => {
        await vi.waitFor(() => expect(actionOutcomes.results).toMatchObject([{ ok: true,
          result: { anchor: 'actions.promptDocAgentEdits', value: 'allowed' } }]));
      });
      await act(async () => {
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toContain('agent'));
      });
      expect(account.persistedSettings.actionsSettingsV1.actions['prompt_doc.create']?.disabledSurfaces).toEqual(['mcp']);
      expect(account.persistedSettings.actionsSettingsV1.actions['prompt_doc.update']?.disabledSurfaces).toEqual(['cli']);
    } finally { standardCleanup(); await account.dispose(); }
  });

  it('does not bypass disabled settings.set when changing Agent edits', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ actionsSettingsV1: { v: 1, actions: {
      'settings.set': { disabledSurfaces: ['ui'] },
    } } }));
    try {
      const screen = await render(source({ status: 'ready', ref, document: documentOf('Current instructions') }), account.scope.serverId);
      await screen.pressByTestIdAsync('session-work-instructions.agentEdits:mode:allowed');
      await act(async () => {
        await vi.waitFor(() => expect(screen.findByTestId('session-work-instructions.refused')).toBeTruthy());
      });
      expect(actionOutcomes.results).toMatchObject([{ ok: false, errorCode: 'action_disabled' }]);
      expect(account.settings.actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update'] ?? []).not.toContain('agent');
      expect(account.writes).toEqual([]);
    } finally { standardCleanup(); await account.dispose(); }
  });

  it('renders an attached document in place with its source line, and Edit opens the Prompt Library editor', async () => {
    const screen = await render(
      source({
        status: 'ready',
        ref,
        document: documentOf('You look after releases.'),
      }),
    );
    expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
    expect(screen.getTextContent()).toContain('sessionInstructions.source');
    await screen.pressByTestIdAsync('session-work-instructions.edit');
    expect(navigation.push).toHaveBeenCalledWith(
      '/settings/prompts/docs/instructions-doc?serverId=home-a',
    );
  });

  it('keeps the last body while refreshing or unreachable, and never shows it as a failure', async () => {
    const refreshing = await render(
      source({
        status: 'refreshing',
        ref,
        stale: true,
        document: documentOf('Last version'),
      }),
    );
    expect(
      refreshing.findByTestId('session-work-instructions.refreshing'),
    ).toBeTruthy();
    expect(
      refreshing.findByTestId('session-work-instructions.body'),
    ).toBeTruthy();
    standardCleanup();
    const offline = await render(
      source({
        status: 'unavailable',
        ref,
        stale: true,
        document: documentOf('Last version'),
      }),
    );
    expect(
      offline.findByTestId('session-work-instructions.stale'),
    ).toBeTruthy();
    expect(offline.findByTestId('session-work-instructions.body')).toBeTruthy();
  });

  it('offers Detach for a healthy attachment without hiding the document', async () => {
    const screen = await render(source({ status: 'ready', ref, document: documentOf('Current instructions') }));
    expect(screen.findByTestId('session-work-instructions.detach')).toBeTruthy();
    await screen.pressByTestIdAsync('session-work-instructions.detach');
    expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
  });

  it('distinguishes a valid empty document, no attachment, a deleted document and owner-private instructions', async () => {
    const empty = await render(
      source({ status: 'ready', ref, document: documentOf('  ') }),
    );
    expect(empty.findByTestId('session-work-instructions.empty')).toBeTruthy();
    expect(empty.findByTestId('session-work-instructions.body')).toBeNull();
    standardCleanup();
    const none = await render(source({ status: 'none' }));
    expect(none.findByTestId('session-work-instructions.create')).toBeTruthy();
    standardCleanup();
    const missing = await render(source({ status: 'not_found' }));
    expect(
      missing.findByTestId('session-work-instructions.not_found'),
    ).toBeTruthy();
    expect(
      missing.findByTestId('session-work-instructions.detach'),
    ).toBeTruthy();
    standardCleanup();
    const shared = await render(source({ status: 'owner_private' }));
    expect(
      shared.findByTestId('session-work-instructions.owner_private'),
    ).toBeTruthy();
    expect(shared.findByTestId('session-work-instructions.body')).toBeNull();
    expect(shared.findByTestId('session-work-instructions.edit')).toBeNull();
  });

  it('as a Setup row, opens on the instructions to read and stays a closed Add row when there are none', async () => {
    const { WorkSectionPlacementProvider, WorkSectionSetupDisclosureProvider } = await import('../WorkSection');
    const { useSessionSetupDisclosure } = await import('../useSessionSetupDisclosure');
    const session = createSessionFixture({ id: 'bot', serverId: 'home-a' });
    function InSetup(props: Readonly<{ state: SessionInstructionsSource }>) {
      const disclosure = useSessionSetupDisclosure();
      return (
        <WorkSectionPlacementProvider value="setup">
          <WorkSectionSetupDisclosureProvider value={disclosure}>
            <SessionInstructionsBody session={session} serverId="home-a" source={props.state} />
          </WorkSectionSetupDisclosureProvider>
        </WorkSectionPlacementProvider>
      );
    }
    const none = await renderScreen(<InSetup state={source({ status: 'none' })} />);
    expect(none.findByTestId('session-work-instructions.create')).toBeNull();
    expect(none.findByTestId('session-work-instructions:row')).toBeTruthy();
    standardCleanup();
    const attached = await renderScreen(
      <InSetup state={source({ status: 'ready', ref, document: documentOf('Keep diffs small.') })} />,
    );
    expect(attached.findByTestId('session-work-instructions.detach')).toBeTruthy();
  });

  it('releases a failed Detach and keeps the canonical attachment and document', async () => {
    const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
    const fixture = await createPlainArtifactHomeFixture('https://work-instructions-detach.test', {
      handleRequest: async (path, init) => sessionRequest(`https://work-instructions-detach.test${path}`, init),
    });
    try {
      await loadSyncSingletonForTests();
      const serverId = fixture.home.id;
      const attachedRef = { ...ref, serverId };
      const stack = [{ id: 'session.instructions', ref: attachedRef, enabled: true, placement: 'system_append' as const }];
      const current = createSessionFixture({ id: 'bot', serverId, metadataVersion: 2,
        metadata: { path: '/worktree', host: 'localhost', work: { promptStack: stack } } });
      storage.setState({ sessions: { ...storage.getState().sessions, bot: current } });
      sessionHttp.rejectNextPatch('bot');
      const screen = await renderScreen(
        <SessionInstructionsBody
          session={current}
          serverId={serverId}
          source={source({ status: 'ready', ref: attachedRef, document: documentOf('Current instructions') })}
        />,
      );
      await screen.pressByTestIdAsync('session-work-instructions.detach');
      await vi.waitFor(() => expect(screen.findByTestId('session-work-instructions.failed')).toBeTruthy());
      expect(screen.findByTestId('session-work-instructions.detach')?.props.disabled).not.toBe(true);
      expect(screen.findByTestId('session-work-instructions.refused')).toBeNull();
      expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
      const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
      expect(readSessionOwnerMetadataView(storage.getState().sessions.bot!)?.work).toMatchObject({ promptStack: stack });
      expect(sessionHttp.writes).toEqual(['bot']);
      expect(Modal.confirm).not.toHaveBeenCalled();
    } finally { standardCleanup(); await fixture.dispose(); }
  });

  it('holds a Detach that arrived on a stale Session as a quiet conflict, then applies it to the current version or drops it', async () => {
    const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
    const fixture = await createPlainArtifactHomeFixture('https://work-instructions-stale.test', {
      handleRequest: async (path, init) => sessionRequest(`https://work-instructions-stale.test${path}`, init),
    });
    try {
      await loadSyncSingletonForTests();
      const serverId = fixture.home.id;
      const attachedRef = { ...ref, serverId };
      const stack = [{ id: 'session.instructions', ref: attachedRef, enabled: true, placement: 'system_append' as const }];
      // Another client already moved the Session to revision 3; this tab still reviewed revision 2.
      const current = createSessionFixture({ id: 'bot', serverId, metadataVersion: 3,
        metadata: { path: '/worktree', host: 'localhost', work: { promptStack: stack } } });
      storage.setState({ sessions: { ...storage.getState().sessions, bot: current } });
      const attached = source({ status: 'ready', ref: attachedRef, document: documentOf('Current instructions') });
      const body = (session: typeof current) => <SessionInstructionsBody session={session} serverId={serverId} source={attached} />;
      const screen = await renderScreen(body({ ...current, metadataVersion: 2 }));
      await screen.pressByTestIdAsync('session-work-instructions.detach');
      await vi.waitFor(() => expect(screen.findByTestId('session-work-instructions.conflict')).toBeTruthy());
      // The document stays, nothing was written, the line names the current document, and says no failure.
      expect(sessionHttp.writes).toEqual([]);
      expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
      expect(screen.findByTestId('session-work-instructions.failed')).toBeNull();
      expect(screen.findByTestId('session-work-instructions.refused')).toBeNull();
      expect(screen.getTextContent()).toContain('sessionIntentConflict.changedNow');
      expect(screen.getTextContent()).toContain('Release captain');
      // Apply mine re-sends the same change on the fresh basis the Session now has.
      await act(async () => { screen.update(body(current)); });
      await screen.pressByTestIdAsync('session-work-instructions.conflict.apply');
      await vi.waitFor(() => expect(sessionHttp.writes).toEqual(['bot']));
      await vi.waitFor(() => expect(screen.findByTestId('session-work-instructions.conflict')).toBeNull());
      const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
      expect(readSessionOwnerMetadataView(storage.getState().sessions.bot!)?.work).toMatchObject({ promptStack: [] });
      await screen.unmount();
    } finally { standardCleanup(); await fixture.dispose(); }
  });

  it('drops a held stale change on Keep current and writes nothing', async () => {
    const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
    const fixture = await createPlainArtifactHomeFixture('https://work-instructions-keep.test', {
      handleRequest: async (path, init) => sessionRequest(`https://work-instructions-keep.test${path}`, init),
    });
    try {
      await loadSyncSingletonForTests();
      const serverId = fixture.home.id;
      const attachedRef = { ...ref, serverId };
      const stack = [{ id: 'session.instructions', ref: attachedRef, enabled: true, placement: 'system_append' as const }];
      const current = createSessionFixture({ id: 'bot', serverId, metadataVersion: 3,
        metadata: { path: '/worktree', host: 'localhost', work: { promptStack: stack } } });
      storage.setState({ sessions: { ...storage.getState().sessions, bot: current } });
      const screen = await renderScreen(<SessionInstructionsBody session={{ ...current, metadataVersion: 2 }} serverId={serverId}
        source={source({ status: 'ready', ref: attachedRef, document: documentOf('Current instructions') })} />);
      await screen.pressByTestIdAsync('session-work-instructions.detach');
      await vi.waitFor(() => expect(screen.findByTestId('session-work-instructions.conflict')).toBeTruthy());
      await screen.pressByTestIdAsync('session-work-instructions.conflict.keep');
      expect(screen.findByTestId('session-work-instructions.conflict')).toBeNull();
      expect(sessionHttp.writes).toEqual([]);
      await screen.unmount();
    } finally { standardCleanup(); await fixture.dispose(); }
  });

  it('withholds instructions from a shared viewer before any read', () => {
    expect(
      resolveSessionInstructionsAccess(
        createSessionFixture({ id: 'shared', accessLevel: 'view' }),
      ),
    ).toBe('owner_private');
    expect(resolveSessionInstructionsAccess(null)).toBe('unavailable');
  });
});

describe('Work › Instructions provenance and Agent write result', () => {
  const viewer = { serverId: 'home-a', accountId: 'acct-viewer' };
  const readyWith = (writeFacts?: SessionInstructionsSource['writeFacts']) =>
    source({ status: 'ready', ref, document: documentOf('You look after releases.'), writeFacts });
  const provenanceText = async (writeFacts?: SessionInstructionsSource['writeFacts']) => {
    const screen = await render(readyWith(writeFacts));
    return screen.getTextContent();
  };
  const nameViewer = (name: string | null) => storage.setState({
    profileScope: viewer,
    profile: { ...storage.getState().profile, name, username: null } as never,
  });

  it('names the people who changed and approved the current revision, and nothing it cannot resolve', async () => {
    nameViewer('Mara Voss');
    const text = await provenanceText({
      provenance: {
        changedBy: { kind: 'person', accountId: viewer.accountId },
        approvedBy: { kind: 'person', accountId: viewer.accountId },
      },
      agentWriteResult: null,
    });
    expect(text).toContain('sessionInstructions.changedBy(name=Mara Voss)');
    expect(text).toContain('sessionInstructions.approvedBy(name=Mara Voss)');
  });

  it('names the Voice agent acting for the approving person only when the receipt records Voice', async () => {
    nameViewer('Mara Voss');
    const text = await provenanceText({ provenance: {
      approvedBy: { kind: 'person', accountId: viewer.accountId, decidedVia: 'voice' },
    }, agentWriteResult: null });
    expect(text).toContain('sessionInstructions.approvedByVoice(name=Mara Voss)');
    expect(text).not.toContain('sessionInstructions.approvedBy(name=');
  });

  it('omits an actor whose display name is unknown rather than guessing or showing an id', async () => {
    nameViewer('Mara Voss');
    const text = await provenanceText({
      provenance: {
        changedBy: { kind: 'person', accountId: 'acct-stranger' },
        approvedBy: { kind: 'person', accountId: viewer.accountId },
      },
      agentWriteResult: null,
    });
    expect(text).not.toContain('sessionInstructions.changedBy');
    expect(text).not.toContain('acct-stranger');
    expect(text).toContain('sessionInstructions.approvedBy(name=Mara Voss)');
    nameViewer(null);
    expect(await provenanceText({
      provenance: { changedBy: { kind: 'person', accountId: viewer.accountId } },
      agentWriteResult: null,
    })).not.toContain('sessionInstructions.changedBy');
  });

  it('names an Agent author by its own Session in this Home, and omits one it cannot read', async () => {
    storage.setState({
      sessions: {
        ...storage.getState().sessions,
        'writer-1': createSessionFixture({
          id: 'writer-1', serverId: 'home-a',
          metadata: { path: '/w', host: 'h', summary: { text: 'Release captain', updatedAt: 1 } },
        }),
      },
    });
    expect(await provenanceText({
      provenance: { changedBy: { kind: 'agent', accountId: viewer.accountId, sessionId: 'writer-1' } },
      agentWriteResult: null,
    })).toContain('sessionInstructions.changedBy(name=Release captain)');
    const unknown = await provenanceText({
      provenance: { changedBy: { kind: 'agent', accountId: viewer.accountId, sessionId: 'gone' } },
      agentWriteResult: null,
    });
    expect(unknown).not.toContain('sessionInstructions.changedBy');
    expect(await provenanceText({
      provenance: { changedBy: { kind: 'agent', accountId: viewer.accountId } },
      agentWriteResult: null,
    })).not.toContain('sessionInstructions.changedBy');
  });

  it('renders no provenance line without write facts', async () => {
    nameViewer('Mara Voss');
    const screen = await render(readyWith(undefined));
    expect(screen.findByTestId('session-work-instructions.provenance')).toBeNull();
  });

  it.each([
    ['pending', 'sessionInstructions.savePending'],
    ['updated', 'sessionInstructions.updated'],
    ['denied', 'sessionInstructions.saveDenied'],
    ['canceled', 'sessionInstructions.saveDenied'],
    ['conflict', 'sessionInstructions.saveConflict'],
    ['failed', 'sessionInstructions.setFailed'],
  ] as const)('reports an Agent write that is %s in the Instructions section', async (status, key) => {
    const screen = await render(readyWith({ provenance: {}, agentWriteResult: { status } }));
    expect(screen.findByTestId(`session-work-instructions.agentWrite.${status}`)).toBeTruthy();
    expect(screen.getTextContent()).toContain(key);
    expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
  });

  it('shows no Agent write line when no proposal was observed', async () => {
    const screen = await render(readyWith({ provenance: {}, agentWriteResult: null }));
    expect(screen.findByTestId('session-work-instructions.agentWrite.pending')).toBeNull();
    expect(screen.getTextContent()).not.toContain('sessionInstructions.updated');
  });
});
