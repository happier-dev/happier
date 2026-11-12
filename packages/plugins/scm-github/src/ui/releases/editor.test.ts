import { describe, expect, it } from 'vitest';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { createReleaseEditorV1 } from './editor.js';
import type { PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';

describe('one controlled release editor', () => {
  it('prepares a host Save without executing automation and settles the captured edit before a reviewed host Publish', async () => {
    const release = createForgeReleaseV1Fixture();
    const calls: string[] = [];
    const assets = { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
    const edited = { ...release, body: 'Host-edited notes' };
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: async operation => { calls.push(operation); return { status: 'success', result: operation === 'readRelease'
        ? { kind: 'value', value: edited } : { kind: 'value', value: assets } }; } });
    await editor.invoke({ kind: 'setField', field: 'body', value: edited.body });
    const prepared = await editor.saveControl.prepare({ signal: new AbortController().signal });
    expect(prepared).toEqual({ input: { repository: release.repository, repositoryId: release.repositoryId, releaseId: release.releaseId,
      observedUpdatedAt: release.updatedAt, changes: { body: edited.body } } });
    expect(calls).toEqual([]);
    editor.saveControl.onSettled({ ok: true, result: { kind: 'confirmed', release: edited } });
    expect(editor.getSnapshot()?.dirty).toBe(false);
    const publishing = await editor.publishControl.prepare({ signal: new AbortController().signal });
    expect(calls).toEqual(['readRelease', 'listAssets']);
    expect(publishing?.input).toMatchObject({ releaseId: release.releaseId, reviewed: { ...edited, assets }, makeLatest: 'legacy' });
    editor.publishControl.onSettled({ ok: true, result: { kind: 'confirmed', release: { ...edited, draft: false } } });
    expect(editor.getSnapshot()?.saved?.draft).toBe(false);
    expect(editor.getSnapshot()?.busy).toBeNull();
    editor.dispose();
  });
  it('keeps explicit draft edit timestamp-only', async () => {
    const release = createForgeReleaseV1Fixture();
    const calls: unknown[] = [];
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: async (operation, input) => { calls.push({ operation, input }); return { status: 'success',
        result: { kind: 'confirmed', release: { ...release, body: 'Changed locally' } } }; } });
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Changed locally' });
    await editor.save();
    expect(calls).toEqual([{ operation: 'editReleaseDraft', input: { repository: release.repository, repositoryId: release.repositoryId,
      releaseId: release.releaseId, observedUpdatedAt: release.updatedAt, changes: { body: 'Changed locally' } } }]);
    expect(editor.getSnapshot()?.dirty).toBe(false);
    editor.dispose();
  });
  it('sends the complete freshly reviewed snapshot only to the separate publish Action', async () => {
    const release = createForgeReleaseV1Fixture();
    const calls: Array<{ operation: string; input: unknown }> = [];
    const assets = { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: async (operation, input) => { calls.push({ operation, input });
        return { status: 'success', result: operation === 'readRelease' ? { kind: 'value', value: release }
          : operation === 'listAssets' ? { kind: 'value', value: assets }
            : { kind: 'confirmed', release: { ...release, draft: false } } }; } });
    await editor.reviewPublish();
    expect(calls.map(call => call.operation)).toEqual(['readRelease', 'listAssets']);
    const reviewed = editor.getSnapshot()?.review;
    expect(reviewed?.assets).toEqual(assets);
    await editor.publishDraft();
    expect(calls.at(-1)).toEqual({ operation: 'publishReleaseDraft', input: { repository: release.repository,
      repositoryId: release.repositoryId, releaseId: release.releaseId, reviewed, makeLatest: 'legacy' } });
    expect(editor.getSnapshot()?.saved?.draft).toBe(false);
    editor.dispose();
  });
  it('does not edit a published release through the mounted editor', async () => {
    const release = createForgeReleaseV1Fixture({ draft: false });
    const editor = createReleaseEditorV1({ target: { repository: release.repository, repositoryId: release.repositoryId }, initial: release,
      invoke: async () => { throw new Error('A published release cannot be saved here'); } });
    const fields = editor.getSnapshot()?.fields;
    expect(await editor.invoke({ kind: 'setField', field: 'body', value: 'Changed published notes' })).toEqual({ status: 'unavailable' });
    expect(editor.getSnapshot()?.fields).toBe(fields);
    editor.dispose();
  });
  it('keeps typing, preview and generated proposals local until explicit apply and Save', async () => {
    const calls: string[] = [];
    const editor = createReleaseEditorV1({
      target: { repository: createForgeReleaseV1Fixture().repository, repositoryId: '42' },
      invoke: async (operation) => {
        calls.push(operation);
        if (operation === 'generateReleaseNotes') return { status: 'success', result: { kind: 'value', value: { name: 'Generated', body: 'Generated notes' } } };
        return { status: 'success', result: { kind: 'confirmed', release: createForgeReleaseV1Fixture({ name: 'Generated', body: 'Generated notes' }) } };
      },
    });
    await editor.invoke({ kind: 'setField', field: 'tagName', value: 'v7' });
    await editor.invoke({ kind: 'setField', field: 'targetCommitish', value: 'main' });
    for (let i = 0; i < 100; i++) await editor.invoke({ kind: 'setField', field: 'body', value: `My unsaved text ${i}` });
    await editor.invoke({ kind: 'setPreview', value: true });
    expect(calls).toHaveLength(0);
    await editor.generate();
    expect(editor.getSnapshot()?.fields.body).toBe('My unsaved text 99');
    expect(editor.getSnapshot()?.saved).toBeNull();
    expect(await editor.invoke({ kind: 'applyGenerated', mode: 'use' })).toEqual({ status: 'rejected' });
    await editor.invoke({ kind: 'applyGenerated', mode: 'replace' });
    expect(editor.getSnapshot()?.fields.body).toBe('Generated notes');
    expect(calls).toEqual(['generateReleaseNotes']);
    await editor.save();
    expect(calls).toEqual(['generateReleaseNotes', 'createReleaseDraft']);
    expect(editor.getSnapshot()?.dirty).toBe(false);
    editor.dispose();
    expect(await editor.invoke({ kind: 'setField', field: 'body', value: 'retired' })).toEqual({ status: 'unavailable' });
  });

  it('preserves unsaved fields across conflict, credentials expiry, uncertain writes and equal refreshes', async () => {
    const release = createForgeReleaseV1Fixture();
    const editor = createReleaseEditorV1({ target: { repository: release.repository, repositoryId: release.repositoryId },
      initial: release, invoke: async () => ({ status: 'success', result: { kind: 'outcome_unknown', releaseId: release.releaseId } }) });
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Keep my notes' });
    const fields = editor.getSnapshot()!.fields;
    editor.receive(release);
    expect(editor.getSnapshot()?.fields).toBe(fields);
    await editor.save();
    await editor.save();
    expect(editor.getSnapshot()?.fields).toBe(fields);
    expect(editor.getSnapshot()?.outcome).toMatchObject({ kind: 'outcome_unknown' });
    editor.receive({ ...release, body: 'Other writer', updatedAt: '2026-10-24T11:00:00Z' });
    expect(editor.getSnapshot()?.fields.body).toBe('Keep my notes');
    expect(editor.getSnapshot()?.conflict).not.toBeNull();
    editor.dispose();
  });

  it('retains field identity on metadata-only refresh and refuses another repository baseline', () => {
    const release = createForgeReleaseV1Fixture();
    const editor = createReleaseEditorV1({ target: { repository: release.repository, repositoryId: release.repositoryId }, initial: release,
      invoke: async () => { throw new Error('Refreshing admitted metadata is local'); } });
    const fields = editor.getSnapshot()!.fields;
    editor.receive({ ...release, immutable: false });
    expect(editor.getSnapshot()!.fields).toBe(fields);
    const saved = editor.getSnapshot()!.saved;
    editor.receive({ ...release, repository: { ...release.repository, repository: 'another/repository' }, body: 'Wrong repository notes' });
    expect(editor.getSnapshot()!.saved).toBe(saved);
    editor.dispose();
  });

  it('clears uncertainty only when explicit exact status establishes the submitted effect, without replay or losing newer edits', async () => {
    const release = createForgeReleaseV1Fixture();
    let writes = 0;
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: async () => { writes++; return { status: 'success', result: { kind: 'outcome_unknown', releaseId: release.releaseId } }; } });
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Keep my local notes' });
    await editor.save();
    editor.receive(release);
    expect(editor.getSnapshot()?.outcome?.kind).toBe('outcome_unknown');
    editor.receive({ ...release, releaseId: '999' }, { reconcileOutcome: true });
    expect(editor.getSnapshot()?.outcome?.kind).toBe('outcome_unknown');
    editor.receive(release, { reconcileOutcome: true });
    expect(editor.getSnapshot()?.outcome?.kind).toBe('outcome_unknown');
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Newer unsaved notes' });
    const fields = editor.getSnapshot()?.fields;
    editor.receive({ ...release, body: 'Keep my local notes' }, { reconcileOutcome: true });
    expect(editor.getSnapshot()?.outcome).toBeNull();
    expect(editor.getSnapshot()?.fields).toBe(fields);
    expect(editor.getSnapshot()?.dirty).toBe(true);
    expect(writes).toBe(1);
    editor.dispose();
  });

  it('reconciles a lost publish with the exact published target and invalidates consumers once', async () => {
    const release = createForgeReleaseV1Fixture();
    const effects: string[] = [];
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: async operation => ({ status: 'success', result: operation === 'readRelease' ? { kind: 'value', value: release }
        : operation === 'listAssets' ? { kind: 'value', value: { ...release.assets, rows: [], continuation: null, incomplete: null, omittedRowCount: 0, projectionTruncated: false } }
          : { kind: 'outcome_unknown', releaseId: release.releaseId } }),
      onSaved: (_, effect) => { effects.push(effect); } });
    await editor.reviewPublish();
    await editor.publishDraft();
    editor.receive(release, { reconcileOutcome: true });
    expect(editor.getSnapshot()?.outcome?.kind).toBe('outcome_unknown');
    const published = { ...release, draft: false, publishedAt: '2026-10-24T12:00:00Z' };
    editor.receive(published, { reconcileOutcome: true });
    expect(editor.getSnapshot()?.outcome).toBeNull();
    expect(editor.getSnapshot()?.saved?.draft).toBe(false);
    editor.receive(published, { reconcileOutcome: true });
    expect(effects).toEqual(['published']);
    editor.dispose();
  });

  it('keeps the original submitted effect when a second Save arrives during its pending host call', async () => {
    const release = createForgeReleaseV1Fixture();
    let settle!: (value: PluginActionExecution<unknown>) => void;
    let calls = 0;
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: () => { calls++; return new Promise(resolve => { settle = resolve; }); } });
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Submitted notes' });
    const saving = editor.save();
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Newer notes' });
    await editor.save();
    settle({ status: 'success', result: { kind: 'outcome_unknown', releaseId: release.releaseId } });
    await saving;
    editor.receive({ ...release, body: 'Submitted notes' }, { reconcileOutcome: true });
    expect(editor.getSnapshot()?.outcome).toBeNull();
    expect(editor.getSnapshot()?.fields.body).toBe('Newer notes');
    expect(editor.getSnapshot()?.dirty).toBe(true);
    expect(calls).toBe(1);
    editor.dispose();
  });

  it('preserves a pending host rebind without claiming an uncertain write', async () => {
    const release = createForgeReleaseV1Fixture();
    const editor = createReleaseEditorV1({ target: { repository: release.repository, repositoryId: release.repositoryId }, initial: release,
      invoke: async () => ({ status: 'pending' }) });
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Still unsaved' });
    await editor.save();
    expect(editor.getSnapshot()?.outcome).toBeNull();
    expect(editor.getSnapshot()?.fields.body).toBe('Still unsaved');
    expect(editor.getSnapshot()?.dirty).toBe(true);
    editor.dispose();
  });

  it.each((['save', 'publish'] as const).flatMap(operation =>
    (['approval_rejected', 'approval_canceled', 'denied'] as const).map(errorCode => ({ operation, errorCode }))))(
    'keeps $operation retryable after $errorCode', async ({ operation, errorCode }) => {
      const release = createForgeReleaseV1Fixture();
      const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
        invoke: async read => ({ status: 'success', result: { kind: 'value', value: read === 'readRelease' ? release : { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } } }) });
      if (operation === 'save') await editor.invoke({ kind: 'setField', field: 'body', value: 'Keep unsaved notes' });
      const before = editor.getSnapshot();
      const control = operation === 'save' ? editor.saveControl : editor.publishControl;
      const prepared = await control.prepare({ signal: new AbortController().signal });
      expect(prepared).not.toBeNull();
      control.onSettled({ ok: false, errorCode, error: 'Host refused this occurrence' });
      const after = editor.getSnapshot();
      expect(after?.busy).toBeNull();
      expect(after?.outcome).toBeNull();
      expect(after?.saved).toEqual(before?.saved);
      expect(after?.fields).toEqual(before?.fields);
      expect(after?.dirty).toBe(before?.dirty);
      expect(after?.failure).toEqual(errorCode === 'denied' ? { class: 'transient', code: 'denied' } : null);
      expect(await control.prepare({ signal: new AbortController().signal })).toEqual(prepared);
      editor.dispose();
  });

  it('does not replay a write after a host reports an unknown outcome', async () => {
    const release = createForgeReleaseV1Fixture();
    let attempts = 0;
    const editor = createReleaseEditorV1({ target: { repository: release.repository }, initial: release,
      invoke: async () => { attempts++; return { status: 'outcomeUnknown', code: 'action_outcome_unknown', message: 'Response unavailable' }; } });
    await editor.invoke({ kind: 'setField', field: 'body', value: 'Keep these unsaved notes' });
    await editor.save();
    await editor.save();
    expect(attempts).toBe(1);
    expect(editor.getSnapshot()?.outcome).toMatchObject({ kind: 'outcome_unknown', releaseId: release.releaseId });
    expect(editor.getSnapshot()?.fields.body).toBe('Keep these unsaved notes');
    editor.dispose();
  });
});
