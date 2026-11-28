// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext, SessionPermissionResponseV1, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import type { ReviewCommentV1 } from '@happier-dev/plugin-sdk/reviews';
import { Button, defineUiSurface, useSessionState } from '@happier-dev/plugin-ui';
import { TriageActivityAgentProvider } from '@happier-dev/triage-sources/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { GithubHappierReviewSummary } from '../../../../scm-github/src/ui/detail/happierReviewSummary.js';
import { TriageAgentStep, TriagePermissionCard } from './storyRail.js';

/**
 * The story rail's live agent half (r0.42): the permission card above the rail
 * and ③ the agent step, both read from the host's canonical Session state and
 * answered through the host's one permission owner.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: SessionStateV1 = {
  sessionId: 'session-a',
  title: 'Codex',
  lifecycle: 'active',
  runtime: 'waiting',
  operational: 'permission_required',
  workStatus: { state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: 'approval', word: 'Permission required' },
  workspace: { worktreeName: 'fix/2476-checks' },
  pendingPermissions: [{
    requestId: 'request-1',
    toolName: 'Bash',
    summary: 'Run the end-to-end suite',
    command: 'pnpm test:e2e --project=webkit',
    answers: ['allowOnce', 'allowForSession', 'deny'],
  }],
} as SessionStateV1;

const answers: unknown[] = [];
const opened: unknown[] = [];
let proposals: readonly ReviewCommentV1[] = [];

function finding(id: string, sessionId: string): ReviewCommentV1 {
  return {
    v: 1, id, accountId: 'account-a', projectId: 'project-a', sessionId,
    anchor: { kind: 'file', filePath: 'src/a.ts' },
    snapshot: { kind: 'text', selectedLines: ['value'], beforeContext: [], afterContext: [],
      selectedLinesHash: 'selected', contextWindowHash: 'context', capturedAt: 1, fileLength: 1,
      source: 'committed', isUncommitted: false, isUntracked: false, truncated: false,
      hasBidiControls: false, likelyMinified: false },
    body: `Finding ${id}`, bodyVersion: 1, edits: [],
    author: { kind: 'plugin', pluginId: 'happier.triage', engineRunId: 'run-a' },
    state: 'proposed', flags: {}, dispositions: {}, threadId: id, transitions: [],
    linkedRefs: [{ kind: 'pullRequest', url: 'https://example.test/pull/1' }],
    createdAt: 1, updatedAt: 1, serverRevision: 1,
  };
}

it('reads the Overview findings once for its admitted Review instead of once per linked Session', async () => {
  const reads: unknown[] = [];
  const render = defineUiSurface(() => <TriageAgentStep
    sessions={[{ sessionId: 'session-a' }, { sessionId: 'session-b' }, { sessionId: 'session-c' }]}
    hasMore={false} live={{ status: 'ready', state: SESSION }}
    reviewId="review-overview"
    reviewEntry={{ kind: 'pullRequest', url: 'https://example.test/pull/1' }}
  />);
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'overview-cost', mountNonce: 'overview-cost' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: render,
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input }) => {
        if (action === 'reviews.comments.list') reads.push(input);
        return { items: [], cursor: null };
      } },
    });
  });
  mounted.push(fixture);
  expect(reads).toHaveLength(1);
  expect(reads[0]).toEqual(expect.objectContaining({ reviewId: 'review-overview' }));
  expect(reads[0]).not.toHaveProperty('sessionId');
});

it('reads a selected PR Review once when the Overview has no linked Sessions, and once on Refresh', async () => {
  const reviewId = '1cc48915-fe5f-45b8-b630-d62bf77754ea';
  const scopedReads: unknown[] = [];
  const render = defineUiSurface(function Overview() {
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);
    return (
      <TriageActivityAgentProvider value={{ events: [], tail: null, refreshGeneration }}>
        <Button title="Refresh" onPress={() => setRefreshGeneration(previous => previous + 1)} />
        <GithubHappierReviewSummary reviewId={reviewId} />
        <TriageAgentStep sessions={[]} hasMore={false} live={{ status: 'ready', state: null }}
          reviewId={reviewId} reviewEntry={{ kind: 'pullRequest', url: 'https://example.test/pull/5' }} />
      </TriageActivityAgentProvider>
    );
  });
  const digest = `sha256:${'1'.repeat(64)}`;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'selected-overview', mountNonce: 'selected-overview' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: render,
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => {
          if (action === 'reviews.comments.list') scopedReads.push(input);
          return { items: [], cursor: null };
        },
        readResource: async ({ resource }) => {
          if (typeof resource === 'string' || !('hostRead' in resource)) throw new Error('Expected an admitted Review Resource');
          if (resource.hostRead === 'reviews.comments.list') scopedReads.push(resource.input);
          const value = resource.hostRead === 'review.get' ? {
            review: { reviewId, state: 'completed', counts: { total: 0, needsDecision: 0 } },
            human: { needsYou: { needsYou: false, requestedVerdict: false, pendingDecisions: false } },
          } : { status: 'loaded', cursor: null, pending: {}, comments: [], unavailableFindings: [], rows: [] };
          return { contentType: 'application/json', digest, bytes: new TextEncoder().encode(JSON.stringify(value)) };
        },
        watchResource: async () => ({ digest }),
      },
    });
  });
  mounted.push(fixture);
  await fixture.findByRole('button', { name: 'Open review' });
  expect(scopedReads).toEqual([{ reviewId }]);

  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
  expect(scopedReads).toEqual([{ reviewId }]);

  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
  expect(scopedReads).toEqual([{ reviewId }, { reviewId }]);
});

const renderRail = defineUiSurface(function Rail(_context: RenderContext): React.ReactElement {
  const live = useSessionState('session-a');
  return (
    <>
      {live.state?.pendingPermissions.map((request) => (
        <TriagePermissionCard key={request.requestId} sessionId="session-a" state={live.state!} request={request} />
      ))}
      <TriageAgentStep
        sessions={[{ sessionId: 'session-a', displayTitle: 'Codex' }]}
        hasMore={false}
        live={live}
        reviewEntry={{ kind: 'pullRequest', url: 'https://example.test/pull/1' }}
      />
    </>
  );
});

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mountRail(
  nextProposals: readonly ReviewCommentV1[] = [],
  session: SessionStateV1 = SESSION,
  respond: () => SessionPermissionResponseV1 | Promise<SessionPermissionResponseV1> = () => ({ status: 'answered' }),
): Promise<PluginUiTestkit> {
  answers.length = 0;
  opened.length = 0;
  proposals = nextProposals;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-story-rail', mountNonce: 'fixture-mount-story-rail' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: renderRail,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readSession: () => session,
        watchSession: () => undefined,
        respondToSessionPermission: (input) => {
          answers.push(input.request);
          return respond();
        },
        executeAction: async ({ action, input }) => {
          if (action === 'session.open') { opened.push(input); return {}; }
          return { items: proposals, cursor: null };
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

const entryPresses: string[] = [];
const renderEmptyRail = defineUiSurface(function EmptyRail(_context: RenderContext): React.ReactElement {
  const live = useSessionState('session-a');
  return (
    <TriageAgentStep
      sessions={[]}
      hasMore={false}
      live={live}
      reviewEntry={{ kind: 'pullRequest', url: 'https://example.test/pull/1' }}
      number={4}
      entry={{ start: () => { entryPresses.push('start'); }, sendControl: {
        prepare: () => ({ input: { v: 1 } }),
        onSettled: () => undefined,
      } }}
    />
  );
});

describe('the story rail\'s agent chapter before any Session', () => {
  it('offers the entry\'s own Start and Send to a Session where the agent\'s work will appear', async () => {
    entryPresses.length = 0;
    const controls = createPluginUiActionControlTestHost(async () => {
      entryPresses.push('send');
      return { ok: true, result: null };
    });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-empty-rail', mountNonce: 'fixture-mount-empty-rail' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: renderEmptyRail,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { readSession: () => SESSION, watchSession: () => undefined, actionControl: controls.handler,
          executeAction: async () => ({ items: [], cursor: null }) },
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByRole('heading', { name: 'The agent\u2019s work' })).resolves.toBeDefined();
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Start a Session' })); });
    expect(controls.presentation('Send to a Session…')).toBeDefined();
    await act(async () => { await controls.press('Send to a Session…'); });
    expect(entryPresses).toEqual(['start', 'send']);
  });
});

const renderReadingRail = defineUiSurface(function ReadingRail(_context: RenderContext): React.ReactElement {
  // The detail's live reads of its linked Sessions have not answered yet.
  return (
    <TriageAgentStep
      sessions={[{ sessionId: 'session-a', displayTitle: 'Codex' }, { sessionId: 'session-b', displayTitle: 'Earlier run' }]}
      hasMore={false}
      live={{ status: 'loading', state: null }}
      sessionStates={new Map([['session-a', { status: 'loading', state: null }], ['session-b', { status: 'loading', state: null }]])}
      reviewEntry={{ kind: 'pullRequest', url: 'https://example.test/pull/1' }}
    />
  );
});

describe('the story rail\'s agent chapter while its Sessions are being read', () => {
  it('holds the place with the story\'s reading lines and offers nothing to press until the reads settle (UI4 D18)', async () => {
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-reading-rail', mountNonce: 'fixture-mount-reading-rail' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: renderReadingRail,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { readSession: () => new Promise<never>(() => {}), watchSession: () => undefined,
          executeAction: async () => ({ items: [], cursor: null }) },
      });
    });
    mounted.push(fixture);
    expect(document.querySelector('[data-testid="triage-story-agent"] [data-testid="triage-story-loading"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="triage-story-agent"] button, [data-testid="triage-story-agent"] [role="button"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Loading\u2026');
  });
});

describe('the story rail\'s live agent', () => {
  it('names the step after whose work it is, and the card after the current public Session title', async () => {
    const rail = await mountRail([], {
      ...SESSION,
      title: 'Current investigation',
      agent: { agentId: 'codex', displayName: 'Codex', brand: { pluginId: 'happier.agent.codex' } },
    });
    await expect(rail.getByRole('heading', { name: 'Codex\u2019s work' })).resolves.toBeDefined();
    await expect(rail.getByRole('button', { name: 'Open Current investigation' })).resolves.toBeDefined();
  });
  it('names the Agent that needs permission, independent of the linked Session title', async () => {
    const rail = await mountRail([], {
      ...SESSION,
      agent: { agentId: 'codex', displayName: 'Codex', brand: { pluginId: 'happier.agent.codex' } },
    });
    await rail.findByRole('button', { name: 'Allow once' });
    await expect(rail.getByText('Codex needs you')).resolves.toBeDefined();
  });

  it('keeps the generic permission sentence when Agent identity is absent', async () => {
    const rail = await mountRail();
    await rail.findByRole('button', { name: 'Allow once' });
    await expect(rail.getByText('Needs your permission')).resolves.toBeDefined();
    await expect(rail.queryByText('Codex needs you')).resolves.toBeUndefined();
  });

  it('uses the linked Session destination when scoped review rows omit their optional Session id', async () => {
    const { sessionId: _sessionId, ...scopedFinding } = finding('4', 'session-a');
    const rail = await mountRail([finding('1', 'session-a'), finding('2', 'session-a'),
      finding('3', 'session-a'), scopedFinding]);
    await act(async () => { await rail.press(await rail.findByRole('button', { name: 'See all' })); });
    expect(opened).toEqual([{ sessionId: 'session-a' }]);
  });
  it('says each finding\'s severity and where it is, beside what it says', async () => {
    const located = { ...finding('1', 'session-a'), findingSeverity: 'high' as const,
      anchor: { kind: 'line' as const, filePath: 'src/cart/totals.ts', line: 42 } };
    const rail = await mountRail([located]);
    await rail.findByRole('button', { name: 'Allow once' });
    await expect(rail.getByText('Finding 1')).resolves.toBeDefined();
    await expect(rail.getByText('High')).resolves.toBeDefined();
    await expect(rail.getByText('src/cart/totals.ts:42')).resolves.toBeDefined();
  });
  it('opens the Session that owns findings beyond the three-item preview', async () => {
    const rail = await mountRail([finding('1', 'session-a'), finding('2', 'session-a'),
      finding('3', 'session-a'), finding('4', 'session-a')]);
    const seeAll = await rail.findByRole('button', { name: 'See all' });
    await expect(rail.queryByText('Finding 4')).resolves.toBeUndefined();
    await act(async () => { await rail.press(seeAll); });
    expect(opened).toEqual([{ sessionId: 'session-a' }]);
  });
  it('says who is asking and where, from the live Agent, never from the linked Session\'s title', async () => {
    const rail = await mountRail([], {
      ...SESSION,
      title: 'Fix failing checks on #2476',
      agent: { agentId: 'codex', displayName: 'Codex', brand: { pluginId: 'happier.agent.codex' } },
    });
    await rail.findByRole('button', { name: 'Allow once' });
    await expect(rail.getByText('Codex wants to run Bash')).resolves.toBeDefined();
    await expect(rail.queryByText('Fix failing checks on #2476 wants to run Bash')).resolves.toBeUndefined();
    expect(document.querySelector('[data-testid="triage-permission-card"]')?.textContent).toContain('fix/2476-checks');
  });

  it('shows a waiting permission above the rail and answers it through the host owner', async () => {
    const rail = await mountRail([], {
      ...SESSION,
      agent: { agentId: 'codex', displayName: 'Codex' },
    });

    const allowOnce = await rail.findByRole('button', { name: 'Allow once' });
    await expect(rail.getByText('Codex wants to run Bash')).resolves.toBeDefined();
    await expect(rail.getByText('pnpm test:e2e --project=webkit')).resolves.toBeDefined();
    await act(async () => {
      await rail.press(allowOnce);
    });

    expect(answers).toEqual([
      expect.objectContaining({ sessionId: 'session-a', requestId: 'request-1', answer: 'allowOnce' }),
    ]);
  });

  it('states the agent\'s live status and where it works in ③', async () => {
    const rail = await mountRail();

    await rail.findByRole('button', { name: 'Allow once' });
    await expect(rail.getByText('Needs your permission')).resolves.toBeDefined();
    // Where it works is said in ③ (and again beside the asking Agent on the permission card).
    expect(document.querySelector('[data-testid="triage-story-agent"]')?.textContent).toContain('fix/2476-checks');
    // ③ is named after the linked Session doing the work, not a generic "Agent work".
    expect(document.querySelector('[data-testid="triage-story-agent"]')?.textContent).toContain('Codex');
    await expect(rail.queryByText('Agent work')).resolves.toBeUndefined();
  });

  it('keeps a refused answer visible and offers the same host-owned request for retry', async () => {
    const rail = await mountRail([], SESSION, () => { throw new Error('Session disconnected'); });
    await act(async () => { await rail.press(await rail.findByRole('button', { name: 'Allow once' })); });
    await expect(rail.getByText('That answer did not reach the Session. It may already have been answered.')).resolves.toBeDefined();
    await act(async () => { await rail.press(await rail.findByRole('button', { name: 'Deny' })); });
    expect(answers).toEqual([
      expect.objectContaining({ sessionId: 'session-a', requestId: 'request-1', answer: 'allowOnce' }),
      expect.objectContaining({ sessionId: 'session-a', requestId: 'request-1', answer: 'deny' }),
    ]);
  });

  it('explains missing approval authority without inventing answer controls', async () => {
    const rail = await mountRail([], {
      ...SESSION,
      pendingPermissions: SESSION.pendingPermissions.map((request) => ({ ...request, answers: [] })),
    });
    await expect(rail.getByText('Someone who can approve this Session has to answer.')).resolves.toBeDefined();
    await expect(rail.queryByRole('button', { name: 'Allow once' })).resolves.toBeUndefined();
    await expect(rail.queryByRole('button', { name: 'Deny' })).resolves.toBeUndefined();
    expect(answers).toEqual([]);
  });
});
