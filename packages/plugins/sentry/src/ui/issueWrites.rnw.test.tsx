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
import type {
  PluginUiActionControlEventV1,
  PluginUiActionControlRequestV1,
} from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import issueDetail from '../fixtures/issueDetail.json' with { type: 'json' };
import { activate as activateAccount } from '../accountRuntime.js';
import { SENTRY_PLUGIN } from '../manifest.js';
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';
import {
  SENTRY_ACTION_IDS,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_PLUGIN_ID,
  SENTRY_SCOPE_SEPARATOR,
} from '../sentryContracts.js';
import { renderSurface } from './renderSurface.js';

/**
 * The person's Sentry issue writes, composed end to end below the host: the host-rendered control
 * asks the panel to prepare, the prepared input reaches the plugin's own registered writer, and only
 * the connected-account credential and Sentry HTTP are substituted.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = 'https://us.sentry.io';
const ORGANIZATION_ID = '7701';
const ACCOUNT = {
  service: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-account' },
  accountId: 'account-1',
} as const;
const INSTANCE = {
  v: 1,
  instance: {
    source: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-issues' },
    sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
  },
  binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
  localInstanceKey: `${ORIGIN}${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
  configuration: {
    v: 1,
    token: encodeSentryInstanceConfiguration({
      v: 1,
      organizationId: ORGANIZATION_ID,
      projectScope: { kind: 'allAccessible' },
      environmentScope: { kind: 'all' },
    }),
  },
  locator: { v: 1, displayLabel: 'acme-org' },
} as const;
const ENTRY_REF = {
  source: INSTANCE.instance.source,
  kindId: 'error-issue',
  collisionScope: `${ORIGIN}${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
  entryId: issueDetail.body.id,
};

function detailInput(presentation: 'active' | 'resolved' | 'suppressed', panel: 'actions' | 'overview' = 'actions') {
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: INSTANCE,
    panel,
    observation: {
      entryRef: ENTRY_REF,
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: 'https://us.sentry.io/organizations/acme-org/issues/5501001/',
        displayPath: 'acme-org/checkout',
      },
      snapshot: {
        v: 1,
        title: 'ChargeDeclined',
        scopeLabel: 'acme-org/checkout',
        state: {
          presentation,
          nativeLabel: presentation === 'active' ? 'Escalating' : 'Resolved',
        },
        facts: [],
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
}

type Recorded = Readonly<{ status: number; body: unknown; headers?: Readonly<Record<string,string>> }>;

/** Sentry over HTTP and one connected account: the only substituted boundaries. */
function providerBoundary(responses: Array<Recorded | Error | Promise<Recorded>>): Readonly<{
  context: PluginInvocationContext;
  requests: Array<{ method?: string; url: string }>;
}> {
  const requests: Array<{ method?: string; url: string }> = [];
  const context = {
    signal: new AbortController().signal,
    services: {
      connectedAccounts: {
        listAccounts: async () => ({
          status: 'complete',
          accounts: [
            {
              account: ACCOUNT,
              displayName: 'Sentry',
              state: 'connected',
              connectedAccountOrigins: [ORIGIN],
              connectedAccountBases: [ORIGIN],
            },
          ],
        }),
        materializeListedAccount: async () => ({
          kind: 'httpHeaders',
          headers: { authorization: 'Bearer test-token-value' },
        }),
        getBinding: async () => null,
      },
      http: {
        request: async (input: Readonly<{ url: string; method?: string }>) => {
          requests.push({
            url: input.url,
            ...(input.method === undefined ? {} : { method: input.method }),
          });
          const queued = responses.shift();
          const next = queued instanceof Promise ? await queued : queued;
          if (next === undefined)
            throw new Error(`unexpected request ${input.url}`);
          if (next instanceof Error) throw next;
          return {
            status: next.status,
            finalUrl: input.url,
            headers: next.headers ?? {},
            body: new TextEncoder().encode(JSON.stringify(next.body)),
          };
        },
      },
    },
  } as unknown as PluginInvocationContext;
  return { context, requests };
}

type Bound = {
  request: Extract<PluginUiActionControlRequestV1, { kind: 'bind' }>;
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
  completions: { count: number },
  panel: 'actions' | 'overview' = 'actions',
  readBoundary?: ReturnType<typeof providerBoundary>,
) {
  const plugin = await createPluginTestkit({ manifest: SENTRY_PLUGIN.manifest,
    module: { activate: SENTRY_PLUGIN.activate, activateAccount } });
  activated.push(plugin);
  const controls = new Map<string, Bound>();
  const prepared: unknown[] = [];
  const input = detailInput(presentation, panel);
  const surface = defineUiSurface((context) => (
    <TriagePostMutationCompletionProvider
      onComplete={async () => {
        completions.count += 1;
      }}
    >
      {renderSurface({
        ...context,
        launchInput: input as unknown as JsonValue,
      })}
    </TriagePostMutationCompletionProvider>
  ));
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'sentry-writes',
        mountNonce: 'sentry-writes-mount',
      },
      authorPlugin: { id: SENTRY_PLUGIN_ID, version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      launchInput: input as unknown as JsonValue,
      handlers: {
        // Panel reads are not under test; an unavailable read leaves the Overview standing.
        executeAction: async ({ action, input }) => {
          if (readBoundary !== undefined) {
            const localId = typeof action === 'string' ? action : action.localId;
            return await plugin.invokeAction(localId, input, { services: localId === SENTRY_ACTION_IDS.assign ? boundary.context.services : readBoundary.context.services }) as JsonValue;
          }
          throw Object.assign(new Error('unavailable'), {
            code: 'unavailable',
          });
        },
        async actionControl({ request, publish }) {
          if (request.kind === 'bind') {
            controls.set(request.subscriptionId, {
              request,
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
          // The host runs the prepared input through the plugin's own registered writer.
          prepared.push(request.preparation);
          const bound = controls.get(request.subscriptionId)!;
          if (request.preparation === null) return;
          const action = bound.request.action as { localId: string };
          const result = await plugin.invokeAction(
            action.localId,
            request.preparation.input,
            { services: boundary.context.services },
          );
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
  const byTitle = (title: string) =>
    [...controls.values()].find(
      (control) => control.presentation.title === title,
    );
  return { fixture, controls, prepared, byTitle };
}

async function press(
  control: Bound | undefined,
  requestId: string,
): Promise<void> {
  if (control === undefined) throw new Error('control not bound');
  await act(async () => {
    control.publish({ kind: 'prepare', requestId });
  });
}

const unresolved = { status: 200, body: issueDetail.body };
const teamsExhausted = { link: '<https://us.sentry.io/api/0/projects/7701/9001/teams/>; rel="next"; results="false"' };

describe('Sentry issue writes in the detail panel', () => {
  it('keeps the known assignee during loading and a failed directory, then retries to an honest empty directory', async () => {
    let release!: (response: Recorded) => void;
    const pending = new Promise<Recorded>(resolve => { release = resolve; });
    const reads = providerBoundary([
      unresolved, unresolved, pending, { status: 200, body: [], headers: teamsExhausted },
      unresolved, { status: 200, body: [] }, { status: 200, body: [], headers: teamsExhausted },
    ]);
    const boundary = providerBoundary([]);
    const page = await mountOverview('active', boundary, { count: 0 }, 'actions', reads);
    await expect(page.fixture.getByText('Loading people…')).resolves.toBeDefined();
    const loading = await page.fixture.getByRole('button', { name: 'Assignee, Assignee One' });
    expect(loading.state?.disabled).toBe(true);
    await act(async () => { release({ status: 403, body: {} }); });
    await vi.waitFor(async () => expect(await page.fixture.getByText('Could not load people.')).toBeDefined());
    expect((await page.fixture.getByRole('button', { name: 'Assignee, Assignee One' })).state?.disabled).toBe(true);
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('button', { name: 'Retry' })); });
    expect(await page.fixture.queryByText('Could not load people.')).toBeUndefined();
    await vi.waitFor(async () => expect(await page.fixture.getByText('No one to assign in Example Project')).toBeDefined());
    expect((await page.fixture.getByRole('button', { name: 'Assignee, Assignee One' })).state?.disabled).toBe(true);
    expect(boundary.requests).toHaveLength(0);
    expect(reads.requests).toHaveLength(7);
  });

  it('shows named members and teams, assigns through the existing Action and refreshes the confirmed value', async () => {
    const member = { type: 'user', id: '88', name: 'Ada' };
    const summary = { status: 200, body: { ...issueDetail.body, assignedTo: null } };
    const reads = providerBoundary([
      summary, summary,
      { status: 200, body: [{ id: 'membership-4', user: { id: '88', name: 'Ada' } }] },
      { status: 200, body: [{ id: '7', name: 'Payments' }], headers: teamsExhausted },
      { status: 200, body: { ...issueDetail.body, assignedTo: member } },
      { status: 200, body: [{ id: 'membership-4', user: { id: '88', name: 'Ada' } }] },
      { status: 200, body: [{ id: '7', name: 'Payments' }], headers: teamsExhausted },
    ]);
    const boundary = providerBoundary([
      summary, { status: 200, body: {} }, { status: 200, body: { ...issueDetail.body, assignedTo: member } },
    ]);
    const completions = { count: 0 };
    const page = await mountOverview('active', boundary, completions, 'actions', reads);
    await vi.waitFor(async () => expect((await page.fixture.getByRole('button', { name: 'Assignee, Unassigned' })).state?.disabled).not.toBe(true));
    const assignee = await page.fixture.getByRole('button', { name: 'Assignee, Unassigned' });
    await act(async () => { await page.fixture.press(assignee); });
    await expect(page.fixture.getByText('Member')).resolves.toBeDefined();
    await expect(page.fixture.getByText('Team')).resolves.toBeDefined();
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('menuitemradio', { name: 'Ada · Member' })); });
    await vi.waitFor(async () => expect(await page.fixture.getByRole('button', { name: 'Assignee, Ada' })).toBeDefined());
    expect(boundary.requests.map((request) => request.method ?? 'GET')).toEqual(['GET', 'PUT', 'GET']);
    expect(completions.count).toBe(1);
    expect(reads.requests).toHaveLength(7);
  });

  it('keeps a current person outside the directory readable and lets the person clear assignment', async () => {
    const cleared = { status: 200, body: { ...issueDetail.body, assignedTo: null } };
    const members = { status: 200, body: [{ user: { id: '88', name: 'Ada' } }] };
    const teams = { status: 200, body: [], headers: teamsExhausted };
    const reads = providerBoundary([unresolved, unresolved, members, teams, cleared, members, teams]);
    const boundary = providerBoundary([unresolved, { status: 200, body: {} }, cleared]);
    const completions = { count: 0 };
    const page = await mountOverview('active', boundary, completions, 'actions', reads);
    await vi.waitFor(async () => expect((await page.fixture.getByRole('button', { name: 'Assignee, Assignee One' })).state?.disabled).not.toBe(true));
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('button', { name: 'Assignee, Assignee One' })); });
    await act(async () => { await page.fixture.press(await page.fixture.getByRole('menuitem', { name: 'Unassigned' })); });
    await vi.waitFor(async () => expect(await page.fixture.getByRole('button', { name: 'Assignee, Unassigned' })).toBeDefined());
    expect(boundary.requests.map(request => request.method ?? 'GET')).toEqual(['GET', 'PUT', 'GET']);
    expect(completions.count).toBe(1);
    expect(reads.requests).toHaveLength(7);
  });

  it('are the issue\u2019s own actions in the header, never a band under the Overview story', async () => {
    const page = await mountOverview('active', providerBoundary([]), { count: 0 }, 'overview');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(page.controls.size).toBe(0);
  });

  it('offers Resolve and Archive on an active issue and settles Resolve through the registered writer once', async () => {
    const boundary = providerBoundary([
      unresolved,
      { status: 200, body: { status: 'resolved' } },
      {
        status: 200,
        body: { ...issueDetail.body, status: 'resolved', substatus: null },
      },
    ]);
    const completions = { count: 0 };
    const page = await mountOverview('active', boundary, completions);
    await vi.waitFor(() =>
      expect(
        [...page.controls.values()].map(
          (control) => control.presentation.title,
        ),
      ).toEqual(['Resolve', 'Archive']),
    );
    expect(
      [...page.controls.values()].map((control) => control.request.action),
    ).toEqual([
      { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.resolve },
      { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.archive },
    ]);

    await press(page.byTitle('Resolve'), 'press-1');
    await vi.waitFor(async () => expect(await page.fixture.getByText('Resolved in Sentry')).toBeDefined());
    expect(page.prepared).toEqual([
      {
        input: {
          v: 1,
          instance: INSTANCE,
          localRef: {
            kindId: 'error-issue',
            collisionScope: ENTRY_REF.collisionScope,
            entryId: issueDetail.body.id,
          },
        },
      },
    ]);
    expect(boundary.requests.map((request) => request.method ?? 'GET')).toEqual(
      ['GET', 'PUT', 'GET'],
    );
    expect(completions.count).toBe(1);
  });

  it('holds every write after an unconfirmed outcome and never replays it', async () => {
    const boundary = providerBoundary([
      unresolved,
      new Error('connection lost'),
      unresolved,
    ]);
    const completions = { count: 0 };
    const page = await mountOverview('active', boundary, completions);
    await vi.waitFor(() => expect(page.byTitle('Resolve')).toBeDefined());

    await press(page.byTitle('Resolve'), 'press-1');
    await vi.waitFor(async () => expect(await page.fixture.getByText('Sentry may already have made this change.')).toBeDefined());
    await vi.waitFor(() =>
      expect(
        [...page.controls.values()].every(
          (control) => control.presentation.disabled === true,
        ),
      ).toBe(true),
    );
    expect(boundary.requests.map((request) => request.method ?? 'GET')).toEqual(
      ['GET', 'PUT', 'GET'],
    );

    // A second host press on the held control prepares nothing, so nothing reaches Sentry.
    await press(page.byTitle('Archive'), 'press-2');
    expect(page.prepared.at(-1)).toBeNull();
    expect(boundary.requests).toHaveLength(3);
    expect(completions.count).toBe(1);
  });

  it('offers no state write on a resolved issue', async () => {
    const page = await mountOverview('resolved', providerBoundary([]), {
      count: 0,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(page.controls.size).toBe(0);
  });
});
