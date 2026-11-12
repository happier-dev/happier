// @vitest-environment jsdom
import * as React from 'react';
import { act, cloneElement, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import type { PluginUiActionFailureV1 } from '@happier-dev/plugin-sdk/ui';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import { useTriageActions } from './actions/useTriageActions.js';
import { useTriageConfiguredSources } from './configuration/useTriageConfiguredSources.js';
import { useTriagePinnedEntries } from './marks/useTriagePinnedEntries.js';
import { projectTriagePinnedRow } from './marks/pinnedRows.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const page of mounted.splice(0)) await act(async () => { await page.dispose(); }); });

const paths = ['actions-read', 'actions-resolve', 'actions-write', 'actions-account-write', 'actions-settlement',
  'sources-read', 'sources-watch', 'sources-remove', 'pins-read', 'pins-watch', 'pins-write'] as const;
type Path = typeof paths[number];
const authoredFailure = {
  details: { requestId: 'catalog-failure-request', operation: 'catalog-write' },
  remediation: { kind: 'retry' as const },
  diagnostics: [{ code: 'catalog_storage_failed', severity: 'error' as const }],
};

async function mountFailure(path: Path, holdFailure = false) {
  const corpus = createTestkitCorpusCollections();
  const accountKv = createTestkitAccountKv();
  const error = new PluginError({ code: 'account_storage_failed', message: 'Account storage failed',
    ...authoredFailure });
  let fail = path.endsWith('-read') || path.endsWith('-watch');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const failBoundary = async () => { if (holdFailure) await pending; throw error; };
  const failures: PluginUiActionFailureV1[] = [];
  const notifications: string[] = [];
  const diagnostics: unknown[] = [];
  let actions!: ReturnType<typeof useTriageActions>;
  let sources!: ReturnType<typeof useTriageConfiguredSources>;
  let pins!: ReturnType<typeof useTriagePinnedEntries>;
  // Only the persistent Account stores and watch transport are replaced. All hooks, bindings and readers stay real.
  const client = {
    collection(definition: { id: string }) {
      const collection = definition.id === 'source-instances' ? corpus.collections.sourceInstances
        : definition.id === 'user-marks' ? corpus.collections.userMarks : corpus.collections.sessionLinks;
      return { ...collection, query: async (...args: Parameters<typeof collection.query>) => {
        if (fail && path.endsWith('-read')) await failBoundary();
        return collection.query(...args);
      } };
    },
    accountKv: { ...accountKv.kv, get: async (...args: Parameters<typeof accountKv.kv.get>) => {
      if (fail) await failBoundary();
      return accountKv.kv.get(...args);
    } },
    async watchAccountData() {
      if (fail && path.endsWith('-watch')) await failBoundary();
      return { dispose() {} };
    },
  } as unknown as PluginUiDataClient;
  const surface = defineUiSurface(() => {
    if (path.startsWith('actions-')) actions = useTriageActions();
    else if (path.startsWith('sources-')) sources = useTriageConfiguredSources();
    else pins = useTriagePinnedEntries();
    return null;
  });
  const adapter = createPluginUiRnwSemanticSurfaceAdapter();
  let page!: PluginUiTestkit;
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: path, mountNonce: path },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture(), adapter: { async mount(input) {
        return adapter.mount({ ...input, surface: context => cloneElement(
          input.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient: client }) });
      } }, handlers: {
        admitAction: async () => { if (fail && path !== 'actions-account-write') throw error; return true; },
        presentActionFailure: async ({ failure }) => { failures.push(failure); return {
          reason: 'Account storage failed', nextStep: 'Retry', technicalDetails: [
            { key: 'code', label: 'Code', value: failure.errorCode },
            ...(failure.requestId ? [{ key: 'requestId', label: 'Request ID', value: failure.requestId }] : []),
          ],
        }; },
        notify: async ({ message }) => { notifications.push(message); },
        diagnostic: ({ data }) => { diagnostics.push(data); },
      },
    });
  });
  mounted.push(page);
  await act(async () => { await Promise.resolve(); });
  return { page, failures, notifications, diagnostics, release, fail: () => { fail = true; },
    actions: () => actions, sources: () => sources, pins: () => pins };
}

it.each(paths)('preserves the typed Code and Request ID at the visible presenter for %s', async path => {
  const harness = await mountFailure(path);
  await act(async () => {
    harness.fail();
    if (path === 'actions-resolve') await harness.actions().resolveForExecution('ask', []);
    if (path === 'actions-write' || path === 'actions-account-write') await harness.actions().administer({ v: 1, kind: 'reset', expectedRevision: 'absent' });
    if (path === 'actions-settlement') await harness.actions().settleAdminister(
      { v: 1, kind: 'reset', expectedRevision: 'absent' },
      { ok: false, errorCode: 'account_storage_failed', error: 'Account storage failed', requestId: 'catalog-failure-request', details: authoredFailure });
    if (path === 'sources-remove') await harness.sources().remove('00000000-0000-4000-8000-000000000001');
    if (path === 'pins-write') harness.pins().setPinned(projectTriagePinnedRow({ entryRef: testkitEntryRef(),
      markedAtMs: 1, displayAtMark: { title: 'Pinned entry', scopeLabel: 'scope' } }, null));
  });
  await act(async () => { await Promise.resolve(); });
  // Host admission currently loses author metadata in the upstream UI transport; this hook must keep its surviving code and correlation.
  const { diagnostics: authoredDiagnostics, ...authorPresentation } = authoredFailure;
  const throughHostAdmission = path === 'actions-write' || path === 'sources-remove' || path === 'pins-write';
  expect(harness.failures).toEqual([expect.objectContaining({ errorCode: 'account_storage_failed', requestId: 'catalog-failure-request',
    ...(throughHostAdmission ? {} : authorPresentation) })]);
  expect(harness.diagnostics).toEqual(expect.arrayContaining(authoredDiagnostics));
  expect(harness.notifications.join(' ')).toContain('Code: account_storage_failed');
  expect(harness.notifications.join(' ')).toContain('Request ID: catalog-failure-request');
});


it.each(['actions-read', 'sources-read', 'sources-watch', 'pins-read', 'pins-watch'] as const)(
  'keeps an aborted %s quiet when its transport rejects late', async path => {
    const harness = await mountFailure(path, true);
    await act(async () => { await harness.page.dispose(); });
    mounted.splice(mounted.indexOf(harness.page), 1);
    await act(async () => { harness.release(); await Promise.resolve(); });
    expect(harness.failures).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });
