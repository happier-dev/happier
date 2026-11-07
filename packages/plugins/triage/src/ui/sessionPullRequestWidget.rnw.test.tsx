// @vitest-environment jsdom
import { act } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { SessionPullRequestStatusResourceResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSurface } from './sessionPullRequestWidget.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createSessionPullRequestOperationGlanceBinding } from '../sessions/testkit/sessionPullRequestOperations.test-support.js';

const SESSION_ID = 'session-pr-glance';
const COMPOSER_REGION_ID = 'session-pull-request-status';
const url = 'https://github.com/acme/widgets/pull/42';
const snapshot = {
  kind: 'ready',
  sessionId: SESSION_ID,
  pullRequests: [
    {
      bindingId: 'binding-1',
      revision: 7,
      link: { provider: 'github', repository: 'acme/widgets', number: 42, url },
      watch: {
        policy: {
          mode: 'notify',
          archiveAfterMerge: false,
        },
        reason: null,
        fixAttemptLimit: 3,
        roundsStarted: 0,
        watchingMachine: null,
      },
      latestUpdate: null,
      nativeStatus: {
        kind: 'current',
        checkedAtMs: 200,
        value: {
          kind: 'status',
          observedAtMs: 100,
          checks: null,
          review: null,
          merge: null,
          branch: null,
          facts: [],
        },
      },
    },
  ],
};
const mounted: PluginUiTestkit[] = [];
/** A mode row is named by its label and what it does ("Address · The agent fixes; …"). */
async function modeRow(fixture: PluginUiTestkit, label: string) {
  await fixture.findByRole('menu', { name: 'Watch mode: Notify' });
  const row = (await fixture.getAllByRole('menuitemradio')).find((candidate) => candidate.name?.startsWith(`${label} · `));
  if (!row) throw new Error(`No ${label} mode row`);
  return row;
}
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mountGlance(
  onAction: (call: { action: unknown; input: unknown }) => unknown,
  options: Readonly<{ resource?: unknown; handlers?: Record<string, unknown>;
    launchInput?: JsonValue;
    render?: typeof renderSurface;
    onLatestSignal?(signal: AbortSignal | undefined): void }> = {},
) {
  // Observe only the public author→host boundary, then delegate to the real
  // mounted client/transport. Internal navigation and presentation stay real.
  const surface: typeof renderSurface = context => (options.render ?? renderSurface)({ ...context, hostApi: { ...context.hostApi,
    revealSessionInput: (request, requestOptions) => {
      options.onLatestSignal?.(requestOptions?.signal);
      return context.hostApi.revealSessionInput(request, requestOptions);
    },
    openExternalLink: (url, requestOptions) => {
      options.onLatestSignal?.(requestOptions?.signal);
      return context.hostApi.openExternalLink(url, requestOptions);
    },
    openResource: (resource, requestOptions) => {
      options.onLatestSignal?.(requestOptions?.signal);
      return context.hostApi.openResource(resource, requestOptions);
    },
  } });
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'pr-glance', mountNonce: 'pr-glance-nonce' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface,
    ...(options.launchInput === undefined ? {} : { launchInput: options.launchInput }),
    surfaceContext: createSurfaceContextFixture({
      target: { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' },
      accountScope: { serverId: 'home-1', accountId: 'viewer-1' },
    }),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    handlers: {
      readResource: async () => ({
        contentType: 'application/json',
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify(options.resource ?? snapshot)),
      }),
      watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
      executeAction: ({ action, input }) => onAction({ action, input }),
      ...options.handlers,
    },
  });
  mounted.push(fixture);
  await act(async () => {
    await Promise.resolve();
  });
  return fixture;
}

describe('Companion PR glance controls', () => {
  it.each(['stale', 'unavailable'] as const)('exposes the typed native %s failure for the exact linked PR', async kind => {
    const nativeStatus = kind === 'stale'
      ? { kind, value: snapshot.pullRequests[0]!.nativeStatus.value, checkedAtMs: 200,
          failure: { class: 'transient', code: 'plugin_action_generation_retired' } }
      : { kind, failure: { class: 'transient', code: 'plugin_action_generation_retired' } };
    const fixture = await mountGlance(() => { throw new Error('Reading the diagnostic has no Actions'); }, {
      resource: { ...snapshot, pullRequests: [{ ...snapshot.pullRequests[0]!, nativeStatus }] },
    });
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Details' })); });
    await expect(fixture.getByText('plugin_action_generation_retired')).resolves.toBeDefined();
  });

  it('keeps the typed resource refusal available in Details and respects a nonretryable refusal', async () => {
    const fixture = await mountGlance(() => { throw new Error('A refused read has no Actions'); }, {
      handlers: {
        readResource: () => { throw new PluginError({ code: 'sessionLinksSourceInstanceRequired',
          message: 'Choose the source instance.', retryable: false }); },
      },
    });
    await expect(fixture.getByText('Couldn’t read this session’s pull request')).resolves.toBeDefined();
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Details' })); });
    await expect(fixture.getByText('sessionLinksSourceInstanceRequired')).resolves.toBeDefined();
    expect((await fixture.getAllByRole('button')).some(button => button.name === 'Try again')).toBe(false);
  });

  it('keeps the composer empty while a PR link is loading or its read fails and retires its demand', async () => {
    let rejectRead!: (reason: Error) => void;
    let reads = 0;
    const signals: AbortSignal[] = [];
    const fixture = await mountGlance(() => { throw new Error('Closed status has no Actions'); }, {
      launchInput: { v: 1, role: 'region', composer: { kind: 'session', sessionId: SESSION_ID }, regionLocalId: COMPOSER_REGION_ID },
      handlers: {
        readResource: () => {
          reads += 1;
          return new Promise((_resolve, reject) => { rejectRead = reject; });
        },
        watchResource: ({ signal }: { signal: AbortSignal }) => { signals.push(signal); return { digest: `sha256:${'a'.repeat(64)}` }; },
      },
    });
    expect(document.querySelector('[data-testid^="pr-composer."]')).toBeNull();
    await act(async () => { rejectRead(new Error('Source unavailable')); await Promise.resolve(); });
    expect(document.querySelector('[data-testid^="pr-composer."]')).toBeNull();
    await fixture.retire();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(reads).toBe(1);
  });

  it.each([
    { kind: 'ready', sessionId: SESSION_ID, pullRequests: [] },
    { kind: 'unavailable', sessionId: SESSION_ID, failure: { class: 'transient', code: 'native_network_error' } },
    { ...snapshot, sessionId: 'other-session' },
  ])('keeps the composer empty without a confirmed link for this Session: $kind', async resource => {
    await mountGlance(() => { throw new Error('An unconfirmed link has no Actions'); }, {
      resource: SessionPullRequestStatusResourceResultV1Schema.parse(resource),
      launchInput: { v: 1, role: 'region', composer: { kind: 'session', sessionId: SESSION_ID }, regionLocalId: COMPOSER_REGION_ID },
    });
    expect(document.querySelector('[data-testid^="pr-composer."]')).toBeNull();
  });

  it('shows each exact linked PR, unavailable native facts and stale freshness without Ready', async () => {
    const value = { ...snapshot.pullRequests[0]!.nativeStatus.value,
      checks: { state: 'complete', passed: 1, failed: 0, pending: 0, total: 1, incomplete: false,
        rows: [{ id: 'check:1', name: 'Tests', state: 'passed' }] },
      review: { decision: 'approved', incomplete: false, reviewers: [] },
      merge: { state: 'mergeable', blocker: null },
    };
    const failure = { class: 'transient', code: 'native_network_error' };
    const resource = { ...snapshot, pullRequests: [
      { ...snapshot.pullRequests[0]!, nativeStatus: { kind: 'stale', value, checkedAtMs: 200, failure } },
      { ...snapshot.pullRequests[0]!, bindingId: 'binding-2', link: { ...snapshot.pullRequests[0]!.link,
        number: 43, url: 'https://github.com/acme/widgets/pull/43' },
        nativeStatus: { kind: 'unavailable', failure },
      },
    ] };
    await mountGlance(() => { throw new Error('Closed status has no Actions'); }, { resource,
      launchInput: { v: 1, role: 'region', composer: { kind: 'session', sessionId: SESSION_ID }, regionLocalId: COMPOSER_REGION_ID },
    });
    const first = document.querySelector('[data-testid="pr-composer.binding-1"]')?.textContent;
    const second = document.querySelector('[data-testid="pr-composer.binding-2"]')?.textContent;
    expect(first).toContain('PR #42');
    expect(first).toContain('Stale');
    expect(first).not.toContain('Ready');
    expect(second).toContain('PR #43');
    expect(second).toContain('unavailable');
    expect(await mounted.at(-1)!.queryByRole('button', { name: 'Merge' })).toBeUndefined();
  });

  it('renders source Ready with the existing partial marker in the shared PR facts', async () => {
    const binding = createSessionPullRequestOperationGlanceBinding('merge');
    if (binding.nativeStatus.kind !== 'current' || !binding.nativeStatus.value.operations) throw new Error('Expected current operations');
    const resource = { ...snapshot, pullRequests: [{ ...binding, nativeStatus: { ...binding.nativeStatus,
      value: { ...binding.nativeStatus.value, projectionTruncated: true,
        operations: { ...binding.nativeStatus.value.operations, readiness: 'ready' } } } }] };
    await mountGlance(() => { throw new Error('Presentation does not execute Actions'); }, { resource });
    expect(document.querySelector('[data-testid="pr-glance.merge"]')?.textContent).toContain('Ready');
    expect(document.querySelector('[data-testid="pr-glance.merge"]')?.textContent).toContain('Some status details could not be read.');
  });

  it('refuses a mismatched composer Session without reading another Session’s Resource', async () => {
    let reads = 0;
    await mountGlance(() => { throw new Error('Refused mount has no Actions'); }, {
      launchInput: { v: 1, role: 'region', composer: { kind: 'session', sessionId: 'other-session' }, regionLocalId: COMPOSER_REGION_ID },
      handlers: { readResource: () => { reads += 1; throw new Error('Wrong Session must not be read'); } },
    });
    expect(document.querySelector('[data-testid^="pr-composer."]')).toBeNull();
    expect(reads).toBe(0);
  });

  it('mounts the declared Session PR status region through its shipped artifact and joined Resource', async () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error(`The actual plugin manifest must be admitted: ${JSON.stringify(parsed)}`);
    const region = parsed.manifest.contributes?.composerRegions?.find(item => item.id === COMPOSER_REGION_ID);
    expect(region).toMatchObject({ placement: 'statusStrip', emphasis: 'prominent', scopes: ['session'] });
    if (!region) throw new Error('The required composer PR status region is not declared');
    const renderer = PLUGIN_MANIFEST.contributes.ui.renderers.find(item => item.id === region.renderer.renderer);
    expect(renderer).toMatchObject({ artifact: 'triage-session-pull-request-native', kind: 'reactNative' });
    let reads = 0;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'pr-region', mountNonce: 'pr-region-nonce' },
      authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      surface: renderSurface,
      launchInput: { v: 1, role: 'region', composer: { kind: 'session', sessionId: SESSION_ID }, regionLocalId: region.id },
      surfaceContext: createSurfaceContextFixture({
        target: { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' },
        accountScope: { serverId: 'home-1', accountId: 'viewer-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        readResource: async () => { reads += 1; return {
          contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify(snapshot)),
        }; },
        watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
        executeAction: () => { throw new Error('Closed status does not execute Actions'); },
      },
    });
    mounted.push(fixture);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="pr-composer.binding-1"]')?.textContent).toContain('PR #42');
    expect(document.querySelector('[data-testid="pr-widget"]')).toBeNull();
    expect(reads).toBe(1);
    expect(await fixture.queryByRole('button', { name: 'Watch mode: Notify' })).toBeUndefined();
  });

  it('opens the exact composer PR in the shared glance without another Resource acquisition', async () => {
    let reads = 0;
    const binding = snapshot.pullRequests[0]!;
    const resource = { ...snapshot, pullRequests: [binding, { ...binding, bindingId: 'binding-2',
      link: { ...binding.link, number: 43, url: 'https://github.com/acme/widgets/pull/43' } }] };
    const fixture = await mountGlance(() => { throw new Error('Opening PR details is not a mutation'); }, {
      resource,
      launchInput: { v: 1, role: 'region', composer: { kind: 'session', sessionId: SESSION_ID }, regionLocalId: COMPOSER_REGION_ID },
      handlers: { readResource: async () => { reads += 1; return {
        contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify(resource)),
      }; } },
    });
    expect(document.querySelector('[data-testid="pr-widget"]')).toBeNull();
    const button = (await fixture.getAllByRole('button')).find(item => item.name?.includes('PR #43'));
    if (!button) throw new Error('The exact linked PR must have a composer status control');
    await act(async () => { await fixture.press(button); });
    expect(document.querySelector('[data-testid="pr-widget"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pr-glance"]')?.textContent).toContain('acme/widgets #43');
    expect(reads).toBe(1);
  });

  it('keeps an uncertain native operation visible after a failed explicit re-read and never replays it', async () => {
    const binding = createSessionPullRequestOperationGlanceBinding('dequeue');
    let reads = 0;
    let writes = 0;
    const content = { kind: 'ready', sessionId: SESSION_ID, pullRequests: [binding] };
    const fixture = await mountGlance(() => { writes += 1; return { kind: 'uncertain', outcome: {
      kind: 'uncertain', failure: null, presentation: { title: 'Queue outcome unknown',
        description: 'The source cannot confirm queue membership. Re-read before trying again.', tone: 'warning' },
    } }; }, { handlers: {
      readResource: async () => {
        reads += 1;
        if (reads === 2) throw new Error('Source temporarily unavailable');
        return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify(content)) };
      },
      watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
    } });
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Leave queue' })); });
    await expect(fixture.getByText('Queue outcome unknown')).resolves.toBeDefined();
    expect((await fixture.getByRole('button', { name: 'Leave queue' })).state?.disabled).toBe(true);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Re-read' })); });
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    await expect(fixture.getByText('Queue outcome unknown')).resolves.toBeDefined();
    expect((await fixture.getByRole('button', { name: 'Leave queue' })).state?.disabled).toBe(true);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Re-read' })); });
    expect(reads).toBe(3);
    expect(writes).toBe(1);
    await expect(fixture.queryByText('Queue outcome unknown')).resolves.toBeUndefined();
    expect((await fixture.getByRole('button', { name: 'Leave queue' })).state?.disabled).not.toBe(true);
  });

  it.each(['merge', 'dequeue', 'cancelAutoMerge'] as const)('executes the original source %s offer from the actual Companion with one shared native demand', async operation => {
    const binding = createSessionPullRequestOperationGlanceBinding(operation);
    const calls: { action: unknown; input: unknown }[] = [];
    let reads = 0;
    let watches = 0;
    const content = { kind: 'ready', sessionId: SESSION_ID, pullRequests: [binding] };
    const fixture = await mountGlance(call => { calls.push(call); return { kind: 'applied', outcome: {
      kind: 'applied', effect: 'changed', confirmedState: null, confirmedEntryRef: null,
      presentation: { title: 'Source confirms the change', description: 'The original source confirmed this operation.', tone: 'secondary' },
    } }; }, {
      resource: content,
      handlers: {
        readResource: async () => { reads += 1; return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify(content)) }; },
        watchResource: () => { watches += 1; return { digest: `sha256:${'a'.repeat(64)}` }; },
      },
    });
    expect(reads).toBe(1);
    expect(watches).toBe(1);
    if (operation === 'merge') {
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Merge' })); });
      expect(calls).toEqual([]); // Opening the existing method menu is not consent to a default method.
      await act(async () => { await fixture.press(await fixture.findByRole('menuitem', { name: 'Squash' })); });
    } else {
      await act(async () => { await fixture.press(await fixture.findByRole('button', {
        name: operation === 'dequeue' ? 'Leave queue' : 'Cancel auto-merge',
      })); });
    }
    if (binding.nativeStatus.kind !== 'current' || !binding.nativeStatus.value.operations) throw new Error('Expected source offer');
    const source = binding.nativeStatus.value.operations;
    const offer = operation === 'cancelAutoMerge' ? source.alternatives[0]! : source.primary;
    const variant = offer.variants.find(item => item.id === (operation === 'merge' ? 'squash' : 'direct'));
    expect(calls).toEqual([{ action: offer.actionRef, input: variant?.input }]);
    await expect(fixture.getByText('Source confirms the change')).resolves.toBeDefined();
    expect(reads).toBe(1);
    expect(watches).toBe(1);
  });

  it.each(['provider', 'sessionInput'] as const)('opens the exact latest %s location with the mounted signal and cancels navigation on retirement', async kind => {
    const locations: unknown[] = [];
    const callerSignals: (AbortSignal | undefined)[] = [];
    const boundarySignals: AbortSignal[] = [];
    const navigated: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const complete = async (location: unknown, signal: AbortSignal) => {
      locations.push(location);
      boundarySignals.push(signal);
      await held;
      if (!signal.aborted) navigated.push(location);
    };
    const location = kind === 'provider' ? { kind, url: `${url}#issuecomment-42`, resource: { kind: 'pullRequest' as const, url: `${url}#issuecomment-42` } } : { kind, localId: 'original-input-42' };
    const resource = { ...snapshot, pullRequests: [{ ...snapshot.pullRequests[0]!, latestUpdate: {
      occurrenceId: 'retained-update-42', occurredAtMs: 100, kinds: ['comment'], summary: 'Review feedback', summaryTruncated: false, location,
    } }] };
    const fixture = await mountGlance(() => { throw new Error('Navigation must not invoke an Action'); }, {
      resource, onLatestSignal: signal => callerSignals.push(signal), handlers: {
        revealSessionInput: ({ request, signal }: { request: unknown; signal: AbortSignal }) => complete(request, signal),
        openExternalLink: ({ url: targetUrl, signal }: { url: string; signal: AbortSignal }) => complete(targetUrl, signal),
        openResource: ({ resource, signal }: { resource: unknown; signal: AbortSignal }) => complete(resource, signal),
      },
    });
    try {
      expect(locations).toEqual([]);
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Open the latest update: Review feedback' })); });
      expect(locations).toEqual([kind === 'provider' ? { kind: 'pullRequest', url: `${url}#issuecomment-42` } : { sessionId: SESSION_ID, localId: 'original-input-42' }]);
      expect(callerSignals).toEqual([fixture.context.signal]);
      const retirement = fixture.retire('Account or mount retired');
      release();
      await retirement;
      expect(boundarySignals[0]?.aborted).toBe(true);
      await act(async () => { await Promise.resolve(); });
      expect(navigated).toEqual([]);
    } finally { release(); }
  });

  it('changes the mode through the Watch Action at the revision it shows, and unlinks through the binding Action', async () => {
    const calls: { action: unknown; input: unknown }[] = [];
    const fixture = await mountGlance((call) => {
      calls.push(call);
      const kind = (call.input as { kind?: string }).kind;
      return kind === 'configure'
        ? { kind: 'updated', bindingId: 'binding-1', revision: 8 }
        : { kind: 'removed' };
    });
    await act(async () => {
      await fixture.press(
        await fixture.findByRole('button', { name: 'Watch mode: Notify' }),
      );
    });
    expect(await fixture.queryByRole('menuitemcheckbox', { name: 'Stop watching when merged' })).toBeUndefined();
    const archive = (await fixture.getAllByRole('menuitemcheckbox')).find(item => item.name?.startsWith('Archive the session too'));
    expect(archive).toBeDefined();
    await act(async () => {
      await fixture.press(await modeRow(fixture, 'Address'));
    });
    expect(calls).toEqual([
      {
        action: {
          pluginId: 'happier.channels',
          localId: 'session-pull-request-watch-v1',
        },
        input: {
          kind: 'configure',
          sessionId: SESSION_ID,
          bindingId: 'binding-1',
          expectedRevision: 7,
          policy: {
            mode: 'address',
            archiveAfterMerge: false,
          },
        },
      },
    ]);
    await act(async () => {
      await fixture.press(
        await fixture.findByRole('button', { name: 'Watch mode: Notify' }),
      );
    });
    await act(async () => {
      await fixture.press(await fixture.findByRole('menuitem', { name: 'Unlink from this session' }));
    });
    expect(calls[1]).toEqual({
      action: {
        pluginId: 'happier.channels',
        localId: 'session-pull-request-binding-v1',
      },
      input: {
        kind: 'unlink',
        sessionId: SESSION_ID,
        bindingId: 'binding-1',
        expectedRevision: 7,
      },
    });
  });

  it('says when a change did not go through instead of showing it as applied', async () => {
    const fixture = await mountGlance(() => {
      throw new Error('revision changed');
    });
    await act(async () => {
      await fixture.press(
        await fixture.findByRole('button', { name: 'Watch mode: Notify' }),
      );
    });
    await act(async () => {
      await fixture.press(await modeRow(fixture, 'Auto-fix'));
    });
    await expect(
      fixture.getByText(
        'That didn’t go through. The pull request and its watch are unchanged.',
      ),
    ).resolves.toBeDefined();
    await expect(
      fixture.findByRole('button', { name: 'Watch mode: Notify' }),
    ).resolves.toBeDefined();
  });

  it('after the fix limit, continues through retryFix at the shown revision, opens the retained input, and keeps a local run honest', async () => {
    const calls: { action: unknown; input: unknown }[] = [];
    const reveals: unknown[] = [];
    const exhausted = { ...snapshot, pullRequests: [{ ...snapshot.pullRequests[0]!,
      watch: { ...snapshot.pullRequests[0]!.watch, policy: { mode: 'autoFix', archiveAfterMerge: false }, reason: 'exhausted', roundsStarted: 3 },
      latestUpdate: { occurrenceId: 'o1', occurredAtMs: 100, kinds: ['check'], summary: '1 failed check', summaryTruncated: false,
        location: { kind: 'sessionInput', localId: 'input-7' } } }] };
    const fixture = await mountGlance((call) => { calls.push(call); return { kind: 'updated', bindingId: 'binding-1', revision: 8 }; }, {
      resource: exhausted,
      handlers: {
        revealSessionInput: ({ request }: { request: unknown }) => { reveals.push(request); },
        readSession: () => null,
      },
    });
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Continue 3 more' })); });
    expect(calls).toEqual([{ action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
      input: { kind: 'retryFix', sessionId: SESSION_ID, bindingId: 'binding-1', expectedRevision: 7 } }]);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Open the latest update: 1 failed check' })); });
    expect(reveals).toEqual([{ sessionId: SESSION_ID, localId: 'input-7' }]);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Run the job locally' })); });
    await expect(fixture.getByText('A local run needs this session’s checkout of the same repository.')).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });
  describe('configured source unavailable', () => {
    const github = { destination: { pluginId: 'happier.scm.forge.github', localId: 'triage-sources' }, displayName: 'GitHub', kindNames: ['Pull requests'] };
    const gitlab = { destination: { pluginId: 'happier.scm.forge.gitlab', localId: 'triage-sources' }, displayName: 'GitLab', kindNames: ['Merge requests'] };
    const unavailable = (offers?: readonly unknown[], code = 'configuredSourceUnavailable') => ({ ...snapshot, pullRequests: [{ ...snapshot.pullRequests[0]!,
      nativeStatus: { kind: 'unavailable', failure: { class: 'unsupportedContract', code },
        ...(offers === undefined ? {} : { recovery: { kind: 'configureSources', offers } }) } }] });

    it('says why and opens the offered source page, leaving the link and every saved selection alone', async () => {
      const opened: unknown[] = [];
      const calls: unknown[] = [];
      const fixture = await mountGlance((call) => { calls.push(call); return null; }, {
        resource: unavailable([github]),
        handlers: { openSurface: ({ view }: { view: unknown }) => { opened.push(view); } },
      });
      await expect(fixture.getByText('This repository isn’t in your GitHub source')).resolves.toBeDefined();
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose repositories' })); });
      expect(opened).toEqual([github.destination]);
      expect(calls).toEqual([]);
    });

    it('never picks between several offered sources for the person', async () => {
      const opened: unknown[] = [];
      const fixture = await mountGlance(() => null, {
        resource: unavailable([github, gitlab]),
        handlers: { openSurface: ({ view }: { view: unknown }) => { opened.push(view); } },
      });
      await fixture.getByText('This repository isn’t in a source you’ve set up');
      expect(opened).toEqual([]);
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose a source' })); });
      await act(async () => { await fixture.press(await fixture.findByRole('menuitem', { name: 'GitLab' })); });
      expect(opened).toEqual([gitlab.destination]);
    });

    it('opens the admitted source choice for an unselected native authority without configuring or relinking', async () => {
      const opened: unknown[] = [];
      const calls: unknown[] = [];
      const fixture = await mountGlance(call => { calls.push(call); return null; }, {
        resource: unavailable([github], 'sessionLinksSourceInstanceRequired'),
        handlers: { openSurface: ({ view }: { view: unknown }) => { opened.push(view); } },
      });
      await fixture.getByText('Pull request status can’t be read');
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose a source' })); });
      expect(opened).toEqual([github.destination]);
      expect(calls).toEqual([]);
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Details' })); });
      await fixture.getByText('sessionLinksSourceInstanceRequired');
    });

    it('says so when the source page could not be opened, and offers nothing without an admitted page', async () => {
      const fixture = await mountGlance(() => null, {
        resource: unavailable([github]),
        handlers: { openSurface: () => { throw new Error('refused'); } },
      });
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose repositories' })); });
      await expect(fixture.getByText('Couldn’t open GitHub settings. Try again.')).resolves.toBeDefined();
      const bare = await mountGlance(() => null, { resource: unavailable() });
      await bare.getByText('Pull request status can’t be read');
      await expect(bare.queryByRole('button', { name: 'Choose repositories' })).resolves.toBeUndefined();
    });
  });
});
