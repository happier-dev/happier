import * as React from 'react';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeContainingText, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture, createSessionOwnerViewerFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { SessionTalkPicker } = await import('./SessionTalkPicker');
const { SessionTalkMatchingStep } = await import('./SessionTalkMatchingStep');
const { useSessionTalkTargets } = await import('./sessionTalkTargets');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { resolveSessionTalkChipLabel, createRecipientActionChip } =
  await import('../definitions/createRecipientActionChip');
type Intent = React.ComponentProps<typeof SessionTalkPicker>['intent'];

const previous = getStorage().getState();
let serverId: string;
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => {
  await homes.reset();
  const serverUrl = 'https://picker-composition.test';
  serverId = await homes.addHome({ name: 'Picker', serverUrl, accountId: 'alice', currentAccount: true });
  restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
    credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: createSessionReadBatchFetchBoundary(homes.request) });
  await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
});
afterEach(async () => {
  standardCleanup();
  await restored?.dispose(); restored = undefined;
  getStorage().setState(previous, true);
});

function seedRelations() {
  const session = (id: string, name: string, lead: string | null) =>
    createSessionFixture({
      id,
      serverId,
      encryptionMode: 'plain',
      access: createSessionAccessFixture('view'),
      // Recipient previews read the shared title, not the owner's private name.
      metadata: { path: '/repo', host: 'host', name, summary: { text: name, updatedAt: 1 } },
      manager: lead ? { sessionId: lead } : null,
    });
  const sessions = {
      lead: session('lead', 'Payments v2 rollout', null),
      api: session('api', 'Idempotent retries', 'lead'),
      ui: session('ui', 'Checkout UI retry states', 'lead'),
  };
  getStorage().setState({ sessions });
  for (const value of Object.values(sessions)) homes.answer(serverId, `/v2/sessions/${value.id}`, {
    body: createPlainSessionByIdResponseFixture(value),
  });
  homes.answer(serverId, '/v2/sessions/query', { body: {
    sessions: Object.values(sessions).map(value => ({ ...createPlainSessionByIdResponseFixture(value).session,
      viewer: createSessionViewerFixture() })), hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
  } });
}

/** The person's picks go through the same intent writer the composer's submit branch reads. */
async function renderPicker(initial: Intent = null) {
  const writes: Intent[] = [];
  const closes: number[] = [];
  function Host() {
    const [intent, setIntent] = React.useState<Intent>(initial);
    return (
      <SessionTalkPicker
        sessionId="api"
        serverId={serverId}
        intent={intent}
        onIntentChange={(next) => {
          writes.push(next);
          setIntent(next);
        }}
        participants={null}
        requestClose={() => closes.push(1)}
      />
    );
  }
  const screen = await renderScreen(<Host />);
  await vi.waitFor(() => {
    expect(screen.findByTestId('session-talk-target:manager')).not.toBeNull();
    expect(screen.findByTestId('session-talk-target:manager')?.props.disabled).not.toBe(true);
    expect(screen.findByTestId('session-talk-target:siblings')?.props.disabled).not.toBe(true);
  });
  return { screen, writes, closes };
}

describe('SessionTalkPicker (composer To: Send · Ask · Post update)', () => {
  it('keeps a failed model Ask editable beside its Retry control', async () => {
    const retries: number[] = [];
    const openings: string[] = [];
    const chip = createRecipientActionChip({ isReadOnly: false, participantTargets: [], recipient: null,
      onRecipientChange: () => {}, sessionTalk: { sessionId: 'api', serverId,
        intent: { kind: 'ask_new_session', launch: { executionTarget: { serverId, machineId: 'macbook' },
          directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } },
        onIntentChange: () => {}, failure: { busy: false, onRetry: () => { retries.push(1); } },
      } });
    if (!chip) throw new Error('Model Ask chip required');
    const screen = await renderScreen(<>{chip.render({ chipStyle: () => ({}), showLabel: true,
      iconColor: '#000', textStyle: {}, countTextStyle: {}, popoverAnchorRef: React.createRef(),
      toggleCollapsedPopover: key => openings.push(key) })}</>);
    expect(screen.getTextContent()).toContain('session.participants.talk.modelAskFailed');
    await act(async () => screen.pressByTestId('session-model-ask-chip-retry'));
    expect(retries).toEqual([1]);
    await act(async () => screen.pressByTestId('agent-input-recipient-chip'));
    expect(openings).toHaveLength(1);
  });

  it('offers a model only for Ask and explains an unavailable source Machine without starting anything', async () => {
    seedRelations();
    const { screen, writes, closes } = await renderPicker();
    const row = screen.findByTestId('session-talk-target:model');
    expect(row).not.toBeNull();
    expect(row?.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain('newSession.recipeComposerMachineNotReady');
    expect(writes).toEqual([]);
    expect(closes).toEqual([]);
    expect(homes.requests.some(request => request.path.includes('spawn'))).toBe(false);
    await act(async () => screen.pressByTestId('session-talk-verb:send'));
    expect(screen.findByTestId('session-talk-target:model')).toBeNull();
  });

  it('offers the model recipe for an online layout-v1 owner Session', async () => {
    seedRelations();
    const source = createSessionFixture({ id: 'api', serverId, metadataLayoutVersion: 1,
      metadata: { path: '/repo', host: 'host', summary: { text: 'Idempotent retries', updatedAt: 1 } },
      ownerMetadataView: { machineId: 'macbook', path: '/repo', host: 'host' },
      manager: { sessionId: 'lead' },
    });
    getStorage().setState(state => ({ sessions: { ...state.sessions, api: source } }));
    homes.answer(serverId, '/v2/sessions/api', { body: createPlainSessionByIdResponseFixture(source) });
    getStorage().getState().applyMachines([createMachineFixture({ id: 'macbook', active: true, activeAt: Date.now() })],
      true, { sourceServerId: serverId });
    const { screen, writes } = await renderPicker();
    const row = screen.findByTestId('session-talk-target:model');
    expect(row).not.toBeNull();
    expect(row?.props.disabled).not.toBe(true);
    expect(writes).toEqual([]);
    expect(homes.requests.some(request => request.path.includes('spawn'))).toBe(false);
  });

  it('settles Matching across equal filter renders and overlapping Account wakes without restarting its live read', async () => {
    seedRelations();
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    // Real Account/currentness admission; fresh response objects must not become new preview inputs.
    homes.answer(serverId, '/v1/account/encryption/currentness', {
      select: () => ({ body: createPlainAccountEncryptionCurrentnessFixture() }),
    });
    const held = createDeferred<void>();
    const matchingReads: Array<AbortSignal | null | undefined> = [];
    const sessions = ['lead', 'api', 'ui'].map(id => ({
      ...createPlainSessionByIdResponseFixture(getStorage().getState().sessions[id]!).session,
      viewer: createSessionViewerFixture(),
    }));
    homes.answer(serverId, '/v2/sessions/query', { select: (input, request) => {
      const query = SessionListQueryV1Schema.parse(input);
      const matching = query.scope === 'all_accessible' && query.underSessionId === undefined;
      if (matching) matchingReads.push(request.signal);
      // A wake changes membership while the old response is held. Ignoring
      // refresh altogether must not look like successful coalescing.
      const rows = matching ? [sessions[matchingReads.length === 1 ? 0 : 2]!] : sessions;
      return { body: { sessions: rows, hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null },
        ...(matching && matchingReads.length === 1 ? { respondAfter: held.promise } : {}) };
    } });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId],
      scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] });
    const previewReads = () => homes.requests.filter(request => request.path === '/v2/sessions/query'
      || request.path === '/v2/account/session-follow-rules' || request.path === '/v1/account/encryption/currentness');
    let targets: ReturnType<typeof useSessionTalkTargets> | null = null;
    function Matching({ filter }: { filter: SessionListFilterV1 }) {
      targets = useSessionTalkTargets('api', serverId, { matchingFilter: filter, selectors: ['matching'] });
      const preview = targets.matching;
      return <SessionTalkMatchingStep serverId={serverId} filter={filter} onFilterChange={() => {}}
        summary={preview.loading ? 'loading' : `${preview.coverage}:${preview.addresses.map(address => address.sessionId).join(',')}`}
        canUse={!preview.loading && preview.coverage === 'complete'}
        onUse={() => {}} onBack={() => {}} />;
    }
    const screen = await renderScreen(<Matching filter={filter} />);
    try {
      await vi.waitFor(() => expect(matchingReads).toHaveLength(1));
      // Only Matching is held. Finish sibling selectors' initial reads before
      // attributing every preview request to the equal-filter rerender below.
      await vi.waitFor(() => expect(targets && (['manager', 'workers', 'siblings', 'followers', 'following'] as const)
        .every(selector => !targets?.[selector].loading)).toBe(true));
      const ruleReads = () => homes.requests.filter(request => request.path === '/v2/account/session-follow-rules').length;
      expect(ruleReads()).toBe(1);
      expect(homes.requests.filter(request => /\/follows\//.test(request.path))).toHaveLength(0);
      const before = previewReads().length;
      await screen.update(<Matching filter={normalizeSessionListFilterV1({ ...filter })} />);
      expect(previewReads()).toHaveLength(before);
      for (let i = 0; i < 3; i++) {
        await act(async () => publishHomeAccountChange(serverId, ['api'], {
          changeKinds: ['session'], sessionListQueryAffects: true,
        }));
      }
      expect(matchingReads[0]?.aborted).toBe(false);
      expect(matchingReads).toHaveLength(1);
    } finally { await act(async () => held.resolve()); }
    await vi.waitFor(() => {
      const done = screen.findByTestId('collection-filter-done');
      expect(done).not.toBeNull();
      expect(done?.props.disabled).toBe(false);
      expect(screen.getTextContent()).toContain('complete:ui');
    });
    // One original read and at most one trailing refresh for the coalesced wakes.
    expect(matchingReads.length).toBeLessThanOrEqual(2);
    const settled = previewReads().length;
    await screen.update(<Matching filter={normalizeSessionListFilterV1({ ...filter })} />);
    expect(previewReads()).toHaveLength(settled);
    expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-rules')).toHaveLength(1);
  });

  it('writes an Ask that returns here when the person picks Siblings, and closes', async () => {
    seedRelations();
    const { screen, writes, closes } = await renderPicker();
    expect(screen.getTextContent()).toContain('Checkout UI retry states');
    await act(async () => screen.pressByTestId('session-talk-target:siblings'));
    expect(writes).toEqual([
      { kind: 'ask', target: { selector: 'siblings' }, reply: 'return' },
    ]);
    expect(closes).toHaveLength(1);
  });

  it('keeps a relation with nobody behind it visible but not choosable', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker();
    const workers = screen.findByTestId('session-talk-target:workers');
    expect(workers?.props.disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it('turns into Post update and back without losing the chosen sessions', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker({
      kind: 'send',
      target: { selector: 'manager' },
    });
    await act(async () =>
      screen.pressByTestId('session-talk-verb:post_update'),
    );
    expect(screen.findByTestId('session-talk-audience')).not.toBeNull();
    await act(async () => screen.pressByTestId('session-talk-verb:ask'));
    expect(writes).toEqual([
      { kind: 'post_update' },
      { kind: 'ask', target: { selector: 'manager' }, reply: 'return' },
    ]);
  });

  it('returns to ordinary chat from "This session"', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker({
      kind: 'send',
      target: { selector: 'manager' },
    });
    await act(async () => screen.pressByTestId('session-talk-target:self'));
    expect(writes).toEqual([null]);
  });

  it('offers every selector and never reads a relation it could not check as empty', async () => {
    seedRelations();
    // The reverse Follow read is not answered here: Followers stays unknown, never "None right now".
    const { screen, writes } = await renderPicker();
    for (const selector of ['followers', 'following', 'discussion']) {
      expect(screen.findByTestId(`session-talk-target:${selector}`)).not.toBeNull();
    }
    await vi.waitFor(() => {
      const row = screen.findByTestId('session-talk-target:followers');
      if (!row) throw new Error('Followers row is not rendered');
      expect(findTestInstanceByTypeContainingText(row, 'Text', 'session.participants.talk.unavailable')).toBeDefined();
      expect(findTestInstanceByTypeContainingText(row, 'Text', 'session.participants.talk.noneNow')).toBeUndefined();
    });
    // Item disables the native control; invoking its handler directly bypasses that boundary.
    expect(screen.findByTestId('session-talk-target:followers')?.props.disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it('asks which Discussion before the Discussion selector can be chosen, and Back returns to the list', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker();
    const discussion = screen.findByTestId('session-talk-target:discussion');
    if (!discussion) throw new Error('Discussion row is not rendered');
    expect(findTestInstanceByTypeContainingText(discussion, 'Text', 'session.participants.talk.chooseDiscussion')).toBeDefined();
    await act(async () => screen.pressByTestId('session-talk-target:discussion'));
    expect(screen.findByTestId('session-talk-discussion-back')).not.toBeNull();
    expect(screen.findByTestId('session-talk-target:manager')).toBeNull();
    await act(async () => screen.pressByTestId('session-talk-discussion-back'));
    expect(screen.findByTestId('session-talk-target:manager')).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it('chooses Matching sessions with the shared filter editor in the same picker and writes the selector, not the rows', async () => {
    seedRelations();
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const { screen, writes, closes } = await renderPicker();
    // The canonical preview decides "My work" from the viewer's own facts: answer as the owner from here on.
    const owned = ['lead', 'api', 'ui'].map((id) => {
      const { viewer: _viewer, ...session } = getStorage().getState().sessions[id]!;
      return { ...session, access: createSessionAccessFixture('owner') };
    });
    for (const session of owned) homes.answer(serverId, `/v2/sessions/${session.id}`, {
      body: createPlainSessionByIdResponseFixture(session),
    });
    homes.answer(serverId, '/v2/sessions/query', { body: {
      sessions: owned.map((session) => ({ ...createPlainSessionByIdResponseFixture(session).session,
        viewer: createSessionOwnerViewerFixture(session) })),
      hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    } });
    await act(async () => screen.pressByTestId('session-talk-target:matching'));
    // An inline step of the same picker: the list gives way to the shared editor, with Back.
    expect(screen.findByTestId('session-talk-target:manager')).toBeNull();
    expect(screen.findByTestId('session-list-filter-editor-surface')).not.toBeNull();
    expect(screen.findByTestId('session-talk-matching-back')).not.toBeNull();
    // "Use these" waits for the Action's own preview to prove who the filter reaches.
    await vi.waitFor(() => {
      const done = screen.findByTestId('collection-filter-done');
      const summary = screen.findByTestId('collection-filter-count')?.props.children;
      expect(done).not.toBeNull();
      expect(done?.props.disabled, String(summary)).not.toBe(true);
    });
    // Choosing the filter does not freeze its rows or send. A last complete
    // answer for this same filter remains choosable during a trailing refresh;
    // final Action admission still resolves the selector again.
    const held = createDeferred<void>();
    let refreshing = false;
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      const query = SessionListQueryV1Schema.parse(input);
      const matching = query.underSessionId === undefined && query.includeInactive;
      if (matching) refreshing = true;
      return { body: { sessions: owned.map(session => ({ ...createPlainSessionByIdResponseFixture(session).session,
        viewer: createSessionOwnerViewerFixture(session) })), hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null }, ...(matching ? { respondAfter: held.promise } : {}) };
    } });
    try {
      await act(async () => publishHomeAccountChange(serverId, ['api'], {
        changeKinds: ['session'], sessionListQueryAffects: true,
      }));
      await vi.waitFor(() => expect(refreshing).toBe(true));
      expect(screen.findByTestId('collection-filter-done')?.props.disabled).not.toBe(true);
      await act(async () => screen.pressByTestId('collection-filter-done'));
    } finally { await act(async () => held.resolve()); }
    expect(writes).toHaveLength(1);
    const written = writes[0];
    if (!written || written.kind !== 'ask' || typeof written.target === 'string' || written.target.selector !== 'matching') {
      throw new Error(`expected a Matching ask, got ${JSON.stringify(written)}`);
    }
    // A hidden "Started by" never narrows Matching; the selector names this session's Home.
    expect(written.target.filter).toMatchObject({ show: 'sessions', startedBy: ['you', 'agents', 'triggers'], homeServerIds: [serverId] });
    expect(closes).toHaveLength(1);
  });

  it('leaves the Matching step with Back without choosing anything', async () => {
    seedRelations();
    const { screen, writes } = await renderPicker();
    await act(async () => screen.pressByTestId('session-talk-target:matching'));
    await act(async () => screen.pressByTestId('session-talk-matching-back'));
    expect(screen.findByTestId('session-talk-target:manager')).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it('says the whole sentence on the chip', () => {
    expect(resolveSessionTalkChipLabel(null, null)).toBe(
      'session.participants.to',
    );
    expect(
      resolveSessionTalkChipLabel(
        { kind: 'ask', target: { selector: 'siblings' }, reply: 'return' },
        null,
      ),
    ).toContain('session.participants.talk.chipAsk');
    expect(resolveSessionTalkChipLabel({ kind: 'post_update' }, null)).toBe(
      'session.participants.talk.chipPostUpdate',
    );
  });
});
