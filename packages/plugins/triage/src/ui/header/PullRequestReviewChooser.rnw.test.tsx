// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { SelectActionInputRequest, SelectActionInputResult } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import {
  Button,
  defineUiSurface,
  usePluginUiFocusTarget,
} from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1, TriageStartPullRequestReviewInputV1Schema } from '../../actions/entrySessionProtocol.js';
import { createTriageStartPullRequestReviewActionHandler } from '../../actions/entrySession.js';
import type { TriagePendingPullRequestReviewV1 } from './useEntrySessionStart.js';
import { TriagePullRequestReviewChooser } from './PullRequestReviewChooser.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PENDING = Object.freeze({
  sessionId: 'session-review',
  instructions: 'Review the exact selected pull request.',
  comparisonSource: {
    kind: 'pullRequest',
    locator: { providerId: 'example-forge', repository: 'example/repository', number: 17, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) },
  },
  review: {
    instance: {
      v: 1,
      instance: {
        source: { pluginId: 'happier.example.source', localId: 'example-forge' },
        sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      },
      binding: {
        purpose: 'triage-source',
        account: {
          service: { pluginId: 'happier.example.source', localId: 'accounts' },
          accountId: 'account-1',
        },
      },
      localInstanceKey: 'example/repository',
      configuration: { v: 1, token: 'routing-token' },
      locator: { v: 1, displayLabel: 'example/repository' },
    },
    entryRef: {
      source: { pluginId: 'happier.example.source', localId: 'example-forge' },
      kindId: 'pull-request',
      collisionScope: 'example/repository',
      entryId: '17',
    },
    lastKnownLocator: { v: 1, webUrl: 'https://example.test/example/repository/pull/17' },
    observed: {
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      nativeRevision: 'revision-1',
      observedAtMs: 1_760_000_800_000,
    },
    workspace: {
      serverId: 'server-a',
      machineId: 'machine-a',
      rootPath: '/workspaces/repository',
    },
    repositoryPath: '/workspaces/repository-review-17',
    pullRequest: { number: 17 },
  },
}) as unknown as TriagePendingPullRequestReviewV1;

const mounted: PluginUiTestkit[] = [];

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function mountChooser(executeAction: (
  action: string,
  input: unknown,
) => Promise<unknown>, selectActionInput: (
  request: SelectActionInputRequest,
) => Promise<SelectActionInputResult> = async () => ({ kind: 'executionRunLaunch', input: {} })): Promise<Readonly<{
  fixture: PluginUiTestkit;
  focusedLabels: readonly string[];
}>> {
  const focusedLabels: string[] = [];
  const surface = defineUiSurface(function ReviewChooserProbe(): React.ReactElement {
    const invokingAction = usePluginUiFocusTarget();
    const [visible, setVisible] = React.useState(false);
    return (
      <>
        <Button
          title="Run code review"
          focusTarget={invokingAction}
          onPress={() => { setVisible(true); }}
        />
        {visible ? (
          <TriagePullRequestReviewChooser
            pending={PENDING}
            onFinished={() => { setVisible(false); }}
          />
        ) : null}
      </>
    );
  });
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'fixture-instance-191', mountNonce: 'fixture-mount-191' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({
      physicalFocus(target) {
        target.focus();
        const label = document.activeElement?.getAttribute('aria-label');
        if (label !== null && label !== undefined) focusedLabels.push(label);
        return true;
      },
    }),
    handlers: {
      executeAction: async ({ action, input }) => await executeAction(String(action), input),
      selectActionInput: async ({ request }) => await selectActionInput(request),
    },
  });
  mounted.push(fixture);
  await fixture.press(await fixture.getByRole('button', { name: 'Run code review' }));
  await settle();
  return { fixture, focusedLabels };
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted selected-PR review chooser', () => {
  it.each([
    {
      name: 'Saved Secret',
      input: { secretReferenceOverlay: { v: 1, bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } } } },
    },
    {
      name: 'Team credential',
      input: {
        teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
          expectedResourceRevision: 4, agentTargetKey: 'backend:codex', modelId: 'review-model', deliveryMode: 'brokered' },
        teamCredentialSessionBindingConsent: { v: 1, sessionId: 'session-review', teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 4 },
      },
    },
  ])('awaits public host admission before capture and preserves the $name selection through the real PR handler', async ({ input: credentials }) => {
    const events: string[] = [];
    const reviewInputs: unknown[] = [];
    const selections: SelectActionInputRequest[] = [];
    let finishAdmission: (result: SelectActionInputResult) => void = () => { throw new Error('Admission was not requested'); };
    const admission = new Promise<SelectActionInputResult>((resolve) => { finishAdmission = resolve; });
    const handler = createTriageStartPullRequestReviewActionHandler();
    // Host/daemon contribution and Action transports are genuine process boundaries;
    // selection, source routing, canonical admission and the PR handler stay real.
    const context = {
      services: {
        targetedContributions: { observeForSelf: () => ({
          readCurrent: async () => ({ generation: 'generation-1', contributions: [{
            contributor: { pluginId: PENDING.review.entryRef.source.pluginId, contributionId: PENDING.review.entryRef.source.localId, immutableGenerationId: 'generation-1' },
            protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: 1 },
            descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge', kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
            operations: { listInstances: {}, scan: {}, get: {}, verifyReviewWorkspace: {} },
            surfaces: { detail: {} },
          }] }),
          dispose() {},
        }) },
        actions: {
          executeAdmittedTargetedOperation: async () => { events.push('verify'); return { kind: 'verified', pullRequest: { number: 17 } }; },
          execute: async (actionId: string, input: unknown) => {
            events.push(actionId);
            if (actionId === 'scm.diffSummary.capture') return { success: true, comparison: {
              id: 'c'.repeat(64), source: PENDING.comparisonSource,
              repository: { rootPath: PENDING.review.repositoryPath },
              endpoints: { before: 'd'.repeat(40), after: PENDING.review.observed.headSha },
              pullRequest: { baseOid: PENDING.review.observed.baseSha },
              inventory: { state: 'complete', files: [], reasons: [] }, attributionScope: 'unknown', freshness: 'current',
            } };
            reviewInputs.push(input);
            return { results: [{ key: 'codex', ok: true, result: { runId: 'review-run' } }] };
          },
        },
      },
    } as unknown as PluginInvocationContext;
    const { fixture } = await mountChooser(async (action, input) => {
      if (action === 'review.engines.list') return { items: [{ engineId: 'codex', label: 'Codex', capabilities: { structuredNarration: true } }] };
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) return await handler(TriageStartPullRequestReviewInputV1Schema.parse(input), context);
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    }, async (request) => {
      selections.push(request);
      return await admission;
    });
    await fixture.press(await fixture.getByRole('checkbox', { name: 'Codex' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();
    expect(events).toEqual([]);
    expect(selections).toEqual([{
      hostAction: { action: 'review.start', projection: 'executionRunLaunch' },
      sessionId: PENDING.sessionId, serverId: PENDING.review.workspace.serverId,
      draft: { engineIds: ['codex'], instructions: PENDING.instructions },
    }]);
    await act(async () => { finishAdmission({ kind: 'executionRunLaunch', input: credentials }); });
    await settle();
    expect(events).toEqual(['verify', 'scm.diffSummary.capture', 'review.start']);
    expect(reviewInputs).toEqual([expect.objectContaining({
      sessionId: PENDING.sessionId, engineIds: ['codex'], instructions: PENDING.instructions,
      ...credentials, comparisonId: 'c'.repeat(64),
      base: { kind: 'commit', baseCommit: PENDING.review.observed.baseSha },
      scmPullRequestReviewScope: expect.objectContaining({ pullRequest: { number: 17 } }),
    })]);
  });

  it.each(['cancelled', 'unavailable'])('does not invoke the PR handler when host launch admission is %s', async (failure) => {
    const starts: unknown[] = [];
    const { fixture } = await mountChooser(async (action, input) => {
      if (action === 'review.engines.list') return { items: [{ engineId: 'codex', label: 'Codex', capabilities: { structuredNarration: true } }] };
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        starts.push(input);
        return { v: 1, status: 'started', startedEngineIds: ['codex'], failedEngineIds: [] };
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    }, async () => {
      if (failure === 'unavailable') throw new Error('Host admission unavailable');
      return { kind: 'cancelled' };
    });
    await fixture.press(await fixture.getByRole('checkbox', { name: 'Codex' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();
    expect(starts).toEqual([]);
    expect(await fixture.getByRole('button', { name: failure === 'cancelled' ? 'Start review' : 'Try again' })).toBeDefined();
  });

  it('lists exact current engines, requires an explicit choice, starts once, then opens the stable Session', async () => {
    const calls: Array<Readonly<{ action: string; input: unknown }>> = [];
    const { fixture, focusedLabels } = await mountChooser(async (action, input) => {
      calls.push({ action, input });
      if (action === 'review.engines.list') {
        return {
          sessionId: 'session-review',
          items: [
            { engineId: 'codex', label: 'Codex', enabled: true, capabilities: { structuredNarration: true } },
            { engineId: 'claude', label: 'Claude', enabled: true, capabilities: { structuredNarration: true } },
          ],
        };
      }
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        return {
          v: 1,
          status: 'started',
          startedEngineIds: ['codex', 'claude'],
          failedEngineIds: [],
        };
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    });

    expect(focusedLabels.at(-1)).toBe('Codex');
    expect(calls.map((call) => call.action)).toEqual(['review.engines.list']);

    await fixture.press(await fixture.getByRole('checkbox', { name: 'Codex' }));
    await fixture.press(await fixture.getByRole('checkbox', { name: 'Claude' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();

    expect(calls.map((call) => call.action)).toEqual([
      'review.engines.list',
      TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
      'session.open',
    ]);
    expect(calls[1]?.input).toMatchObject({
      v: 1,
      sessionId: 'session-review',
      engineIds: ['codex', 'claude'],
      instructions: PENDING.instructions,
      review: PENDING.review,
      outputs: ['walkthrough'],
      narrator: { engineId: 'codex' },
      comparisonSource: PENDING.comparisonSource,
    });
  });

  it('requires a real narration capability and permits the reader to choose findings only', async () => {
    const requests: unknown[] = [];
    const { fixture } = await mountChooser(async (action, input) => {
      if (action === 'review.engines.list') return { items: [{ engineId: 'cli', label: 'CLI', enabled: true }] };
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        requests.push(input);
        return { v: 1, status: 'started', startedEngineIds: ['cli'], failedEngineIds: [] };
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    });
    await fixture.press(await fixture.getByRole('checkbox', { name: 'CLI' }));
    expect((await fixture.getByRole('button', { name: 'Start review' })).state?.disabled).toBe(true);
    await fixture.press(await fixture.getByRole('switch', { name: 'Also write a walkthrough' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('outputs');
    expect(requests[0]).not.toHaveProperty('narrator');
  });

  it('focuses Retry after a list failure, recovers only that read, and opens the stable Session on Cancel', async () => {
    let reads = 0;
    const calls: string[] = [];
    const { fixture, focusedLabels } = await mountChooser(async (action) => {
      calls.push(action);
      if (action === 'session.open') return null;
      if (action !== 'review.engines.list') throw new Error(`Unexpected action ${action}`);
      reads += 1;
      if (reads === 1) throw new Error('temporarily unavailable');
      return {
        sessionId: 'session-review',
        items: [{ engineId: 'codex', label: 'Codex', enabled: true, capabilities: { structuredNarration: true } }],
      };
    });

    expect(focusedLabels.at(-1)).toBe('Try again');
    await fixture.press(await fixture.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(reads).toBe(2);
    expect(focusedLabels.at(-1)).toBe('Codex');

    await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(calls).toEqual(['review.engines.list', 'review.engines.list', 'session.open']);
    await expect(fixture.queryByRole('checkbox', { name: 'Codex' })).resolves.toBeUndefined();
  });

  /**
   * The canonical fan-out reports each engine independently inside one
   * successful Action, so "the review started" can be true of one engine and
   * false of another. Opening the Session as an unqualified success hid the
   * refused half; repeating the whole selection would start the successful half
   * twice.
   */
  it('keeps a partly started review visible and retries only the engines that did not start', async () => {
    const startRequests: unknown[] = [];
    const calls: string[] = [];
    const { fixture } = await mountChooser(async (action, input) => {
      calls.push(action);
      if (action === 'review.engines.list') {
        return {
          sessionId: 'session-review',
          items: [
            { engineId: 'codex', label: 'Codex', enabled: true, capabilities: { structuredNarration: true } },
            { engineId: 'claude', label: 'Claude', enabled: true, capabilities: { structuredNarration: true } },
          ],
        };
      }
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        startRequests.push(input);
        return startRequests.length === 1
          ? { v: 1, status: 'started', startedEngineIds: ['codex'], failedEngineIds: ['claude'] }
          : { v: 1, status: 'started', startedEngineIds: ['claude'], failedEngineIds: [] };
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    });

    await fixture.press(await fixture.getByRole('checkbox', { name: 'Codex' }));
    await fixture.press(await fixture.getByRole('checkbox', { name: 'Claude' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();

    // The Session is not opened as a clean success while an engine is missing.
    expect(calls).not.toContain('session.open');
    await expect(fixture.getByRole('button', { name: 'Try again' })).resolves.toBeDefined();

    await fixture.press(await fixture.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(startRequests).toHaveLength(2);
    expect(startRequests[0]).toMatchObject({ engineIds: ['codex', 'claude'] });
    // The engine that IS running is never started a second time.
    expect(startRequests[1]).toMatchObject({ engineIds: ['claude'] });
    expect(startRequests[1]).not.toHaveProperty('outputs');
    expect(startRequests[1]).not.toHaveProperty('narrator');
    expect(calls.at(-1)).toBe('session.open');
  });

  it('never repeats an ambiguously settled review write and offers only the safe Session open', async () => {
    const calls: string[] = [];
    const { fixture, focusedLabels } = await mountChooser(async (action) => {
      calls.push(action);
      if (action === 'review.engines.list') {
        return {
          sessionId: 'session-review',
          items: [{ engineId: 'codex', label: 'Codex', enabled: true, capabilities: { structuredNarration: true } }],
        };
      }
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        throw new Error('outcome unknown');
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    });

    await fixture.press(await fixture.getByRole('checkbox', { name: 'Codex' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();
    expect(focusedLabels.at(-1)).toBe('Open session');
    await expect(fixture.queryByRole('button', { name: 'Cancel' })).resolves.toBeUndefined();

    await fixture.press(await fixture.getByRole('button', { name: 'Open session' }));
    await settle();
    expect(calls).toEqual([
      'review.engines.list',
      TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
      'session.open',
    ]);
  });

  it('offers one Session-open control after opening fails', async () => {
    const calls: string[] = [];
    let opens = 0;
    const { fixture } = await mountChooser(async (action) => {
      calls.push(action);
      if (action === 'review.engines.list') {
        return {
          sessionId: 'session-review',
          items: [{ engineId: 'codex', label: 'Codex', enabled: true, capabilities: { structuredNarration: true } }],
        };
      }
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        return { v: 1, status: 'started', startedEngineIds: ['codex'], failedEngineIds: [] };
      }
      if (action === 'session.open') {
        opens += 1;
        if (opens === 1) throw new Error('navigation unavailable');
        return null;
      }
      throw new Error(`Unexpected action ${action}`);
    });

    await fixture.press(await fixture.getByRole('checkbox', { name: 'Codex' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start review' }));
    await settle();

    await expect(fixture.getByRole('button', { name: 'Open session' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Cancel' })).resolves.toBeUndefined();

    await fixture.press(await fixture.getByRole('button', { name: 'Open session' }));
    await settle();
    expect(calls).toEqual([
      'review.engines.list',
      TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
      'session.open',
      'session.open',
    ]);
  });
});
