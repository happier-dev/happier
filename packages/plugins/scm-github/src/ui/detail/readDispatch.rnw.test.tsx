// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button, Tabs, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import {
  describeTriageSourceFailureV1,
  TriageDetailSurfaceInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import {
  GithubChangedFilesInputV1Schema,
  GithubChangedFilesResultV1Schema,
  GithubOverviewResultV1Schema,
} from '../../triage/detail/contracts.js';
import {
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE,
  githubChangedFile,
} from '../../triage/__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  type StubHttpResponse,
} from '../../triage/testkit/githubTriage.test-support.js';
import { renderSurface } from '../renderSurface.js';
import { createTriageEphemeralSharedScopeFixture, createTriageEphemeralSharedScopeOriginFixture } from '../../../../triage/src/ui/window/ephemeralSharedScope.test-support.js';
import { SourcePanelActionsFixture, invokeSourcePanelFixtureAction } from '../../../../triage/src/ui/sourcePanelActions.test-support.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubChangedFileRows,
} from '../../triage/detail/projection.js';
import {
  useGithubChangedFileDiff,
  useGithubOverview,
  useGithubTimelineReader,
  type GithubChangedFileViewV1,
  type GithubOverviewControllerV1,
} from './panelReaders.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0))
    await act(async () => {
      await surface.dispose();
    });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

function launchInput() {
  const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: { kind: 'repository', repositoryKey: 'octo-org/example-app' },
  });
  if (token === null) throw new Error('Expected valid GitHub configuration');
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    panel: 'files',
    instance: {
      v: 1,
      instance: {
        source,
        sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
      },
      binding: {
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        account: {
          service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' },
          accountId: 'account-under-test',
        },
      },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token },
    },
    observation: {
      entryRef: {
        source,
        kindId: 'pull-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284',
      },
      observedAtMs: 1_760_000_700_000,
      locator: { v: 1, routingToken: 'octo-org/example-app' },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts: [],
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
}

function ExpandedDiffProbe({
  row,
}: Readonly<{ row: GithubChangedFileViewV1 }>) {
  const diff = useGithubChangedFileDiff(launchInput(), row);
  return (
    <Text testID="expanded-patch">
      {diff.state.kind === 'ready'
        ? (diff.state.value.unifiedDiff ?? diff.state.value.evidence.state)
        : diff.state.kind}
    </Text>
  );
}

function FileDisclosureProbe() {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState('src/open.ts');
  const row = React.useMemo(
    () => ({
      ...projectGithubChangedFileRows(
        [githubChangedFile({ filename: path })],
        GITHUB_DETAIL_BOUNDS_V1,
      ).rows[0]!,
      diffContinuation: null,
    }),
    [path],
  );
  return (
    <Tabs value="files" onValueChange={() => {}} ariaLabel="File probe">
      <Tabs.Item value="files" title="Files">
        <Button
          testID="toggle-file"
          title="Toggle file"
          onPress={() => setOpen((current) => !current)}
        />
        <Button
          testID="next-file"
          title="Next file"
          onPress={() => setPath('src/next.ts')}
        />
        {open ? <ExpandedDiffProbe row={row} /> : null}
      </Tabs.Item>
    </Tabs>
  );
}

async function mountRegisteredFiles(
  options: Readonly<{ misbind?: boolean; probe?: boolean }> = {},
) {
  const scope = createTriageEphemeralSharedScopeFixture();
  let release!: (response: StubHttpResponse) => void;
  const pending = new Promise<StubHttpResponse>((resolve) => {
    release = resolve;
  });
  const transport = createStubGithubTransport({
    respond: (request) =>
      request.url.includes('/files?') ? pending : undefined,
  });
  const plugin = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate, activateAccount },
    services: {
      http: transport.context.services.http,
      connectedAccounts: transport.context.services.connectedAccounts,
    },
  });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  const readSignals: AbortSignal[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: {
        instanceId: 'github-read-dispatch',
        mountNonce: 'github-read-dispatch-mount',
      },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      // A host context update reparses the same navigation value, just as the
      // targeted renderer receives new launch objects from the parent surface.
      surface: defineUiSurface((context) => {
        if (options.probe) return <FileDisclosureProbe />;
        const body = renderSurface({ ...context, launchInput: launchInput() });
        if (body !== null && !React.isValidElement(body))
          throw new Error('Expected a React-native surface');
        return <SourcePanelActionsFixture scope={scope}>{body}</SourcePanelActionsFixture>;
      }),
      launchInput: launchInput(),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          if (localId.startsWith('ui/') && input !== undefined) return await invokeSourcePanelFixtureAction(scope, localId, input, detail.context, signal);
          if (
            typeof action === 'string' ||
            action.pluginId !== GITHUB_PLUGIN_ID
          )
            throw new Error('Wrong Action owner');
          if (input === undefined)
            throw new Error('GitHub detail reads require an input');
          if (
            action.localId ===
            GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles
          )
            readSignals.push(signal);
          const misbound =
            options.misbind &&
            action.localId ===
              GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles;
          const filesRequest = misbound
            ? GithubChangedFilesInputV1Schema.parse(input)
            : null;
          const result = await plugin.invokeAction(
            misbound
              ? GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities
              : action.localId,
            filesRequest === null
              ? input
              : {
                  v: 1,
                  instance: filesRequest.instance,
                  localRef: filesRequest.localRef,
                  routingToken: filesRequest.routingToken,
                },
            { surface: 'ui', signal },
          );
          if (
            action.localId ===
            GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles
          )
            producerResults.push(result);
          return result;
        },
      },
    });
  });
  mounted.push(detail);
  return { detail, transport, producerResults, release, readSignals };
}

describe('registered GitHub detail read dispatch', () => {
  it.each(['absent', 'unadmitted'] as const)('reads and retains an Account Overview with an %s Machine execution scope', async (executionScope) => {
    const origins = createTriageEphemeralSharedScopeOriginFixture();
    const presentation = origins.forExecutionOrigin('account');
    // Host boundary: Account renderers can retain presentation data without a
    // Machine origin. Older hosts omit the execution-bound operation entirely.
    const scope = { acquire: presentation.acquire,
      ...(executionScope === 'unadmitted' ? { acquireExecutionBound: () => null } : {}) };
    let answer!: (response: StubHttpResponse) => void;
    const pending = new Promise<StubHttpResponse>((resolve) => { answer = resolve; });
    const transport = createStubGithubTransport({ respond: (request) =>
      new URL(request.url).pathname.endsWith('/pulls/1284') ? pending : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const observed: { current: GithubOverviewControllerV1 | null } = { current: null };
    let reads = 0;
    function OverviewProbe() {
      observed.current = useGithubOverview(launchInput(), { readWhenActive: true });
      return <Text>{observed.current.value?.body ?? observed.current.failure?.code ?? 'pending'}</Text>;
    }
    const mount = async () => {
      let detail!: PluginUiTestkit;
      await act(async () => {
        detail = await createPluginUiTestkit({
          identity: { instanceId: 'account-overview', mountNonce: `account-overview-${reads}` },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(() => <Tabs value="overview" onValueChange={() => {}} ariaLabel="Account Overview">
            <Tabs.Item value="overview" title="Overview"><OverviewProbe /></Tabs.Item>
          </Tabs>),
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
          handlers: { executeAction: async ({ action, input, signal }) => {
            if (typeof action === 'string' || input === undefined) throw new Error('Expected an Overview Action');
            reads++;
            return plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
          } },
        });
      });
      return detail;
    };
    const first = await mount();
    mounted.push(first);
    await vi.waitFor(() => expect(reads).toBe(1));
    await act(async () => { answer({ status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }); });
    await vi.waitFor(() => expect(observed.current).toMatchObject({ value: { kind: 'overview', body: GITHUB_PULL_REQUEST_RESPONSE.body }, failure: null, refreshing: false }));
    await act(async () => { await first.dispose(); });
    mounted.splice(mounted.indexOf(first), 1);
    const reopened = await mount();
    mounted.push(reopened);
    await vi.waitFor(() => expect(observed.current).toMatchObject({ value: { body: GITHUB_PULL_REQUEST_RESPONSE.body }, failure: null }));
    expect(reads).toBe(1);
    origins.retire();
  });

  it('settles a refused overview scope without dispatching or polling it', async () => {
    const origins = createTriageEphemeralSharedScopeOriginFixture();
    const scope = origins.forExecutionOrigin('retired');
    origins.retire();
    const observed: { current: GithubOverviewControllerV1 | null } = { current: null };
    function OverviewProbe() {
      observed.current = useGithubOverview(launchInput(), { readWhenActive: true });
      return null;
    }
    const executeAction = vi.fn(async () => { throw new Error('A refused scope cannot dispatch'); });
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: { instanceId: 'github-overview-refused', mountNonce: 'github-overview-refused-mount' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <Tabs value="overview" onValueChange={() => {}} ariaLabel="Overview probe">
          <Tabs.Item value="overview" title="Overview"><OverviewProbe /></Tabs.Item>
        </Tabs>),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
        handlers: { executeAction },
      });
    });
    mounted.push(detail);
    expect(observed.current).toMatchObject({ value: null, refreshing: false,
      failure: { code: 'github-overview-scope-unavailable' } });
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(await observed.current!.refresh()).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it.each(['head', 'same-head source revision', 'execution origin'] as const)(
    'acquires the latest %s demand and recovers held HTTP work across leave and re-entry', async (change) => {
    const headRevision = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
    const origins = createTriageEphemeralSharedScopeOriginFixture();
    let executionScope = origins.forExecutionOrigin('initial-machine');
    const pendingReads: Array<(response: StubHttpResponse) => void> = [];
    const httpSignals: Array<AbortSignal | undefined> = [];
    const transport = createStubGithubTransport({ respond: (request, options) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) {
        httpSignals.push(options?.signal);
        return new Promise<StubHttpResponse>((resolve) => { pendingReads.push(resolve); });
      }
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const observed: { current: GithubOverviewControllerV1 | null } = { current: null };
    function OverviewProbe() {
      const [observationVersion, setObservationVersion] = React.useState(0);
      const [, rerender] = React.useReducer((value: number) => value + 1, 0);
      const launched = launchInput();
      const input = { ...launched, observation: { ...launched.observation,
        sourceUpdatedAtMs: change === 'same-head source revision' ? 3_000 + observationVersion * 1_000 : 3_000,
        snapshot: { ...launched.observation.snapshot, ...(observationVersion > 0 || change !== 'head' ? { reviewRevision: {
          baseSha: 'a'.repeat(40), headSha: headRevision, nativeRevision: headRevision,
        } } : {}) },
      } };
      observed.current = useGithubOverview(input, { readWhenActive: true });
      return <><Button title="Admit newer observation" onPress={() => {
        if (change === 'execution origin') executionScope = origins.forExecutionOrigin('replacement-machine');
        setObservationVersion(value => value + 1);
      }} />
        <Button title="Repeat equal observation" onPress={rerender} /></>;
    }
    function OverviewTabs() {
      const [panel, setPanel] = React.useState('overview');
      return <><Button title="Leave Overview" onPress={() => setPanel('other')} />
        <Button title="Return to Overview" onPress={() => setPanel('overview')} />
        <Tabs value={panel} onValueChange={setPanel} ariaLabel="Overview probe">
          <Tabs.Item value="overview" title="Overview" retention="retain"><OverviewProbe /></Tabs.Item>
          <Tabs.Item value="other" title="Other" />
        </Tabs></>;
    }
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: { instanceId: 'github-overview-head', mountNonce: 'github-overview-head-mount' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <OverviewTabs />),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter({
          get ephemeralSharedScope() { return executionScope; },
        }),
        handlers: { executeAction: async ({ action, input, signal }) => {
          if (typeof action === 'string' || input === undefined) throw new Error('Expected the exact Overview Action');
          return plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
        } },
      });
    });
    mounted.push(detail);
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1));
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Admit newer observation' })); });
    if (change === 'execution origin') await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(observed.current).toMatchObject({ value: null, failure: null, refreshing: true });
    if (change === 'same-head source revision') {
      expect(httpSignals[0]?.aborted).toBe(false);
      await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Admit newer observation' })); });
      expect(pendingReads).toHaveLength(1);
      await act(async () => { pendingReads[0]!({ status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }); });
    }
    await vi.waitFor(() => expect(pendingReads).toHaveLength(2));
    if (change !== 'same-head source revision') expect(httpSignals[0]?.aborted).toBe(true);
    expect(observed.current).toMatchObject({ failure: null, refreshing: true });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Leave Overview' })); });
    expect(httpSignals[1]?.aborted).toBe(true);
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Return to Overview' })); });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(3));
    // Neither obsolete HTTP response is completed to unblock the next read.
    await act(async () => { pendingReads[2]!({ status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }); });
    await vi.waitFor(() => expect(observed.current).toMatchObject({
      value: { kind: 'overview', headRevision, pullRequestStatus: { kind: 'status' } },
      checkedAtMs: expect.any(Number), failure: null, refreshing: false,
    }));
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Repeat equal observation' })); });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Leave Overview' })); });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Return to Overview' })); });
    expect(pendingReads).toHaveLength(3);
  });

  it('retains a failed native status and its successful clock throughout a pending retry', async () => {
    const pendingReads: Array<(response: StubHttpResponse) => void> = [];
    const transport = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return new Promise<StubHttpResponse>((resolve) => { pendingReads.push(resolve); });
      if (path === '/graphql') return { status: 200, body: { data: { repository: { pullRequest: {
        id: 'PR_1284', headRefOid: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
        reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', viewerCanMergeAsAdmin: true,
        viewerCanUpdate: true, viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: false,
        mergeQueueEntry: null,
        reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
        reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
        commits: { nodes: [{ commit: { oid: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
          statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: false } } } } }] },
      } } } } };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const observed: { current: GithubOverviewControllerV1 | null } = { current: null };
    const results: unknown[] = [];
    function OverviewProbe() {
      const current = useGithubOverview(launchInput());
      observed.current = current;
      return <Button title="Refresh overview" onPress={() => { void current.refresh(); }} />;
    }
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: { instanceId: 'github-overview-retry', mountNonce: 'github-overview-retry-mount' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <Tabs value="overview" onValueChange={() => {}} ariaLabel="Overview probe">
          <Tabs.Item value="overview" title="Overview"><OverviewProbe /></Tabs.Item>
        </Tabs>),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ action, input, signal }) => {
          if (typeof action === 'string' || action.pluginId !== GITHUB_PLUGIN_ID
            || action.localId !== GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview || input === undefined) {
            throw new Error('Expected the registered exact Overview Action');
          }
          const result = await plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
          results.push(result);
          return result;
        } },
      });
    });
    mounted.push(detail);
    expect(observed.current).toMatchObject({ value: null, checkedAtMs: null, failure: null, refreshing: false });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Refresh overview' })); });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1));
    expect(observed.current).toMatchObject({ value: null, checkedAtMs: null, failure: null, refreshing: true });
    await act(async () => { pendingReads[0]!({ status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE,
      mergeable: true, mergeable_state: 'clean', auto_merge: null } }); });
    await vi.waitFor(() => expect(observed.current).toMatchObject({ failure: null, refreshing: false, checkedAtMs: expect.any(Number) }));
    const successful = observed.current!;
    expect(successful.value?.kindId === 'pull-request' && successful.value.pullRequestStatus?.merge?.canMergeWithoutWaiting).toBe(true);

    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Refresh overview' })); });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(2));
    await act(async () => { pendingReads[1]!({ status: 500, body: { message: 'Temporarily unavailable' } }); });
    await vi.waitFor(() => expect(observed.current).toMatchObject({ failure: { class: 'transient' }, refreshing: false }));
    const failed = observed.current!;
    expect(failed.value).toBe(successful.value);
    expect(failed.checkedAtMs).toBe(successful.checkedAtMs);

    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Refresh overview' })); });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(3));
    const retrying = observed.current!;
    expect(retrying.refreshing).toBe(true);
    expect(retrying.failure).toBe(failed.failure);
    expect(retrying.value).toBe(failed.value);
    expect(retrying.checkedAtMs).toBe(failed.checkedAtMs);
    await act(async () => { pendingReads[2]!({ status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE,
      mergeable: true, mergeable_state: 'clean', auto_merge: null } }); });
    await vi.waitFor(() => expect(observed.current).toMatchObject({ failure: null, refreshing: false }));
    const admitted = GithubOverviewResultV1Schema.parse(results.at(-1));
    if (admitted.kind !== 'overview' || admitted.kindId !== 'pull-request' || !admitted.pullRequestStatus) {
      throw new Error('Expected an admitted successful native PR status');
    }
    expect(observed.current!.checkedAtMs).toBe(admitted.pullRequestStatus.observedAtMs);
  });

  it('cancels a pending old file before admitting the replacement file through the same Action', async () => {
    const { detail, transport, readSignals, release } =
      await mountRegisteredFiles({ probe: true });
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Toggle file' }),
      );
    });
    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => request.url.includes('/files?')),
      ).toHaveLength(1),
    );
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Next file' }),
      );
    });
    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => request.url.includes('/files?')),
      ).toHaveLength(2),
    );
    expect(readSignals[0]?.aborted).toBe(true);
    await act(async () => {
      release({
        status: 200,
        body: ['open', 'next'].map((name) => ({
          ...githubChangedFile({ filename: `src/${name}.ts` }),
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: `@@ -1 +1 @@\n-old\n+${name}-file`,
        })),
      });
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toContain('+next-file');
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).not.toContain('+open-file');
    });
  });

  it('never retains another file patch when changed identity cannot be read', async () => {
    const { detail, release } = await mountRegisteredFiles({ probe: true });
    await act(async () => {
      release({
        status: 200,
        body: [
          {
            ...githubChangedFile({ filename: 'src/open.ts' }),
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-old\n+first-file',
          },
        ],
      });
    });
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Toggle file' }),
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toContain('+first-file');
    });
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Next file' }),
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toBe('unavailable');
    });
  });

  it('reads a body only while expanded, cancels on close, and reopens through the same registered owner', async () => {
    const { detail, transport, readSignals, release } =
      await mountRegisteredFiles({ probe: true });
    const toggle = async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Toggle file' }),
      );
    };
    expect(
      transport.requests.filter((request) => request.url.includes('/files?')),
    ).toHaveLength(0);
    await act(async () => {
      await toggle();
    });
    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => request.url.includes('/files?')),
      ).toHaveLength(1),
    );
    expect(readSignals[0]?.aborted).toBe(false);
    await act(async () => {
      await toggle();
    });
    expect(readSignals[0]?.aborted).toBe(true);
    await act(async () => {
      release({
        status: 200,
        body: [
          {
            ...githubChangedFile({ filename: 'src/open.ts' }),
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-old\n+fresh',
          },
        ],
      });
    });
    expect(document.querySelector('[data-testid="expanded-patch"]')).toBeNull();
    await act(async () => {
      await toggle();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toBe(
        '--- "a/src/open.ts"\n+++ "b/src/open.ts"\n@@ -1 +1 @@\n-old\n+fresh',
      );
    });
    expect(
      transport.requests.filter((request) => request.url.includes('/files?')),
    ).toHaveLength(2);
  });

  it('keeps a real pending read across reparsed launch input and populates the mounted panel', async () => {
    const { detail, transport, producerResults, release } =
      await mountRegisteredFiles();
    expect(
      transport.requests.some((request) => request.url.includes('/files?')),
    ).toBe(true);
    await act(async () => {
      await detail.updateSurface(createSurfaceContextFixture());
    });
    await act(async () => {
      release({
        status: 200,
        body: [githubChangedFile({ filename: 'src/dispatch.ts' })],
      });
    });
    expect(producerResults).toHaveLength(1);
    expect(
      GithubChangedFilesResultV1Schema.parse(producerResults[0]),
    ).toMatchObject({
      kind: 'changedFiles',
      rows: [{ path: 'src/dispatch.ts' }],
    });
    // File titles retain both path halves in separate text runs for middle ellipsis.
    expect(document.body.textContent).toContain('src/dispatch.ts');
    // A settled host update must retain the same page rather than re-read it.
    await act(async () => {
      await detail.updateSurface(createSurfaceContextFixture());
    });
    expect(document.body.textContent).toContain('src/dispatch.ts');
    expect(producerResults).toHaveLength(1);
  });

  it('opens a changed file in place to its own diff, read only when the row is opened', async () => {
    const { detail, transport, release } = await mountRegisteredFiles();
    await act(async () => {
      release({
        status: 200,
        body: [
          {
            ...githubChangedFile({ filename: 'src/open.ts' }),
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-old\n+fresh-line',
          },
        ],
      });
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('src/open.ts'),
    );
    const filesReads = () =>
      transport.requests.filter((request) => request.url.includes('/files?'))
        .length;
    const listed = filesReads();
    expect(document.body.textContent).not.toContain('+fresh-line');
    const row = (await detail.queryAllByRole('button')).find(
      (target) => target.name?.includes('src/open.ts') === true,
    );
    if (row === undefined)
      throw new Error('Expected the changed file row to open in place');
    await act(async () => {
      await detail.press(row);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.body.textContent).toContain('+fresh-line');
    });
    expect(filesReads()).toBe(listed + 1);
  });

  it('refuses a mis-bound registered producer rather than presenting its result as files', async () => {
    const { detail, producerResults } = await mountRegisteredFiles({
      misbind: true,
    });
    await expect(
      detail.queryByText('src/dispatch.ts'),
    ).resolves.toBeUndefined();
    expect(producerResults).toHaveLength(1);
    expect(
      GithubChangedFilesResultV1Schema.safeParse(producerResults[0]).success,
    ).toBe(false);
    await expect(
      detail.getByText(
        describeTriageSourceFailureV1(
          {
            class: 'unsupportedContract',
            code: 'github-detail-result-unreadable',
          },
          'GitHub could not complete this read.',
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe('a detail walk across an entry change', () => {
  it('clears the previous entry\'s rows in the reader itself before the new entry answers', async () => {
    const activity = { active: true, activeSignal: new AbortController().signal };
    let answerSecond!: (value: unknown) => void;
    const second = new Promise((resolve) => { answerSecond = resolve; });
    const page = (summary: string) => ({ kind: 'timeline', omittedRowCount: 0, projectionTruncated: false,
      rows: [{ id: summary, kind: 'unsupported', rawKind: 'provider-specific-event', actor: 'Mara', summary }] });
    function TimelineProbe() {
      const [entryId, setEntryId] = React.useState('1284');
      const input = React.useMemo(() => {
        const base = launchInput();
        return { ...base, observation: { ...base.observation, entryRef: { ...base.observation.entryRef, entryId } } };
      }, [entryId]);
      const walk = useGithubTimelineReader(input, activity);
      return <>
        <Button title="Next entry" onPress={() => setEntryId('1285')} />
        <Text testID="timeline-rows">{walk.state.rows.map((row) => row.summary).join(',') || walk.state.kind}</Text>
      </>;
    }
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: { instanceId: 'timeline-authority', mountNonce: 'timeline-authority-mount' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <Tabs value="timeline" onValueChange={() => {}} ariaLabel="Timeline">
          <Tabs.Item value="timeline" title="Timeline"><TimelineProbe /></Tabs.Item>
        </Tabs>),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ input }) => {
          const { localRef } = input as { localRef: { entryId: string } };
          return (localRef.entryId === '1284' ? page('first entry event') : await second) as never;
        } },
      });
    });
    mounted.push(detail);
    await expect(detail.getByText('first entry event')).resolves.toBeDefined();
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Next entry' })); });
    // Another entry's walk is not this one's: nothing of the first is shown while the second is read.
    await expect(detail.queryByText('first entry event')).resolves.toBeUndefined();
    await act(async () => { answerSecond(page('second entry event')); });
    await expect(detail.getByText('second entry event')).resolves.toBeDefined();
  });
});
