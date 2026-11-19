// @vitest-environment jsdom
import { act } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import {
  createPluginUiActionControlTestHost,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSurface } from './scmPullRequestCard.js';
import type { TriageSessionPullRequestBindingV1 } from '../sessions/sessionPullRequestStatus.js';
import { createSessionPullRequestOperationGlanceBinding } from '../sessions/testkit/sessionPullRequestOperations.test-support.js';

const SESSION_ID = 'session-git-card';
const url = 'https://github.com/acme/widgets/pull/42';
const pullRequest = {
  provider: {
    id: 'github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'acme/widgets',
  },
  number: 42,
  url,
  title: 'Keep settings modal state across window resizes',
  baseBranch: 'main',
  headBranch: 'fix-settings',
  state: 'open',
  checks: { state: 'pending' },
};
const bound = {
  kind: 'ready',
  sessionId: SESSION_ID,
  pullRequests: [
    {
      bindingId: 'binding-1',
      revision: 1,
      link: { provider: 'github', repository: 'acme/widgets', number: 42, url },
      watch: {
        policy: { mode: 'off', archiveAfterMerge: false },
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
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function linkFromBranchHint(defaultMode: string, options: Readonly<{
  settingsReply?: JsonValue | Promise<JsonValue>;
  pendingApproval?: ReturnType<typeof createSurfaceContextFixture>['pendingApproval'];
  latestUpdate?: TriageSessionPullRequestBindingV1['latestUpdate'];
}> = {}) {
  let linked = false;
  const calls: { action: unknown; input: unknown }[] = [];
  const navigation: unknown[] = [];
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'git-card', mountNonce: 'git-card-nonce' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: renderSurface,
    launchInput: { homeServerId: 'home-1', pullRequest },
    surfaceContext: createSurfaceContextFixture({
      target: { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' },
      accountScope: { serverId: 'home-1', accountId: 'viewer-1' },
      ...(options.pendingApproval === undefined ? {} : { pendingApproval: options.pendingApproval }),
    }),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    handlers: {
      readSession: () => ({ sessionId: SESSION_ID, serverId: 'home-1', lifecycle: 'active', runtime: 'working', operational: 'working',
        pendingPermissions: [], workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' },
      } satisfies SessionStateV1),
      revealSessionInput: ({ request }) => { navigation.push(request); },
      openExternalLink: ({ url: targetUrl }) => { navigation.push(targetUrl); },
      openResource: ({ resource }) => { navigation.push(resource); },
      readResource: async () => ({
        contentType: 'application/json',
        digest: `sha256:${(linked ? 'b' : 'a').repeat(64)}`,
        bytes: new TextEncoder().encode(
          JSON.stringify(
            linked
              ? { ...bound, pullRequests: bound.pullRequests.map(binding => ({ ...binding,
                  latestUpdate: options.latestUpdate ?? binding.latestUpdate })) }
              : { kind: 'ready', sessionId: SESSION_ID, pullRequests: [] },
          ),
        ),
      }),
      watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
      executeAction: ({ action, input }) => {
        calls.push({ action, input });
        if (action === 'plugins.settings.list') {
          if (options.settingsReply !== undefined) return options.settingsReply;
          // The host transport is the boundary; validate its raw JSON with the
          // real Action schema before returning through the generic test port.
          return getActionSpec('plugins.settings.list').outputSchema.parse({
            ok: true,
            kind: 'plugins.settings.list',
            data: {
              scope: { kind: 'account' },
              target: { kind: 'account' },
              revision: 'settings-1',
              fields: [
                {
                  localId: 'pr-watch-default-mode',
                  secret: false,
                  value: defaultMode,
                },
                {
                  localId: 'pr-watch-fix-attempt-limit',
                  secret: false,
                  value: 3,
                },
                {
                  localId: 'pr-watch-archive-after-merge',
                  secret: false,
                  value: true,
                },
              ],
            },
          }) as never;
        }
        if (typeof action === 'string')
          throw new Error(`Unavailable in this fixture: ${action}`);
        if ((input as { kind?: string }).kind === 'attach') {
          linked = true;
          return { kind: 'attached', bindingId: 'binding-1' };
        }
        if ((input as { kind?: string }).kind === 'configure')
          return { kind: 'updated', bindingId: 'binding-1', revision: 2 };
        throw new Error('Unexpected Action');
      },
    },
  });
  mounted.push(fixture);
  await act(async () => {
    await Promise.resolve();
  });
  expect(calls.filter(call => call.action === 'plugins.settings.list')).toHaveLength(0);
  await act(async () => {
    await fixture.press(
      await fixture.findByRole('button', { name: 'Link this PR' }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { fixture, calls, navigation };
}

describe('Git pane PR card', () => {
  it('opens the admitted source recovery through the shared glance without changing the link or source', async () => {
    const destination = { pluginId: 'happier.scm.forge.github', localId: 'triage-sources' };
    const opened: unknown[] = [];
    const actions: unknown[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'git-source-choice', mountNonce: 'git-source-choice-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      launchInput: { homeServerId: 'home-1', pullRequest },
      surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID },
        accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        readResource: () => ({ contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify({ ...bound, pullRequests: bound.pullRequests.map(binding => ({
            ...binding, nativeStatus: { kind: 'unavailable',
              failure: { class: 'unsupportedContract', code: 'sessionLinksSourceInstanceRequired' },
              recovery: { kind: 'configureSources', offers: [{ destination, displayName: 'GitHub', kindNames: ['Pull requests'] }] },
            },
          })) })) }),
        watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
        openSurface: ({ view }) => { opened.push(view); },
        executeAction: ({ action, input }) => { actions.push({ action, input }); return null; },
      },
    });
    mounted.push(fixture);
    await fixture.getByText('Pull request status can’t be read');
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose a source' })); });
    expect(opened).toEqual([destination]);
    expect(actions).toEqual([]);
  });

  it.each(['transport', 'unavailable'] as const)('shows a typed %s refusal without a branch hint instead of hiding the linked-PR section', async kind => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'git-card-refusal', mountNonce: 'git-card-refusal-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      launchInput: { homeServerId: 'home-1' },
      surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID },
        accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        readResource: () => {
          if (kind === 'transport') throw new PluginError({ code: 'plugin_action_generation_retired',
            message: 'The mounted action generation is retired.', retryable: false,
            details: { requestId: 'pr-read-request-r110' } });
          return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
            bytes: new TextEncoder().encode(JSON.stringify({ kind: 'unavailable', sessionId: SESSION_ID,
              failure: { class: 'permission', code: 'sessionUnavailable' } })) };
        },
        watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
      },
    });
    mounted.push(fixture);
    await act(async () => { await Promise.resolve(); });
    await expect(fixture.getByText(kind === 'transport'
      ? 'Couldn’t read this session’s pull request' : 'Pull request status can’t be read')).resolves.toBeDefined();
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Details' })); });
    await expect(fixture.getByText(kind === 'transport'
      ? 'plugin_action_generation_retired' : 'sessionUnavailable')).resolves.toBeDefined();
    if (kind === 'transport') await expect(fixture.getByText('pr-read-request-r110')).resolves.toBeDefined();
    expect((await fixture.getAllByRole('button')).some(button => button.name === 'Try again')).toBe(false);
  });

  it.each(['manual', 'createdHere'] as const)('exposes the typed %s attach refusal while keeping the PR unlinked', async origin => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'git-card-attach-refused', mountNonce: 'git-card-attach-refused-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      launchInput: { homeServerId: 'home-1', pullRequest, ...(origin === 'createdHere' ? { origin } : {}) },
      surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID },
        accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        readResource: async () => ({ contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: SESSION_ID, pullRequests: [] })) }),
        watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
        executeAction: () => { throw new PluginError({ code: 'unavailable', retryable: false, details: { requestId: 'autolink-request-60' },
          diagnostics: [{ code: 'plugin_action_generation_retired', severity: 'error' }] }); },
      },
    });
    mounted.push(fixture);
    if (origin === 'manual') {
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Link this PR' })); });
    } else {
      await act(async () => { await Promise.resolve(); });
    }
    await expect(fixture.getByText('Couldn’t link this PR. The branch and the session are unchanged.')).resolves.toBeDefined();
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Details' })); });
    await expect(fixture.getByText('unavailable plugin_action_generation_retired')).resolves.toBeDefined();
    await expect(fixture.getByText('autolink-request-60')).resolves.toBeDefined();
    if (origin === 'manual') await expect(fixture.getByText('Branch hint')).resolves.toBeDefined();
    await expect(fixture.queryByText('Watch this PR?')).resolves.toBeUndefined();
  });

  it.each(['merge', 'dequeue'] as const)('executes the original source %s offer only for the exact bound SCM snapshot', async operation => {
    const original = createSessionPullRequestOperationGlanceBinding(operation);
    const binding = { ...original, link: { ...original.link, number: 42, url } };
    const calls: { action: unknown; input: unknown }[] = [];
    const outcome = { kind: 'applied', outcome: {
      kind: 'applied', effect: 'changed', confirmedState: null, confirmedEntryRef: null,
      presentation: { title: 'Source confirms the change', description: 'The original source confirmed this operation.', tone: 'secondary' },
    } } as const;
    const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
      calls.push({ action, input });
      return { ok: true, result: outcome };
    });
    let reads = 0;
    let watches = 0;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'bound-pr-operation', mountNonce: 'bound-pr-operation-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      launchInput: { homeServerId: 'home-1', pullRequest },
      surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID },
        accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        actionControl: controls.handler,
        readResource: async () => { reads += 1; return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: SESSION_ID, pullRequests: [binding] })) }; },
        watchResource: () => { watches += 1; return { digest: `sha256:${'a'.repeat(64)}` }; },
        executeAction: ({ action, input }) => {
          if (operation === 'dequeue') throw new Error('Raw current-user write bypass');
          calls.push({ action, input }); return outcome;
        },
      },
    });
    mounted.push(fixture);
    await act(async () => { await Promise.resolve(); });
    expect(calls).toEqual([]);
    if (operation === 'merge') {
      await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Merge' })); });
      expect(calls).toEqual([]);
      await act(async () => { await fixture.press(await fixture.findByRole('menuitem', { name: 'Squash' })); });
    } else {
      await act(async () => { await controls.press('Leave queue'); });
    }
    if (binding.nativeStatus.kind !== 'current' || !binding.nativeStatus.value.operations) throw new Error('Expected source offer');
    const offer = binding.nativeStatus.value.operations.primary;
    expect(calls).toEqual([{ action: offer.actionRef,
      input: offer.variants.find(item => item.id === (operation === 'merge' ? 'squash' : 'direct'))?.input }]);
    await expect(fixture.getByText('Source confirms the change')).resolves.toBeDefined();
    expect(reads).toBe(1);
    expect(watches).toBe(1);
  });

  it('selects one of several linked PRs before showing its card, the one that needs the person first', async () => {
    const second = { ...bound.pullRequests[0]!, bindingId: 'binding-2',
      link: { provider: 'github', repository: 'acme/widgets', number: 43, url: 'https://github.com/acme/widgets/pull/43' },
      watch: { ...bound.pullRequests[0]!.watch, reason: 'credentials' } };
    const opened: unknown[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'git-card-multi', mountNonce: 'git-card-multi-nonce' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      launchInput: { homeServerId: 'home-1', pullRequest },
      surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID },
        accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        readResource: async () => ({ contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify({ ...bound, pullRequests: [bound.pullRequests[0], second] })) }),
        watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
        openResource: ({ resource }) => { opened.push(resource); },
        executeAction: () => { throw new Error('No Action in this fixture'); },
      },
    });
    mounted.push(fixture);
    await act(async () => { await Promise.resolve(); });
    await expect(fixture.getByText('2 pull requests linked to this session')).resolves.toBeDefined();
    const chosen = await fixture.findByRole('radio', { name: '#43' });
    expect(chosen.state?.checked).toBe(true);
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Open' })); });
    expect(opened).toEqual([{ kind: 'pullRequest', url: second.link.url }]);
    await act(async () => { await fixture.press(await fixture.findByRole('radio', { name: '#42' })); });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Open' })); });
    expect(opened).toEqual([{ kind: 'pullRequest', url: second.link.url }, { kind: 'pullRequest', url }]);
  });

  it('offers the Account’s own default mode right after linking', async () => {
    const { fixture, calls } = await linkFromBranchHint('address');
    await expect(
      fixture.findByRole('button', { name: 'Watch · Address' }),
    ).resolves.toBeDefined();
    expect(calls.filter(call => call.action === 'plugins.settings.list')).toEqual([
      { action: 'plugins.settings.list', input: { pluginId: 'happier.channels', scope: { kind: 'account' }, target: { kind: 'account' } } },
    ]);
    expect(calls.some(call => (call.input as { kind?: string } | undefined)?.kind === 'configure')).toBe(false);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Watch · Address' })); });
    expect(calls.find(call => (call.input as { kind?: string } | undefined)?.kind === 'configure')).toEqual({
      action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
      input: { kind: 'configure', sessionId: SESSION_ID, bindingId: 'binding-1', expectedRevision: 1,
        policy: { mode: 'address', archiveAfterMerge: true } },
    });
  });

  it('offers nothing when the Account default is Off', async () => {
    const { fixture, calls } = await linkFromBranchHint('off');
    await expect(
      fixture.findByRole('button', { name: 'Open' }),
    ).resolves.toBeDefined();
    await expect(
      fixture.queryByRole('button', { name: 'Watch · Notify' }),
    ).resolves.toBeUndefined();
    await expect(
      fixture.queryByText('Watch this PR?'),
    ).resolves.toBeUndefined();
    expect(calls.some(call => (call.input as { kind?: string } | undefined)?.kind === 'configure')).toBe(false);
  });

  it('preserves the host pending approval when reading Account defaults instead of inventing an offer', async () => {
    const { fixture, calls } = await linkFromBranchHint('address', {
      settingsReply: { kind: 'approval_request_created', artifactId: 'settings-approval', actionId: 'plugins.settings.list' },
      pendingApproval: { artifactId: 'settings-approval', href: '/approvals/settings-approval' },
    });
    await expect(fixture.findByRole('button', { name: 'Open approval' })).resolves.toBeDefined();
    await expect(fixture.queryByText('Watch this PR?')).resolves.toBeUndefined();
    expect(calls.filter(call => call.action === 'plugins.settings.list')).toHaveLength(1);
    expect(calls.some(call => (call.input as { kind?: string } | undefined)?.kind === 'configure')).toBe(false);
  });

  it('keeps the linked PR unchanged while defaults load or are unavailable, without retrying or guessing Notify', async () => {
    let settle!: (value: JsonValue) => void;
    const settingsReply = new Promise<JsonValue>(resolve => { settle = resolve; });
    const { fixture, calls } = await linkFromBranchHint('address', { settingsReply });
    await expect(fixture.queryByText('Watch this PR?')).resolves.toBeUndefined();
    expect(calls.filter(call => call.action === 'plugins.settings.list')).toHaveLength(1);
    await act(async () => {
      settle({ ok: false, kind: 'plugins.settings.list', errorCode: 'plugin_settings_unavailable', error: 'unavailable' });
    });
    await expect(fixture.queryByText('Watch this PR?')).resolves.toBeUndefined();
    await expect(fixture.findByRole('button', { name: 'Watch mode: Off' })).resolves.toBeDefined();
    expect(calls.filter(call => call.action === 'plugins.settings.list')).toHaveLength(1);
    expect(calls.some(call => (call.input as { kind?: string } | undefined)?.kind === 'configure')).toBe(false);
  });

  it.each(['provider', 'sessionInput'] as const)('opens the SCM card’s exact retained %s latest update without a Watch effect', async kind => {
    const location = kind === 'provider' ? { kind, url: `${url}#discussion-42`, resource: { kind: 'pullRequest' as const, url: `${url}#discussion-42` } } : { kind, localId: 'retained-input-42' };
    const { fixture, calls, navigation } = await linkFromBranchHint('off', { latestUpdate: {
      occurrenceId: 'retained-42', occurredAtMs: 100, kinds: ['comment'], summary: 'Reviewer feedback', summaryTruncated: false, location,
    } });
    expect(navigation).toEqual([]);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Open the latest update: Reviewer feedback' })); });
    expect(navigation).toEqual([kind === 'provider' ? { kind: 'pullRequest', url: `${url}#discussion-42` } : { sessionId: SESSION_ID, localId: 'retained-input-42' }]);
    expect(calls.some(call => (call.input as { kind?: string } | undefined)?.kind === 'configure')).toBe(false);
  });
});
