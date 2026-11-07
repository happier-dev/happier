// @vitest-environment jsdom
import React, { act } from 'react';
import type {
  JsonValue,
  PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginTestkit,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginUiActionControlEventV1 } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import crudIssueRead from '../api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import queryIssueDetail from '../api/__fixtures__/queryIssueDetail.json' with { type: 'json' };
import { activate } from '../activate.js';
import { activate as activateAccount } from '../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import {
  POSTHOG_ACTION_IDS,
  POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
  POSTHOG_PLUGIN_ID,
} from '../posthogContracts.js';
import { encodePosthogConfiguration } from '../source/instance.js';
import { renderSurface } from './renderSurface.js';

/**
 * The person's PostHog issue writes, composed below the host: the host control prepares from the
 * panel, the plugin's own registered writer runs, and only PostHog HTTP and the account are fake.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = 'https://eu.posthog.com';
const ACCOUNT = {
  service: {
    pluginId: POSTHOG_PLUGIN_ID,
    localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
  },
  accountId: 'account-1',
} as const;
const COLLISION_SCOPE = `posthog:${ORIGIN}:00000000-0000-4000-8000-0000000000d1`;

function configuredInstance() {
  const fixture = createTriageSourceV1Fixture();
  const encoded = encodePosthogConfiguration({
    v: 1,
    organizationUuid: '00000000-0000-4000-8000-0000000000a1',
    environments: [
      {
        teamPathId: 4821,
        teamUuid: '00000000-0000-4000-8000-0000000000d1',
        parentProjectId: 4820,
        displayName: 'Storefront production',
      },
    ],
    scanWindowPolicy: {
      kind: 'exact',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-15T00:00:00.000Z',
    },
    detailWindowPolicy: { kind: 'relative', durationMs: 30 * 86_400_000 },
  });
  if (!encoded.ok) throw new Error('fixture configuration must encode');
  return {
    ...fixture.configuredInstance,
    instance: {
      ...fixture.configuredInstance.instance,
      source: {
        pluginId: POSTHOG_PLUGIN_ID,
        localId: 'posthog-error-tracking',
      },
    },
    binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
    localInstanceKey: `posthog-org:${ORIGIN}:00000000-0000-4000-8000-0000000000a1`,
    configuration: { v: 1 as const, token: encoded.token },
  };
}

const INSTANCE = configuredInstance();
const LOCAL_REF = {
  kindId: 'error-issue',
  collisionScope: COLLISION_SCOPE,
  entryId: crudIssueRead.id,
};

function detailInput(presentation: 'active' | 'resolved' | 'suppressed', panel: 'actions' | 'overview' = 'actions') {
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: INSTANCE,
    panel,
    observation: {
      entryRef: { source: INSTANCE.instance.source, ...LOCAL_REF },
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: `${ORIGIN}/project/4821/error_tracking/${crudIssueRead.id}`,
        displayPath: 'Storefront production',
      },
      snapshot: {
        v: 1,
        title: 'TypeError: cart is undefined',
        scopeLabel: 'Storefront production',
        state: { presentation, nativeLabel: presentation },
        facts: [],
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
}

function providerBoundary(responses: unknown[]) {
  const methods: string[] = [];
  const context = {
    signal: new AbortController().signal,
    services: {
      connectedAccounts: {
        listAccounts: async () => ({
          status: 'complete',
          accounts: [
            {
              account: ACCOUNT,
              displayName: 'PostHog',
              state: 'connected',
              connectedAccountOrigins: [ORIGIN],
              connectedAccountBases: [ORIGIN],
            },
          ],
        }),
        materializeListedAccount: async () => ({
          kind: 'httpHeaders',
          headers: { authorization: 'Bearer secret' },
        }),
        getBinding: async () => null,
      },
      http: {
        request: async (input: Readonly<{ url: string; method?: string }>) => {
          methods.push(input.method ?? 'GET');
          if (responses.length === 0)
            throw new Error(`unexpected request ${input.url}`);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          return {
            status: 200,
            finalUrl: input.url,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify(response)),
          };
        },
      },
    },
  } as unknown as PluginInvocationContext;
  return { context, methods };
}

type Bound = {
  action: unknown;
  publish(event: PluginUiActionControlEventV1): void;
  presentation: { title: string; disabled?: boolean };
};
const mounted: PluginUiTestkit[] = [];
const activated: PluginTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  for (const plugin of activated.splice(0)) await plugin.dispose();
});

async function mountOverview(
  presentation: 'active' | 'resolved' | 'suppressed',
  boundary: ReturnType<typeof providerBoundary>,
  panel: 'actions' | 'overview' = 'actions',
  readAssignment = false,
) {
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: boundary.context.services });
  activated.push(plugin);
  const controls = new Map<string, Bound>();
  const prepared: unknown[] = [];
  const input = detailInput(presentation, panel);
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'posthog-writes',
        mountNonce: 'posthog-writes-mount',
      },
      authorPlugin: { id: POSTHOG_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      launchInput: input as unknown as JsonValue,
      handlers: {
        // Panel reads are not under test; an unavailable read keeps the observation's state.
        executeAction: async ({ action, input: actionInput }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          if (readAssignment && (localId === POSTHOG_ACTION_IDS.nativeOverview || localId === POSTHOG_ACTION_IDS.assign)) {
            return await plugin.invokeAction(localId, actionInput) as JsonValue;
          }
          throw Object.assign(new Error('unavailable'), {
            code: 'unavailable',
          });
        },
        async actionControl({ request, publish }) {
          if (request.kind === 'bind') {
            controls.set(request.subscriptionId, {
              action: request.action,
              publish,
              presentation: request.presentation,
            });
            return;
          }
          if (request.kind === 'update') {
            controls.get(request.subscriptionId)!.presentation =
              request.presentation;
            return;
          }
          prepared.push(request.preparation);
          if (request.preparation === null) return;
          const { localId } = controls.get(request.subscriptionId)!.action as {
            localId: string;
          };
          const result = await plugin.invokeAction(localId, request.preparation.input);
          publish({
            kind: 'settled',
            requestId: request.requestId,
            execution: { ok: true, result: result as JsonValue },
          });
        },
      },
    });
  });
  mounted.push(fixture);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { fixture, controls, prepared };
}

describe('PostHog issue writes in the detail panel', () => {
  it('chooses named users and roles and confirms assignment and clearing through the existing Action', async () => {
    const members = { results: [{ user: { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' } }], next: null };
    const roles = { results: [{ id: '00000000-0000-4000-8000-000000000042', name: 'On call' }], next: null };
    const boundary = providerBoundary([
      { ...crudIssueRead, assignee: null }, queryIssueDetail, members, roles,
      crudIssueRead, { success: true }, { ...crudIssueRead, assignee: { type: 'user', id: 42 } },
      { ...crudIssueRead, assignee: { type: 'user', id: 42 } }, queryIssueDetail, members, roles,
      crudIssueRead, { success: true }, { ...crudIssueRead, assignee: { type: 'role', id: '00000000-0000-4000-8000-000000000042' } },
      { ...crudIssueRead, assignee: { type: 'role', id: '00000000-0000-4000-8000-000000000042' } }, queryIssueDetail, members, roles,
      crudIssueRead, { success: true }, { ...crudIssueRead, assignee: null },
      { ...crudIssueRead, assignee: null }, queryIssueDetail, members, roles,
    ]);
    const page = await mountOverview('active', boundary, 'actions', true);
    await act(async () => { await page.fixture.press(await page.fixture.findByRole('button', { name: 'Assignee, Unassigned' })); });
    await expect(page.fixture.getByText('User')).resolves.toBeDefined();
    await expect(page.fixture.getByText('Role')).resolves.toBeDefined();
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('menuitemradio', { name: 'Ada Lovelace · User' })); });
    await expect(page.fixture.findByRole('button', { name: 'Assignee, Ada Lovelace' })).resolves.toBeDefined();
    if (await page.fixture.queryByRole('menuitemradio', { name: 'On call · Role' }) === undefined)
      await act(async () => { await page.fixture.press(await page.fixture.getByRole('button', { name: 'Assignee, Ada Lovelace' })); });
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('menuitemradio', { name: 'On call · Role' })); });
    await expect(page.fixture.findByRole('button', { name: 'Assignee, On call' })).resolves.toBeDefined();
    if (await page.fixture.queryByRole('menuitem', { name: 'Unassigned' }) === undefined)
      await act(async () => { await page.fixture.press(await page.fixture.getByRole('button', { name: 'Assignee, On call' })); });
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('menuitem', { name: 'Unassigned' })); });
    await expect(page.fixture.findByRole('button', { name: 'Assignee, Unassigned' })).resolves.toBeDefined();
    expect(boundary.methods.filter(method => method === 'PATCH')).toHaveLength(3);
  });

  it('names an empty assignment directory and retries a failed read without writing', async () => {
    const boundary = providerBoundary([
      { ...crudIssueRead, assignee: null }, queryIssueDetail, new Error('directory unavailable'),
      { ...crudIssueRead, assignee: null }, queryIssueDetail, { results: [], next: null }, { results: [], next: null },
    ]);
    const page = await mountOverview('active', boundary, 'actions', true);
    await expect.poll(() => page.fixture.queryByText('Could not load assignable people')).toBeDefined();
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('button', { name: 'Retry' })); });
    await expect.poll(() => page.fixture.queryByText('No one to assign in Storefront production')).toBeDefined();
    expect(boundary.methods.filter(method => method === 'PATCH')).toHaveLength(0);
  });

  it('does not call an unknown current assignee Unassigned or expose its id as a name', async () => {
    const boundary = providerBoundary([
      { ...crudIssueRead, assignee: { type: 'user', id: 999 } }, queryIssueDetail,
      { results: [{ user: { id: 42, first_name: 'Ada' } }], next: null }, { results: [], next: null },
    ]);
    const page = await mountOverview('active', boundary, 'actions', true);
    await expect.poll(() => page.fixture.queryByText('Current assignee is unavailable')).toBeDefined();
    expect(await page.fixture.queryByRole('button', { name: 'Assignee, Unassigned' })).toBeUndefined();
    expect(await page.fixture.queryByText('999')).toBeUndefined();
    expect(boundary.methods.filter(method => method === 'PATCH')).toHaveLength(0);
  });

  it('holds assignment and status writes after an unconfirmed assignment without replay', async () => {
    const current = { ...crudIssueRead, assignee: { type: 'user', id: 42 } };
    const members = { results: [{ user: { id: 42, first_name: 'Ada' } }], next: null };
    const roles = { results: [{ id: '00000000-0000-4000-8000-000000000042', name: 'On call' }], next: null };
    const boundary = providerBoundary([
      current, queryIssueDetail, members, roles,
      current, new Error('answer lost'), current,
      current, queryIssueDetail, members, roles,
    ]);
    const page = await mountOverview('active', boundary, 'actions', true);
    await act(async () => { await page.fixture.press(await page.fixture.findByRole('button', { name: 'Assignee, Ada' })); });
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('menuitemradio', { name: 'On call · Role' })); });
    await expect.poll(() => page.fixture.queryByText('PostHog may already have made this change.')).toBeDefined();
    await expect(page.fixture.findByRole('button', { name: 'Assignee, Ada', state: { disabled: true } })).resolves.toBeDefined();
    expect([...page.controls.values()].every(control => control.presentation.disabled === true)).toBe(true);
    expect(boundary.methods.filter(method => method === 'PATCH')).toHaveLength(1);
  });
  it('are the issue\u2019s own actions in the header, never a band under the Overview story', async () => {
    const page = await mountOverview('active', providerBoundary([]), 'overview');
    expect(page.controls.size).toBe(0);
  });

  it.each([
    [
      'active',
      ['Resolve', 'Suppress'],
      [POSTHOG_ACTION_IDS.resolve, POSTHOG_ACTION_IDS.suppress],
    ],
    ['resolved', ['Suppress'], [POSTHOG_ACTION_IDS.suppress]],
    ['suppressed', ['Unsuppress'], [POSTHOG_ACTION_IDS.unsuppress]],
  ] as const)(
    'offers only the writes that change a %s issue',
    async (presentation, titles, actions) => {
      const page = await mountOverview(presentation, providerBoundary([]));
      expect(
        [...page.controls.values()].map(
          (control) => control.presentation.title,
        ),
      ).toEqual(titles);
      expect(
        [...page.controls.values()].map((control) => control.action),
      ).toEqual(
        actions.map((localId) => ({ pluginId: POSTHOG_PLUGIN_ID, localId })),
      );
    },
  );

  it('suppresses through the registered writer once and reports the confirmed state', async () => {
    const boundary = providerBoundary([
      crudIssueRead,
      { success: true },
      { ...crudIssueRead, status: 'suppressed' },
    ]);
    const page = await mountOverview('active', boundary);
    const suppress = [...page.controls.values()].find(
      (control) => control.presentation.title === 'Suppress',
    )!;
    await act(async () => {
      suppress.publish({ kind: 'prepare', requestId: 'press-1' });
    });
    await expect.poll(() => page.fixture.queryByText('Suppressed in PostHog')).toBeDefined();
    expect(page.prepared).toEqual([
      { input: { v: 1, instance: INSTANCE, localRef: LOCAL_REF } },
    ]);
    expect(boundary.methods).toEqual(['GET', 'PATCH', 'GET']);
  });

  it('holds every write after an unconfirmed suppression and never replays it', async () => {
    const boundary = providerBoundary([crudIssueRead, new Error('answer lost'), crudIssueRead]);
    const page = await mountOverview('active', boundary);
    const suppress = [...page.controls.values()].find(control => control.presentation.title === 'Suppress')!;
    await act(async () => { suppress.publish({ kind: 'prepare', requestId: 'press-1' }); });
    await expect.poll(() => page.fixture.queryByText('PostHog may already have made this change.')).toBeDefined();
    expect([...page.controls.values()].every(control => control.presentation.disabled === true)).toBe(true);
    const resolve = [...page.controls.values()].find(control => control.presentation.title === 'Resolve')!;
    await act(async () => { resolve.publish({ kind: 'prepare', requestId: 'press-2' }); });
    expect(page.prepared.at(-1)).toBeNull();
    expect(boundary.methods.filter(method => method === 'PATCH')).toHaveLength(1);
  });
});
