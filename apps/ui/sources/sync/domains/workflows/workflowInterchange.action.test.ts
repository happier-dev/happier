import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowEditorDraft } from './workflowEditorDraft';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { importWorkflowDocumentViaAction } = await import('./workflowInterchange');
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
  previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
  await home.reset();
  serverId = await home.addHome({ name: 'Import Home', serverUrl: 'https://workflow-import.test', accountId: 'import-owner' });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  storage.setState({ profileScope: { serverId, accountId: 'import-owner' } });
});
afterEach(async () => { await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); });

describe('Workflow document Action draft projection', () => {
  it('opens an imported document as a fresh unsaved draft and preserves current work on a typed failure', async () => {
    const currentDraft = createWorkflowEditorDraft({ draftId: 'current', name: 'Open work', blocks: [] });
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'wait',
      document: { text: 'Continue', references: [], attachments: [] } }] };
    const imported = await importWorkflowDocumentViaAction({ source: JSON.stringify({ kind: 'happier.workflow', version: 1, definition }),
      currentDraft, draftId: 'imported' });
    expect(imported).toMatchObject({ ok: true, definition, draft: { draftId: 'imported', name: '' } });
    expect(imported.draft).not.toBe(currentDraft);
    const rejected = await importWorkflowDocumentViaAction({ source: '{', currentDraft, draftId: 'rejected' });
    expect(rejected).toMatchObject({ ok: false, code: 'invalid_json' });
    expect(rejected.draft).toBe(currentDraft);
    expect(home.artifacts(serverId).list()).toEqual([]);
  });

  it('names each envelope failure with its own copy and keeps current work by identity', async () => {
    const currentDraft = createWorkflowEditorDraft({ draftId: 'current', name: 'Open work', blocks: [] });
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [] };
    const results = await Promise.all([
      '{ "kind": "happier.workflow", ',
      JSON.stringify({ kind: 'happier.workflow', version: 2, definition }),
      JSON.stringify({ kind: 'other.tool.pipeline', version: 1, definition }),
    ].map(source => importWorkflowDocumentViaAction({ source, currentDraft, draftId: 'imported' })));
    expect(results.map(result => result.ok ? null : [result.code, result.messageKey])).toEqual([
      ['invalid_json', 'workflows.interchange.importFailedInvalidJson'],
      ['unsupported_version', 'workflows.interchange.importFailedUnsupportedVersion'],
      ['invalid_document', 'workflows.interchange.importFailedInvalidDocument'],
    ]);
    for (const result of results) expect(result.draft).toBe(currentDraft);
  });

  it('offers a repair draft only for a normalized definition with canonical issues', async () => {
    const currentDraft = createWorkflowEditorDraft({ draftId: 'current', name: 'Open work', blocks: [] });
    const wait = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'wait', id,
      document: { text: 'Continue', references: [], attachments: [] }, ...extra });
    const document = (blocks: readonly unknown[]) => JSON.stringify({ kind: 'happier.workflow', version: 1,
      definition: { version: 1, inputs: [], defaults: {}, blocks } });
    const dangling = await importWorkflowDocumentViaAction({ currentDraft, draftId: 'repair',
      source: document([wait('first'), wait('first')]) });
    expect(dangling).toMatchObject({ ok: false, code: 'invalid_definition', messageKey: null });
    if (dangling.ok) throw new Error('Expected invalid definition');
    expect(dangling.issues.length).toBeGreaterThan(0);
    expect(dangling.draft).toBe(currentDraft);
    expect(dangling.repairDraft?.draftId).toBe('repair');
    const structural = await importWorkflowDocumentViaAction({ currentDraft, draftId: 'repair',
      source: document([wait('first', { unsupported: true })]) });
    expect(structural).toMatchObject({ ok: false, code: 'invalid_definition' });
    if (structural.ok) throw new Error('Expected invalid definition');
    expect(structural.issues.map(issue => issue.code)).toContain('unknown_field');
    expect(structural.repairDraft).toBeUndefined();
    expect(structural.draft).toBe(currentDraft);
  });
});
