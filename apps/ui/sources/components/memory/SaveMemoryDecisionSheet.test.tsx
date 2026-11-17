import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMemoryDecisionHomeFixture } from '@/dev/testkit/harness/memoryDecisionHomeFixture';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { memoryDocumentActions } from '@/sync/ops/promptLibrary/memoryDocuments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

const { SaveMemoryDecisionForm } = await import('./SaveMemoryDecisionSheet');
const { seedMemoryDecisionFromMessage } = await import('./memoryDecisionSeed');
afterEach(standardCleanup);

/** The answer's first sentence is the decision; the person writes why (Reason starts empty). */
const seedWithReason = (source: CoordinationMessageRefV1) => ({
  ...seedMemoryDecisionFromMessage(source, 'Retry cap stays at 5. Backoff ran out too early.'),
  reason: 'Backoff ran out too early.',
});

async function mount(fixture: Awaited<ReturnType<typeof createMemoryDecisionHomeFixture>>, onSaved = vi.fn()) {
  const source: CoordinationMessageRefV1 = { kind: 'discussion',
    discussion: { serverId: fixture.serverId, discussionId: 'discussion-1' }, messageId: 'committed-source' };
  const seed = seedWithReason(source);
  const screen = await renderScreen(<SaveMemoryDecisionForm seed={seed} onClose={vi.fn()} onSaved={onSaved} />);
  return { screen, onSaved, source };
}

async function save(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const button = screen.find(node => node.props?.testID === 'save-memory-decision.save' && typeof node.props.action === 'function');
  await act(async () => { await button.props.action(); });
}

describe('Save as decision from a Discussion message', () => {
  it('opens a code-only answer with the decision left to write and the answer quoted beneath (owner 03)', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const source: CoordinationMessageRefV1 = { kind: 'discussion',
      discussion: { serverId: f.serverId, discussionId: 'discussion-1' }, messageId: 'committed-source' };
    const screen = await renderScreen(<SaveMemoryDecisionForm
      seed={seedMemoryDecisionFromMessage(source, 'Result:\n```json\n{ "listPinned": false }\n```')}
      onClose={vi.fn()} onSaved={vi.fn()} />);
    try {
      expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe('');
      expect(screen.findByTestId('save-memory-decision.reason')?.props.value).toBe('');
      expect(screen.findByTestId('save-memory-decision.source')).toBeTruthy();
      const button = screen.find(node => node.props?.testID === 'save-memory-decision.save' && typeof node.props.action === 'function');
      expect(button.props.disabled).toBe(true);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('opens the reviewed revision after a CAS conflict without losing the decision draft', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const first = await mount(f);
    await save(first.screen);
    await first.screen.unmount();
    const { screen } = await mount(f);
    try {
      await act(async () => { screen.changeTextByTestId('save-memory-decision.text', 'Retry cap stays at 6'); });
      await save(screen);
      expect(screen.findByTestId('save-memory-decision.duplicate')).toBeTruthy();
      const row = f.home.boundary.list()[0];
      if (!row) throw new Error('Missing saved memory');
      const bodyVersion = row.bodyVersion;
      if (bodyVersion === undefined) throw new Error('Missing saved memory body revision');
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(row.id)!));
      f.home.boundary.beforeNextUpdate(async () => {
        expect(await memoryDocumentActions.update({ ref: { kind: 'doc', serverId: f.serverId, artifactId: row.id },
          serverId: f.serverId, accountId: row.ownerAccountId, isCurrent: () => true,
          expectedRevision: { headerVersion: row.headerVersion, bodyVersion } },
        { factId: body.index[0]!.id, text: 'Concurrent decision' })).toMatchObject({ ok: true });
      });
      await save(screen);
      expect(screen.findByTestId('save-memory-decision.conflict'), screen.getTextContent()).toBeTruthy();
      const { Modal } = await import('@/modal');
      vi.spyOn(Modal, 'show').mockReturnValue('decision-history');
      await screen.pressByTestIdAsync('save-memory-decision.conflict-action');
      expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
        artifactId: row.id, compareFromBodyVersion: row.bodyVersion, canRestore: false,
      }) }));
      expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe('Retry cap stays at 6');
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('saves into the person’s own memory with the exact Discussion message as its source', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved, source } = await mount(f);
    try {
      await save(screen);
      const saved = f.home.boundary.list().filter(row => f.home.boundary.readPlainBody(row.id)?.includes('Retry cap stays at 5'));
      expect(saved).toHaveLength(1);
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved[0]!.id)!));
      expect(body.index[0]).toMatchObject({ text: 'Retry cap stays at 5',
        decision: { reason: 'Backoff ran out too early.', sourceMessageRef: source } });
      expect(f.readSource().attachments).toEqual([]);
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('says a refused disclosure plainly and keeps what was typed', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.refuseDecision('memory_decision_disclosure_denied');
    const { screen, onSaved } = await mount(f);
    try {
      await save(screen);
      expect(screen.findByTestId('save-memory-decision.disclosure')).toBeTruthy();
      expect(screen.findAllByTestId('save-memory-decision.refused')).toHaveLength(0);
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe('Retry cap stays at 5');
      expect(f.home.boundary.list()).toEqual([]);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('resubmits the same Discussion save with the reviewed duplicate choice', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved, source } = await mount(f);
    try {
      // Save once through this form, then reopen it against the real persisted duplicate.
      await save(screen);
      const saved = f.home.boundary.list()[0];
      if (!saved) throw new Error('Missing persisted initial decision');
      const before = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
      await screen.unmount();
      const reopened = await mount(f, onSaved);
      try {
        onSaved.mockClear();
        await save(reopened.screen);
        expect(onSaved).not.toHaveBeenCalled();
        expect(reopened.screen.findByTestId('save-memory-decision.duplicate')).toBeTruthy();
        await save(reopened.screen);
        expect(onSaved).toHaveBeenCalledTimes(1);
        const after = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
        expect(after.index).toHaveLength(1);
        expect(after.index[0]).toMatchObject({ supersedes: before.index[0]!.id, decision: { sourceMessageRef: source } });
        expect(after.topics.find(topic => topic.title === 'archive')?.facts).toContainEqual(before.index[0]);
      } finally { await reopened.screen.unmount(); }
    } finally { await f.home.dispose(); }
  });

  it('opens the saved fact a duplicate review names, then Back keeps the typed decision and chosen effect', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved } = await mount(f);
    try {
      await save(screen);
      const saved = f.home.boundary.list()[0];
      if (!saved) throw new Error('Missing persisted initial decision');
      const before = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
      const existing = before.index[0]!;
      await screen.unmount();
      const reopened = await mount(f, onSaved);
      const press = async (testID: string) => {
        const node = reopened.screen.find(entry => entry.props?.testID === testID && typeof entry.props.onPress === 'function');
        await act(async () => { node.props.onPress(); });
      };
      try {
        await save(reopened.screen);
        await act(async () => { reopened.screen.changeTextByTestId('save-memory-decision.text', 'Retry cap stays at 6'); });
        await press('save-memory-decision.duplicate.choice:replace');
        await press(`save-memory-decision.duplicate.candidate.${existing.id}.view`);
        // The saved fact opens in the same sheet, in place of the comparison and fields.
        expect(reopened.screen.findByTestId('save-memory-decision.savedFact')).toBeTruthy();
        await press('save-memory-decision.savedFact.back');
        expect(reopened.screen.findByTestId('save-memory-decision.savedFact')).toBeNull();
        expect(reopened.screen.findByTestId('save-memory-decision.text')?.props.value).toBe('Retry cap stays at 6');
        await save(reopened.screen);
        const after = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
        // Replace, as chosen before looking: the old decision is history, the new one supersedes it.
        expect(after.index).toHaveLength(1);
        expect(after.index[0]).toMatchObject({ text: 'Retry cap stays at 6', supersedes: existing.id });
      } finally { await reopened.screen.unmount(); }
    } finally { await f.home.dispose(); }
  });

  it('distinguishes a failed saved-fact read from a successfully read fact that left the comparison', async () => {
    let readUnavailable = false;
    let rejectedArtifactRead = false;
    let savedArtifactId = '';
    const f = await createMemoryDecisionHomeFixture({
      // HTTP is the boundary: the real memory Action, document reader and status publication stay active.
      handleRequest: async (path, init) => {
        if (!readUnavailable || path !== `/v1/artifacts/${savedArtifactId}` || (init?.method ?? 'GET') !== 'GET') return null;
        rejectedArtifactRead = true;
        return Response.json({ error: 'offline' }, { status: 503 });
      },
    });
    const first = await mount(f);
    try {
      await save(first.screen);
      const saved = f.home.boundary.list()[0];
      if (!saved || saved.bodyVersion === undefined) throw new Error('Missing saved decision');
      savedArtifactId = saved.id;
      const before = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(saved.id)!));
      const existing = before.index[0]!;
      await first.screen.unmount();
      const { screen } = await mount(f);
      try {
        await save(screen);
        const openFact = () => screen.pressByTestIdAsync(`save-memory-decision.duplicate.candidate.${existing.id}.view`);
        // Control: the same comparison opens its actual persisted fact before the transport fails.
        await openFact();
        await vi.waitFor(() => expect(screen.findByTestId('save-memory-decision.savedFact.saved')).toBeTruthy());
        await screen.pressByTestIdAsync('save-memory-decision.savedFact.back');

        readUnavailable = true;
        await openFact();
        await vi.waitFor(() => expect(rejectedArtifactRead).toBe(true));
        // Let the real artifact transport exhaust its existing retry sequence before judging the settled read.
        await vi.waitFor(() => expect(screen.findByTestId('save-memory-decision.savedFact.loading')).toBeNull(), { timeout: 10_000 });
        expect(screen.findByTestId('save-memory-decision.savedFact.missing')).toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('save-memory-decision.savedFact.unavailable')).toBeTruthy());
        readUnavailable = false;
        await screen.pressByTestIdAsync('save-memory-decision.savedFact.unavailable-action');
        await vi.waitFor(() => expect(screen.findByTestId('save-memory-decision.savedFact.saved')).toBeTruthy());
        expect(screen.findByTestId('save-memory-decision.savedFact.unavailable')).toBeNull();
        await screen.pressByTestIdAsync('save-memory-decision.savedFact.back');

        expect(await memoryDocumentActions.forget({ ref: { kind: 'doc', serverId: f.serverId, artifactId: saved.id },
          serverId: f.serverId, accountId: saved.ownerAccountId, isCurrent: () => true,
          expectedRevision: { headerVersion: saved.headerVersion, bodyVersion: saved.bodyVersion } }, existing.id)).toMatchObject({ ok: true });
        await openFact();
        await vi.waitFor(() => expect(screen.findByTestId('save-memory-decision.savedFact.missing')).toBeTruthy());
        expect(screen.findByTestId('save-memory-decision.savedFact.unavailable')).toBeNull();
      } finally { await screen.unmount(); }
    } finally { await f.home.dispose(); }
  });

  async function flush(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    return screen;
  }
  const projectChoice = (f: Awaited<ReturnType<typeof createMemoryDecisionHomeFixture>>) => `save-memory-decision.target:project:${f.serverId}:payments`;
  async function choosePayments(screen: Awaited<ReturnType<typeof renderScreen>>, f: Awaited<ReturnType<typeof createMemoryDecisionHomeFixture>>) {
    await flush(screen);
    const choice = screen.find(node => node.props?.testID === projectChoice(f) && typeof node.props.onPress === 'function');
    await act(async () => { choice.props.onPress(); });
  }

  it('offers Only me and the writable Project, defaults to the source’s own place and saves where it is told', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.recover();
    const { screen, onSaved } = await mount(f);
    try {
      await flush(screen);
      // A Discussion's natural place is the person's own memory; no memory exists yet, so only they can see it.
      expect(screen.findByTestId('save-memory-decision.target')).toBeTruthy();
      expect(screen.findByTestId('save-memory-decision.audience')).toBeTruthy();
      await choosePayments(screen, f);
      await save(screen);
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(f.readSource().attachments?.length).toBe(1);
      const attachment = f.readSource().attachments![0];
      if (attachment?.purpose !== 'context') throw new Error('Expected a context attachment');
      const attached = attachment.entry.ref;
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(attached.artifactId)!));
      expect(body.index[0]).toMatchObject({ text: 'Retry cap stays at 5' });
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('says Saved, not attached yet, links the saved fact and attaches that same document on demand', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const { screen, onSaved } = await mount(f);
    try {
      await choosePayments(screen, f);
      await save(screen);
      expect(screen.findByTestId('save-memory-decision.saved')).toBeTruthy();
      expect(screen.findByTestId('save-memory-decision.openSaved')).toBeTruthy();
      // The sheet stays usable: Save gives way to Done, and nothing was reported saved-and-closed yet.
      expect(screen.findAllByTestId('save-memory-decision.save')).toHaveLength(0);
      expect(onSaved).not.toHaveBeenCalled();
      const saved = f.home.boundary.list();
      expect(saved).toHaveLength(1);
      f.recover();
      const attach = screen.find(node => node.props?.testID === 'save-memory-decision.attach' && typeof node.props.action === 'function');
      await act(async () => { await attach.props.action(); });
      const recovered = f.readSource().attachments?.[0];
      expect(recovered?.purpose === 'context' && recovered.entry.ref.artifactId).toBe(saved[0]!.id);
      expect(f.home.boundary.list()).toHaveLength(1);
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });
});

describe('Session-owned Save-to default', () => {
  it('reads the unchosen Session default as intentional, with the chooser as an optional override', async () => {
    const f = await createMemoryDecisionHomeFixture({ sessionProject: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { t } = await import('@/text');
    await act(async () => { storage.getState().applySessions([f.session]); });
    const source: CoordinationMessageRefV1 = { kind: 'session',
      session: { serverId: f.serverId, sessionId: f.session.id }, messageId: 'committed-source' };
    const screen = await renderScreen(<SaveMemoryDecisionForm
      seed={seedWithReason(source)}
      onClose={vi.fn()} onSaved={vi.fn()} />);
    try {
      await vi.waitFor(() => expect(screen.findByTestId(`save-memory-decision.target:project:${f.serverId}:payments`)).toBeTruthy());
      const segments = () => screen.findAll(node => typeof node.type === 'string' && node.props['aria-checked'] !== undefined
        && String(node.props.testID).startsWith('save-memory-decision.target:'));
      // Nothing is selected and nothing names a Project: the Session's own memory is the stated default.
      expect(segments().length).toBeGreaterThan(1);
      expect(segments().every(node => node.props['aria-checked'] === false)).toBe(true);
      expect(screen.getTextContent()).toContain(t('memoryContext.memory.sheetTarget'));
      expect(screen.getTextContent()).toContain(t('memoryContext.memory.sheetSaveToElsewhere'));
      // A deliberate choice replaces the default's wording with the chosen place.
      await act(async () => { screen.findByTestId(`save-memory-decision.target:project:${f.serverId}:payments`)!.props.onPress(); });
      expect(screen.getTextContent()).not.toContain(t('memoryContext.memory.sheetTarget'));
      expect(screen.getTextContent()).not.toContain(t('memoryContext.memory.sheetSaveToElsewhere'));
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('offers a quiet way back to the Session default only once another place is chosen', async () => {
    const f = await createMemoryDecisionHomeFixture({ sessionProject: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { t } = await import('@/text');
    await act(async () => { storage.getState().applySessions([f.session]); });
    const source: CoordinationMessageRefV1 = { kind: 'session',
      session: { serverId: f.serverId, sessionId: f.session.id }, messageId: 'committed-source' };
    const screen = await renderScreen(<SaveMemoryDecisionForm
      seed={seedWithReason(source)}
      onClose={vi.fn()} onSaved={vi.fn()} />);
    try {
      const payments = `save-memory-decision.target:project:${f.serverId}:payments`;
      await vi.waitFor(() => expect(screen.findByTestId(payments)).toBeTruthy());
      const checked = () => screen.findAll(node => typeof node.type === 'string' && node.props['aria-checked'] === true
        && String(node.props.testID).startsWith('save-memory-decision.target:'));
      // The default is already in force, so there is nothing to go back to.
      expect(screen.findByTestId('save-memory-decision.target.default')).toBeNull();
      await act(async () => { screen.findByTestId(payments)!.props.onPress(); });
      expect(checked()).toHaveLength(1);
      expect(screen.getTextContent()).toContain(t('memoryContext.memory.sheetSaveToBackToSession'));
      await act(async () => { screen.findByTestId('save-memory-decision.target.default')!.props.onPress(); });
      // Back on the default: nothing selected, the header names the Session's own memory again.
      expect(checked()).toHaveLength(0);
      expect(screen.getTextContent()).toContain(t('memoryContext.memory.sheetTarget'));
      expect(screen.findByTestId('save-memory-decision.target.default')).toBeNull();
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('still offers the one eligible place when it differs from the Session default, and saves there', async () => {
    const f = await createMemoryDecisionHomeFixture({ sessionProject: true });
    // No writable Project can be listed, so Only me is the catalog's sole option while the Session's own place is the default.
    f.makeProjectCatalogUnavailable();
    const { storage } = await import('@/sync/domains/state/storage');
    const { t } = await import('@/text');
    await act(async () => { storage.getState().applySessions([f.session]); });
    const source: CoordinationMessageRefV1 = { kind: 'session',
      session: { serverId: f.serverId, sessionId: f.session.id }, messageId: 'committed-source' };
    const onSaved = vi.fn();
    const screen = await renderScreen(<SaveMemoryDecisionForm
      seed={seedWithReason(source)}
      onClose={vi.fn()} onSaved={onSaved} />);
    try {
      const onlyMe = 'save-memory-decision.target:account';
      await vi.waitFor(() => expect(screen.findByTestId(onlyMe)).toBeTruthy());
      expect(screen.findByTestId(onlyMe)!.props['aria-checked']).toBe(false);
      await act(async () => { screen.findByTestId(onlyMe)!.props.onPress(); });
      expect(screen.findByTestId(onlyMe)!.props['aria-checked']).toBe(true);
      expect(screen.getTextContent()).toContain(t('memoryContext.memory.sheetSaveToBackToSession'));
      await act(async () => { screen.findByTestId('save-memory-decision.target.default')!.props.onPress(); });
      expect(screen.findByTestId(onlyMe)!.props['aria-checked']).toBe(false);
      await act(async () => { screen.findByTestId(onlyMe)!.props.onPress(); });
      await save(screen);
      expect(onSaved).toHaveBeenCalledTimes(1);
      // The person's own memory received it; the Session's Project was not written.
      expect(f.home.boundary.list()).toHaveLength(1);
      expect(f.readSource().attachments).toEqual([]);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it.each(['writable', 'unavailable', 'readonly', 'explicit'] as const)(
    'never substitutes a same-label Project for the qualified Session Project (%s)', async access => {
      const f = await createMemoryDecisionHomeFixture({ sessionProject: true });
      const { memoryDocumentActions, readMemoryCreationReceipt } = await import('@/sync/ops/promptLibrary/memoryDocuments');
      const initial = await memoryDocumentActions.rememberInScope({ scope: 'project',
        projectRef: { serverId: f.serverId, projectKey: 'core-payments' } },
      { text: 'Established delivery policy.' }, f.serverId);
      const receipt = readMemoryCreationReceipt(initial);
      if (!receipt) throw new Error(`Missing Project A memory: ${JSON.stringify(initial)}`);
      expect(receipt.attachment).toBe('attached');
      const before = f.home.boundary.readPlainBody(receipt.ref.artifactId);
      f.setSessionProjectAccess(access === 'explicit' ? 'unavailable' : access);
      const { storage } = await import('@/sync/domains/state/storage');
      await act(async () => { storage.getState().applySessions([f.session]); });
      const source: CoordinationMessageRefV1 = { kind: 'session',
        session: { serverId: f.serverId, sessionId: f.session.id }, messageId: 'committed-source' };
      const onSaved = vi.fn();
      const screen = await renderScreen(<SaveMemoryDecisionForm
        seed={seedWithReason(source)}
        onClose={vi.fn()} onSaved={onSaved} />);
      try {
        await vi.waitFor(() => expect(screen.findByTestId('save-memory-decision.target')).toBeTruthy());
        if (access === 'explicit') {
          // The unavailable default does not prevent the person from deliberately choosing B.
          f.recover();
          const choice = screen.find(node => node.props?.testID === `save-memory-decision.target:project:${f.serverId}:payments`
            && typeof node.props.onPress === 'function');
          await act(async () => { choice.props.onPress(); });
          await save(screen);
          const attachment = f.readSource().attachments?.[0];
          if (attachment?.purpose !== 'context') throw new Error('Expected explicitly chosen Project B attachment');
          const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(attachment.entry.ref.artifactId)!));
          expect(body.index[0]).toMatchObject({ text: 'Retry cap stays at 5', decision: { sourceMessageRef: source } });
          expect(f.home.boundary.readPlainBody(receipt.ref.artifactId)).toBe(before);
          expect(f.home.boundary.list()).toHaveLength(2);
          expect(onSaved).toHaveBeenCalledTimes(1);
          return;
        }
        await save(screen);
        // A display-label collision must neither create B's memory nor attach anything there.
        expect(f.readSource().attachments).toEqual([]);
        expect(f.home.boundary.list()).toHaveLength(1);
        if (access === 'unavailable') {
          expect(f.home.boundary.readPlainBody(receipt.ref.artifactId)).toBe(before);
          expect(onSaved).not.toHaveBeenCalled();
        } else {
          expect(onSaved).toHaveBeenCalledTimes(1);
          const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(receipt.ref.artifactId)!));
          expect(body.index).toContainEqual(expect.objectContaining({ text: 'Retry cap stays at 5',
            decision: expect.objectContaining({ sourceMessageRef: source }) }));
        }
      } finally { await screen.unmount(); await f.home.dispose(); }
    });
});
