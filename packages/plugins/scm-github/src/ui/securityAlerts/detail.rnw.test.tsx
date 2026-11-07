// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import {
  TriageDetailInstance,
  TriageDetailPanelNavigationProvider,
  TriageEvidenceDisclosureProvider,
  type TriageDetailFixPullRequestNavigationV1,
  type TriageDetailPrimaryWriteV1,
} from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_SECURITY_ALERT_ACTION_IDS_V1 as ids,
  GithubSecurityAlertReadResultV1Schema,
} from '../../triage/securityAlerts/actionContracts.js';
import { GithubSecurityAlertBody } from './detail.js';
import { renderSurface } from '../renderSurface.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0))
    await act(async () => {
      await fixture.dispose();
    });
});

const signal = new AbortController().signal;
function dependabotInput() {
  const source = {
    pluginId: 'happier.scm.forge.github',
    localId: 'github-forge',
  };
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: {
      v: 1,
      instance: {
        source,
        sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
      },
      binding: {
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        account: {
          service: { pluginId: source.pluginId, localId: 'github-account' },
          accountId: 'account-1',
        },
      },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token: 'fixture' },
    },
    observation: {
      entryRef: {
        source,
        kindId: 'dependabot-alert',
        collisionScope: 'github:1',
        entryId: '7',
      },
      observedAtMs: 100,
      locator: { v: 1, routingToken: 'owner/repo' },
      snapshot: {
        v: 1,
        title: 'Prototype pollution in lodash',
        scopeLabel: 'owner/repo',
        state: { presentation: 'active', nativeLabel: 'open' },
        facts: [],
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
}
function dependabotAnswer(
  input: ReturnType<typeof dependabotInput>,
  nativeState: 'open' | 'fixed',
): JsonValue {
  return GithubSecurityAlertReadResultV1Schema.parse({
    kind: 'alert',
    kindId: 'dependabot-alert',
    detail: {
      nativeState,
      severity: 'high',
      projectionTruncated: false,
      url: 'https://github.com/owner/repo/security/dependabot/7',
      dismissedReason: null,
      dismissedComment: null,
      dismissedBy: null,
      dismissedAt: null,
      summary: 'Prototype pollution in lodash',
      advisory: '',
      advisoryId: 'GHSA-xxxx-yyyy-zzzz',
      packageName: 'lodash',
      ecosystem: 'npm',
      manifestPath: 'package.json',
      dependencyScope: 'runtime',
      relationship: 'direct',
      affectedRange: '< 4.17.21',
      patchedVersion: '4.17.21',
    },
    observation:
      input.observation === undefined
        ? undefined
        : {
            kind: 'present',
            localRef: {
              kindId: 'dependabot-alert',
              collisionScope: 'github:1',
              entryId: '7',
            },
            locator: input.observation.locator,
            snapshot: input.observation.snapshot,
            viewer: input.observation.viewer,
          },
  });
}

async function mountBody(
  nativeState: 'open' | 'fixed',
  fixPullRequest: TriageDetailFixPullRequestNavigationV1 | null,
  throughEntry = false,
  readError?: PluginError,
  fixPullRequestsEmpty = fixPullRequest === null,
): Promise<PluginUiTestkit> {
  const input = dependabotInput();
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-detail', mountNonce: 'alert-detail' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(context => (
        <TriageDetailInstance>
          <TriageDetailPanelNavigationProvider
            navigation={{
              panels: ['overview', 'actions'],
              select: () => {},
              fixPullRequestsEmpty,
              ...(fixPullRequest === null ? {} : { fixPullRequest }),
            }}
          >
            {throughEntry ? renderSurface({ ...context, launchInput: input }) as React.ReactNode : <GithubSecurityAlertBody
              input={input}
              detailActivity={{ active: true, activeSignal: signal }}
              renderers={{
                renderMarkdown: () => null,
                renderOutcome: () => null,
              }}
            />}
          </TriageDetailPanelNavigationProvider>
        </TriageDetailInstance>
      )),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action }) => {
          expect((action as { localId: string }).localId).toBe(ids.read);
          if (readError !== undefined) throw readError;
          return dependabotAnswer(input, nativeState);
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

it('withholds update guidance until the fix association answers, and retains guidance for an answered empty association', async () => {
  const pending = await mountBody('open', null, false, undefined, false);
  expect(document.body.textContent).not.toContain('Updating lodash');
  await act(async () => { await pending.dispose(); });
  mounted.splice(mounted.indexOf(pending), 1);
  await mountBody('open', null);
  expect(document.body.textContent).toContain('Updating lodash');
});

it('keeps a security-alert dispatch refusal in Details without offering a forbidden retry', async () => {
  const fixture = await mountBody('open', null, true, new PluginError({
    code: 'unavailable', retryable: false,
    diagnostics: [{ code: 'plugin_surface_action_projection_unavailable', severity: 'error' }],
  }));
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
  expect(document.body.textContent).toContain('plugin_surface_action_projection_unavailable');
  expect(document.body.textContent).toContain('retryable=false');
  await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
});

/** The alert's Overview mount inside the Triage header's primary-write seam, recording each offer and dispatch. */
async function mountOffering(nativeState: 'open' | 'dismissed', withoutOpener = false): Promise<Readonly<{
  fixture: PluginUiTestkit;
  offers: (TriageDetailPrimaryWriteV1 | null)[];
  dispatched: { localId: string; input: unknown }[];
}>> {
  const input = { ...dependabotInput(), panel: 'overview' as const };
  const offers: (TriageDetailPrimaryWriteV1 | null)[] = [];
  const dispatched: { localId: string; input: unknown }[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-offer', mountNonce: 'alert-offer' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [panel, select] = React.useState(withoutOpener ? 'actions' : 'overview');
        return (
        <TriageDetailInstance>
          <TriageDetailPanelNavigationProvider navigation={{ panels: withoutOpener ? [] : ['overview', 'actions'], select }}>
          <TriageEvidenceDisclosureProvider disclosure={{
            available: false, disclose: async () => ({ kind: 'inert' }),
            primaryWrite: { value: null, offer: (write) => { offers.push(write); } },
          }}>
            <GithubSecurityAlertBody input={{ ...input, panel }} detailActivity={{ active: true, activeSignal: signal }}
              renderers={{ renderMarkdown: () => null, renderOutcome: () => null }} />
          </TriageEvidenceDisclosureProvider>
          </TriageDetailPanelNavigationProvider>
        </TriageDetailInstance>
        );
      }),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input: actionInput }) => {
          const localId = (action as { localId: string }).localId;
          if (localId === ids.read) {
            const answer = dependabotAnswer(input, 'open') as { detail: Record<string, unknown> };
            return { ...answer, detail: { ...answer.detail, nativeState,
              ...(nativeState === 'dismissed' ? { dismissedReason: 'tolerable_risk' } : {}) } } as JsonValue;
          }
          dispatched.push({ localId, input: actionInput });
          throw new Error('not scripted');
        },
      },
    });
  });
  mounted.push(fixture);
  for (let turn = 0; turn < 6; turn += 1) await act(async () => { await Promise.resolve(); });
  return { fixture, offers, dispatched };
}

async function mountHeaderWhileReading() {
  const input = dependabotInput();
  const offers: (TriageDetailPrimaryWriteV1 | null)[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-reading', mountNonce: 'alert-reading-mount' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => (
        <TriageDetailInstance instance={input.instance}>
          <TriageDetailPanelNavigationProvider navigation={{ panels: ['overview', 'actions'], select: () => {} }}>
            <TriageEvidenceDisclosureProvider disclosure={{
              available: false, disclose: async () => ({ kind: 'inert' }),
              primaryWrite: { value: null, offer: (write) => { offers.push(write); } },
            }}>
              <GithubSecurityAlertBody input={{ ...input, panel: 'overview' }} detailActivity={{ active: true, activeSignal: signal }}
                renderers={{ renderMarkdown: () => null, renderOutcome: () => null }} />
            </TriageEvidenceDisclosureProvider>
          </TriageDetailPanelNavigationProvider>
        </TriageDetailInstance>
      )),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      // The read never answers: the reading state is what is on screen.
      handlers: { executeAction: () => new Promise<JsonValue>(() => {}) },
    });
  });
  mounted.push(fixture);
  for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); });
  return { fixture, offers };
}

describe('the alert in the entry header (c8-alert)', () => {
  it('keeps Cancel available without a navigation opener and discards the draft without writing', async () => {
    const { fixture, dispatched } = await mountOffering('open', true);
    await act(async () => { await fixture.press(await fixture.getByRole('radio', { name: 'The alert is inaccurate' })); });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });
    expect(dispatched).toEqual([]);
    expect((await fixture.getByRole('button', { name: 'Dismiss alert' })).state?.disabled).toBe(true);
  });

  it('opens the reason form and writes only after submission; Cancel writes nothing', async () => {
    // LAB-DEFECTS-D2D3: selecting a reason is a draft edit, never consent to dismiss on GitHub.
    const { fixture, offers, dispatched } = await mountOffering('open');
    const write = offers.at(-1);
    expect(write?.id).toBe('alertDismiss');
    expect(write?.methods).toBeUndefined();
    await act(async () => { await write?.execute(); });
    const reason = await fixture.getByRole('radio', { name: 'Risk is tolerable for this project' });
    await act(async () => { await fixture.press(reason); });
    expect(dispatched).toEqual([]);
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });
    expect(dispatched).toEqual([]);
    expect(await fixture.queryByRole('radio', { name: 'Risk is tolerable for this project' })).toBeUndefined();
    await act(async () => { await offers.at(-1)?.execute(); });
    expect((await fixture.getByRole('button', { name: 'Dismiss alert' })).state?.disabled).toBe(true);
    await act(async () => { await fixture.press(await fixture.getByRole('radio', { name: 'Risk is tolerable for this project' })); });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Dismiss alert' })); });
    expect(dispatched).toEqual([expect.objectContaining({ localId: ids.dismissDependabot,
      input: expect.objectContaining({ reason: 'tolerable_risk' }) })]);
  });

  it('offers Reopen on a dismissed alert', async () => {
    const { offers, dispatched } = await mountOffering('dismissed');
    const write = offers.at(-1);
    expect(write?.methods).toBeUndefined();
    await act(async () => { await write?.execute().catch(() => {}); });
    expect(dispatched.map((call) => call.localId)).toEqual([ids.reopenDependabot]);
  });
});

describe('the Dependabot alert detail Fix step', () => {
  it('admits a Dependabot entry through the shipped source renderer without invoking PR or issue readers', async () => {
    const fixture = await mountBody('open', null, true);
    expect(document.body.textContent).toContain('lodash');
    expect(document.body.textContent).toContain('package.json');
    await expect(fixture.queryByText('This entry cannot be shown')).resolves.toBeUndefined();
  });

  it('leaves an existing fix pull request to Triage\'s fix step, and keeps only the patch fact in its own step', async () => {
    // Owner ruling 2026-10-31 (c8-alert): the open Dependabot fix PR is drawn ONCE, by Triage's fix-PR step.
    const input = dependabotInput();
    const fixture = await mountBody('open', {
      entryRef: {
        ...input.observation.entryRef,
        kindId: 'pull-request',
        entryId: '42',
      },
      title: 'Bump lodash from 4.17.15 to 4.17.21',
      url: 'https://github.com/owner/repo/pull/42',
      open: async () => ({ kind: 'opened' as const }),
      openExternal: async () => {},
    });
    await expect(fixture.queryByRole('button', { name: 'Open pull request' })).resolves.toBeUndefined();
    await expect(
      fixture.queryByText('Dependabot opened #42 · Bump lodash from 4.17.15 to 4.17.21'),
    ).resolves.toBeUndefined();
    expect(document.body.textContent).toContain('Patched in');
  });

  it('tells the finding in the lab\'s chapters: the package once, the advisory, and no repeated title or fix chapter', async () => {
    await mountBody('open', null);
    const body = document.body.textContent ?? '';
    expect(body).toContain('What’s exposed');
    expect(body).toContain('lodash');
    expect(body).not.toContain('Prototype pollution in lodash');
    expect(body).not.toContain('The fix');
    expect(body.match(/Patched in/gu)?.length).toBe(1);
  });

  it('keeps its Dismiss… place, disabled, and marks the entry reading until the alert is read', async () => {
    const { offers } = await mountHeaderWhileReading();
    const offered = offers.at(-1);
    expect(offered).toMatchObject({ id: 'alertDismiss', title: 'Dismiss…', reading: true });
    expect(document.body.textContent).toContain('Reading this alert');
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

});
