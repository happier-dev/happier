// @vitest-environment jsdom
import React, { act } from 'react';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiActionControlEventV1 } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, expect, it } from 'vitest';
import { JIRA_ACCOUNT_PURPOSE, JIRA_ACTIONS, JIRA_PLUGIN_ID, JIRA_SOURCE_ID } from '../contracts.js';
import { activate as activateAccount } from '../accountRuntime.js';
import { JIRA_PLUGIN } from '../manifest.js';
import { renderSurface } from './renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const backends: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  for (const backend of backends.splice(0)) await backend.dispose();
});
const adf = (text: string) => ({ type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function mountComments(outcome: 'applied' | 'uncertain' | 'failed') {
  const fixture = createTriageSourceV1Fixture();
  const origin = 'https://work.atlassian.net';
  const account = { service: { pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACCOUNT_PURPOSE }, accountId: 'account-1' };
  const instance = { ...fixture.configuredInstance,
    instance: { ...fixture.configuredInstance.instance, source: { pluginId: JIRA_PLUGIN_ID, localId: JIRA_SOURCE_ID } },
    binding: { purpose: JIRA_ACCOUNT_PURPOSE, account }, localInstanceKey: `${origin}#10000`,
    configuration: { v: 1 as const, token: JSON.stringify({ v: 1, projectId: '10000', involvement: 'mine' }) } };
  const localRef = { kindId: 'issue', collisionScope: `jira:${origin}`, entryId: '10001' };
  // Synthetic Jira REST DTO at the genuine HTTP boundary; all projection and write logic remains real.
  const issue = { id: localRef.entryId, key: 'ABC-123', fields: {
    summary: 'Keep queued work', project: { id: '10000', key: 'ABC', name: 'Platform' },
    status: { id: '3', name: 'In progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { id: '10002', name: 'Task' }, creator: { accountId: 'person-1', displayName: 'Amina' },
    assignee: null, labels: [], created: '2026-10-01T12:00:00Z', updated: '2026-10-18T12:00:00Z',
    description: adf('Keep queued work.'),
  }, schema: {} };
  const methods: string[] = [];
  const readPaths: string[] = [];
  const context = { signal: new AbortController().signal, services: {
    connectedAccounts: {
      listAccounts: async () => ({ status: 'complete', accounts: [{ account, state: 'connected', connectedAccountOrigins: [origin] }] }),
      materializeListedAccount: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Basic fixture-only' } }),
    },
    http: { request: async (request: { url: string; method: string }) => {
      methods.push(request.method);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') readPaths.push(path);
      if (request.method === 'POST' && outcome === 'uncertain') throw new Error('answer lost');
      const body = path.endsWith('/myself') ? { accountId: 'person-1' }
        : request.method === 'POST' ? { id: 'comment-1' }
          : path.endsWith('/comment/comment-1') ? { id: 'comment-1', body: adf('Checked recovery.') } : issue;
      return { status: request.method === 'POST' && outcome === 'failed' ? 403 : 200,
        finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } },
  } } as unknown as PluginInvocationContext;
  const backend = await createPluginTestkit({ manifest: JIRA_PLUGIN.manifest,
    module: { activate: JIRA_PLUGIN.activate, activateAccount }, services: context.services });
  backends.push(backend);
  const controls = new Map<string, { publish(event: PluginUiActionControlEventV1): void; disabled?: boolean }>();
  const prepared: unknown[] = [];
  const settlements: unknown[] = [];
  const detailReads: unknown[] = [];
  const input = TriageDetailSurfaceInputV1Schema.parse({ v: 1, instance, panel: 'overview', linkedSessions: [],
    observation: { entryRef: { source: instance.instance.source, ...localRef }, observedAtMs: 1000,
      locator: { v: 1, webUrl: `${origin}/browse/ABC-123` }, snapshot: { v: 1, title: issue.fields.summary,
        scopeLabel: 'Platform', state: { presentation: 'active' }, facts: [] }, viewer: { involvement: [] } } });
  let page!: PluginUiTestkit;
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: 'jira-comments', mountNonce: outcome },
      authorPlugin: { id: JIRA_PLUGIN_ID, version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input as unknown as JsonValue, handlers: {
        executeAction: async ({ action, input }) => {
          expect(action).toEqual({ pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.detail });
          detailReads.push(input);
          return backend.invokeAction(JIRA_ACTIONS.detail, input) as Promise<JsonValue>;
        },
        actionControl: async ({ request, publish }) => {
          if (request.kind === 'bind') {
            expect(request.action).toEqual({ pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.comment });
            controls.set(request.subscriptionId, { publish, disabled: request.presentation.disabled });
          } else if (request.kind === 'update') {
            controls.get(request.subscriptionId)!.disabled = request.presentation.disabled;
          } else {
            prepared.push(request.preparation);
            if (request.preparation === null) return;
            const result = await backend.invokeAction(JIRA_ACTIONS.comment, request.preparation.input ?? null);
            settlements.push(result);
            publish({ kind: 'settled', requestId: request.requestId,
              execution: { ok: true, result: result as JsonValue } });
          }
        },
      } });
  });
  mounted.push(page);
  return { page, prepared, settlements, detailReads, readPaths, methods, instance, localRef, control: () => [...controls.values()][0]! };
}

it.each(['applied', 'uncertain', 'failed'] as const)('settles a Jira comment as %s through its registered writer without replay', async outcome => {
  const mounted = await mountComments(outcome);
  await expect(mounted.page.getByText('Keep queued work.')).resolves.toBeDefined();
  expect(mounted.detailReads).toHaveLength(1);
  expect(mounted.readPaths).toEqual(['/rest/api/3/issue/10001', '/rest/api/3/myself']);
  await act(async () => { await mounted.page.updateSurface(createSurfaceContextFixture()); });
  expect(mounted.detailReads).toHaveLength(1);
  expect(mounted.readPaths).toHaveLength(2);
  expect(mounted.control().disabled).toBe(true);
  const field = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Checked recovery.');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(mounted.methods.filter(method => method === 'POST')).toEqual([]);
  await act(async () => { mounted.control().publish({ kind: 'prepare', requestId: 'press-1' }); });
  expect(mounted.prepared).toEqual([{ input: { entry: { v: 1, instance: mounted.instance,
    localRef: mounted.localRef }, body: 'Checked recovery.' } }]);
  expect(mounted.methods.filter(method => method === 'POST')).toHaveLength(1);
  expect(mounted.settlements).toEqual([expect.objectContaining({ kind: outcome })]);
  expect(field.value).toBe(outcome === 'applied' ? '' : 'Checked recovery.');
  if (outcome !== 'failed') await expect(mounted.page.getByText(outcome === 'applied' ? 'Comment published'
    : 'Jira may already have made this change.')).resolves.toBeDefined();
  if (outcome === 'uncertain') {
    expect(mounted.control().disabled).toBe(true);
    await act(async () => { mounted.control().publish({ kind: 'prepare', requestId: 'press-2' }); });
    expect(mounted.prepared.at(-1)).toBeNull();
    expect(mounted.methods.filter(method => method === 'POST')).toHaveLength(1);
  }
});
