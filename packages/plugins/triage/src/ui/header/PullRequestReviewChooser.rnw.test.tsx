// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { fanoutStarts } from '@happier-dev/protocol/actions/executor/executionRuns';
import { ReviewStartInputSchema } from '@happier-dev/plugin-sdk/reviews';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { SelectActionInputRequest, SelectActionInputResult } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import {
  createPluginUiTestkit,
  createPluginUiActionControlTestHost,
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
import { readTriageActionsForSurface } from '../../actions/actionsCatalog.js';
import { mutateTriageAction, TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../settings/actions.js';
import { createTestkitAccountKv } from '../../settings/testkit/accountKv.test-support.js';
import { testkitTriageActionId, TESTKIT_REVIEW_WORKFLOW_RECEIPT } from '../../sessions/testkit/entrySessionTestkit.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PENDING = Object.freeze({
  actionId: 'fix',
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

function createReviewCatalog() {
  return createTestkitAccountKv({ [TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1]: { v: 1, actions: [{
    actionId: PENDING.actionId, label: 'Review', enabled: true, appliesTo: ['pullRequest'],
    profileId: null, workspaceMode: 'pull_request',
    target: { kind: 'reviewStart', promptInvocationId: null, seededFallbackInstruction: PENDING.instructions },
  }] } });
}

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
) => Promise<SelectActionInputResult> = async () => ({ kind: 'reviewComposition', input: DEFAULT_REVIEW_INPUT }),
catalog = createReviewCatalog(), notifications: string[] = []): Promise<Readonly<{
  fixture: PluginUiTestkit;
  focusedLabels: readonly string[];
  controls: ReturnType<typeof createPluginUiActionControlTestHost>;
}>> {
  const focusedLabels: string[] = [];
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    try { return { ok: true, result: await executeAction(typeof action === 'string' ? action : action.localId, input) as import('@happier-dev/plugin-sdk').JsonValue }; }
    catch (error) {
      return isPluginError(error)
        ? { ok: false, errorCode: error.code, error: error.message,
            ...(error.details === undefined ? {} : { details: error.details }) }
        : { ok: false, errorCode: 'timeout', error: 'outcome unknown' };
    }
  });
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
      actionControl: controls.handler,
      notify: async ({ message }) => { notifications.push(message); },
      executeAction: async ({ action, input }) => testkitTriageActionId(action) === 'actions/read-v1'
        ? await readTriageActionsForSurface({ v: 1 }, { catalog: catalog.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) })
        : await executeAction(String(action), input),
      selectActionInput: async ({ request }) => await selectActionInput(request),
    },
  });
  mounted.push(fixture);
  await fixture.press(await fixture.getByRole('button', { name: 'Run code review' }));
  await settle();
  return { fixture, focusedLabels, controls };
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

const DEFAULT_REVIEW_INPUT = ReviewStartInputSchema.parse({
  reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: PENDING.instructions,
});

describe('the mounted selected-PR review chooser', () => {
  it('uses the shared Review composition for a person without listing or requiring an engine', async () => {
    const calls: Array<{ action: string; input: unknown }> = [];
    const input = ReviewStartInputSchema.parse({ reviewers: [{ kind: 'person',
      principal: { kind: 'account', accountId: 'requested-person' }, required: true }], instructions: PENDING.instructions });
    const { controls } = await mountChooser(async (action, request) => {
      calls.push({ action, input: request });
      if (action === 'review.engines.list') return { items: [] };
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        expect(TriageStartPullRequestReviewInputV1Schema.parse(request)).toMatchObject({ reviewInput: input });
        return { v: 1, status: 'accepted', reviewResult: TESTKIT_REVIEW_WORKFLOW_RECEIPT };
      }
      if (action === 'session.open') return null;
      throw new Error('Unexpected Action');
    }, async () => ({ kind: 'reviewComposition', input }));
    expect(calls).toEqual([]);
    await controls.press('Start review');
    await settle();
    expect(calls.map(call => call.action)).toEqual([TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1, 'session.open']);
    expect(calls[0]?.input).toMatchObject({ sessionId: PENDING.sessionId, review: PENDING.review, reviewInput: input });
  });

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
            return TESTKIT_REVIEW_WORKFLOW_RECEIPT;
          },
        },
      },
    } as unknown as PluginInvocationContext;
    const { controls } = await mountChooser(async (action, input) => {
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) return await handler(TriageStartPullRequestReviewInputV1Schema.parse(input), context);
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    }, async (request) => {
      selections.push(request);
      return await admission;
    });
    const press = controls.press('Start review');
    await settle();
    expect(events).toEqual([]);
    expect(selections).toEqual([{
      hostAction: { action: 'review.start', projection: 'composition' },
      sessionId: PENDING.sessionId, serverId: PENDING.review.workspace.serverId,
      draft: { instructions: PENDING.instructions },
    }]);
    await act(async () => { finishAdmission({ kind: 'reviewComposition', input: ReviewStartInputSchema.parse({
      ...DEFAULT_REVIEW_INPUT, ...credentials, outputs: ['walkthrough'], narrator: { engineId: 'codex' },
    }) }); await press; });
    await settle();
    expect(events).toEqual(['verify', 'scm.diffSummary.capture', 'review.start']);
    expect(reviewInputs).toEqual([expect.objectContaining({
      sessionId: PENDING.sessionId, reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: PENDING.instructions,
      ...credentials, comparisonId: 'c'.repeat(64),
      base: { kind: 'commit', baseCommit: PENDING.review.observed.baseSha },
      scmPullRequestReviewScope: expect.objectContaining({ pullRequest: { number: 17 } }),
    })]);
  });

  it.each(['cancelled', 'unavailable'])('does not invoke the PR handler when shared composition is %s', async (failure) => {
    const starts: unknown[] = [];
    const { controls } = await mountChooser(async (action, input) => {
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
    await controls.press('Start review');
    await settle();
    expect(starts).toEqual([]);
    expect(controls.presentation(failure === 'cancelled' ? 'Start review' : 'Try again')).toBeDefined();
  });

  it.each(['native', 'workflow', 'workflowWithWarning'])('starts the selected composition once and opens the stable Session (%s)', async admission => {
    const calls: Array<Readonly<{ action: string; input: unknown }>> = [];
    const notifications: string[] = [];
    const { controls } = await mountChooser(async (action, input) => {
      calls.push({ action, input });
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        if (admission !== 'native') return { v: 1, status: 'accepted',
          reviewResult: TESTKIT_REVIEW_WORKFLOW_RECEIPT, review: TESTKIT_REVIEW_WORKFLOW_RECEIPT.reviewRound,
          ...(admission === 'workflowWithWarning' ? { failure: { codes: ['unavailable'], requestId: 'relation-write-17' } } : {}) };
        return {
          v: 1,
          status: 'started',
          startedEngineIds: ['codex', 'claude'],
          failedEngineIds: [],
        };
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    }, undefined, undefined, notifications);

    expect(calls).toEqual([]);
    await controls.press('Start review');
    await settle();

    expect(calls.map((call) => call.action)).toEqual([
      TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
      'session.open',
    ]);
    expect(calls[0]?.input).toMatchObject({
      v: 1, sessionId: PENDING.sessionId, review: PENDING.review, reviewInput: DEFAULT_REVIEW_INPUT,
      comparisonSource: PENDING.comparisonSource,
    });
    if (admission === 'workflowWithWarning') {
      expect(notifications.join(' ')).toContain('relation-write-17');
    }
  });

  it('opens the already-linked Session when the optional review is cancelled', async () => {
    const calls: string[] = [];
    const { fixture } = await mountChooser(async action => {
      calls.push(action);
      if (action === 'session.open') return null;
      throw new Error('Review must not start on Cancel');
    });
    await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(calls).toEqual(['session.open']);
  });

  it.each([false, true])('retries an explicitly refused review through current configured admission (disabled=%s)', async disabled => {
    const starts: unknown[] = [];
    const calls: string[] = [];
    const selections: SelectActionInputRequest[] = [];
    const reviewers = [{ kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'requested-person' }, required: true }];
    const composition = ReviewStartInputSchema.parse({ reviewers,
      steps: [{ kind: 'review', reviewers, instructions: 'Keep this authored step' }],
      instructions: 'Keep this person and these options', then: 'report' });
    const catalog = createReviewCatalog();
    const { controls } = await mountChooser(async (action, input) => {
      calls.push(action);
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        starts.push(input);
        return starts.length === 1 ? { v: 1, status: 'refused', reason: 'reviewRejected' }
          : { v: 1, status: 'accepted', reviewResult: TESTKIT_REVIEW_WORKFLOW_RECEIPT };
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    }, async request => {
      selections.push(request);
      return { kind: 'reviewComposition', input: composition };
    }, catalog);
    await controls.press('Start review');
    await settle();
    expect(calls).not.toContain('session.open');
    expect(controls.presentation('Try again')).toBeDefined();
    if (disabled) {
      expect(await mutateTriageAction({ catalog: catalog.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' }, {
        kind: 'delete', actionId: PENDING.actionId, expectedRevision: catalog.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
      })).toMatchObject({ status: 'applied' });
    }
    await controls.press('Try again');
    await settle();
    expect(selections).toEqual([
      { hostAction: { action: 'review.start', projection: 'composition' }, sessionId: PENDING.sessionId,
        serverId: PENDING.review.workspace.serverId, draft: { instructions: PENDING.instructions } },
      { hostAction: { action: 'review.start', projection: 'composition' }, sessionId: PENDING.sessionId,
        serverId: PENDING.review.workspace.serverId, draft: composition },
    ]);
    expect(starts).toHaveLength(disabled ? 1 : 2);
    expect(calls.includes('session.open')).toBe(!disabled);
  });

  it.each([false, true])('never repeats a canonical unknown review start and offers only Session open (partial=%s)', async partial => {
    const calls: string[] = [];
    const { fixture, focusedLabels, controls } = await mountChooser(async (action, input) => {
      calls.push(action);
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        const handler = createTriageStartPullRequestReviewActionHandler();
        const context = {
          services: {
            targetedContributions: { observeForSelf: () => ({
              readCurrent: async () => ({ contributions: [{
                contributor: { pluginId: PENDING.review.entryRef.source.pluginId, contributionId: PENDING.review.entryRef.source.localId, immutableGenerationId: 'generation-1' },
                protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: 1 },
                descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge', kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
                operations: { listInstances: {}, scan: {}, get: {}, verifyReviewWorkspace: {} }, surfaces: { detail: {} },
              }] }), dispose() {},
            }) },
            actions: {
              executeAdmittedTargetedOperation: async () => ({ kind: 'verified', pullRequest: { number: 17 } }),
              execute: async () => ({ results: await fanoutStarts({ keys: partial ? ['codex', 'claude'] : ['codex'], startOne: async key =>
                partial && key === 'codex' ? { runId: 'run-a', callId: 'call-a', sidechainId: 'sidechain-a' } : { runId: 'possibly-created' } }) }),
            },
          },
        } as unknown as PluginInvocationContext;
        return await handler(TriageStartPullRequestReviewInputV1Schema.parse(input), context);
      }
      if (action === 'session.open') return null;
      throw new Error(`Unexpected action ${action}`);
    }, async () => ({ kind: 'reviewComposition', input: ReviewStartInputSchema.parse({
      ...DEFAULT_REVIEW_INPUT, reviewers: ['codex', ...(partial ? ['claude'] : [])].map(engineId => ({ kind: 'engine', engineId })),
    }) }));
    await controls.press('Start review');
    await settle();
    expect(focusedLabels.at(-1)).toBe('Open session');
    await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
    await expect(fixture.queryByRole('button', { name: 'Cancel' })).resolves.toBeUndefined();

    await fixture.press(await fixture.getByRole('button', { name: 'Open session' }));
    await settle();
    expect(calls).toEqual([
      TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
      'session.open',
    ]);
  });

  it('preserves a typed review input-selection failure in the existing notification', async () => {
    const notifications: string[] = [];
    const { controls } = await mountChooser(async () => {
      throw new Error('Review must not start after selection fails');
    }, async () => { throw new PluginError({ code: 'review_selection_refused', details: { requestId: 'review-selection-request' } }); }, undefined, notifications);
    await controls.press('Start review');
    await settle();
    expect(notifications.join(' ')).toContain('review_selection_refused');
    expect(notifications.join(' ')).toContain('review-selection-request');
  });

  it('offers one Session-open control after opening fails', async () => {
    const calls: string[] = [];
    const notifications: string[] = [];
    let opens = 0;
    const { fixture, controls } = await mountChooser(async (action) => {
      calls.push(action);
      if (action === TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1) {
        return { v: 1, status: 'started', startedEngineIds: ['codex'], failedEngineIds: [] };
      }
      if (action === 'session.open') {
        opens += 1;
        if (opens === 1) throw new PluginError({ code: 'session_open_refused', details: { requestId: 'review-open-request' } });
        return null;
      }
      throw new Error(`Unexpected action ${action}`);
    }, undefined, undefined, notifications);

    await controls.press('Start review');
    await settle();

    expect(notifications.join(' ')).toContain('session_open_refused');
    expect(notifications.join(' ')).toContain('review-open-request');
    await expect(fixture.getByRole('button', { name: 'Open session' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Cancel' })).resolves.toBeUndefined();

    await fixture.press(await fixture.getByRole('button', { name: 'Open session' }));
    await settle();
    expect(calls).toEqual([
      TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
      'session.open',
      'session.open',
    ]);
  });
});
