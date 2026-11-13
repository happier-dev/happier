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
  TriageGetResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../triage/contribution.js';
import {
  GithubChangedFilesInputV1Schema,
  GithubChangedFilesResultV1Schema,
  GithubOverviewResultV1Schema,
  GithubIssueOpeningDetailV1Schema,
  GithubFeedbackInputV1Schema,
  GithubFeedbackResultV1Schema,
} from '../../triage/detail/contracts.js';
import {
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  githubChangedFile,
} from '../../triage/__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  githubChecksBatchResponse,
  readRecordedJsonBody,
  type StubHttpResponse,
} from '../../triage/testkit/githubTriage.test-support.js';
import { renderSurface } from '../renderSurface.js';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { useTriagePostMutationRow } from '../../../../triage/src/ui/detail/useTriagePostMutationRow.js';
import { readTriageSelectedObservationV1 } from '../../../../triage/src/ui/window/selectedObservation.js';
import { reobserveTriageEntry } from '../../../../triage/src/actions/reobserveEntry.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryInputV1Schema } from '../../../../triage/src/actions/reobserveEntryProtocol.js';
import { toTriageWireObservation } from '../../../../triage/src/projection/listWindowWire.js';
import type { TriageAdmittedSourceV1 } from '../../../../triage/src/actions/listEntries.js';
import { GithubEntryPropertyPicker } from './entryPropertyPicker.js';
import { createTriageEphemeralSharedScopeFixture, createTriageEphemeralSharedScopeOriginFixture } from '../../../../triage/src/ui/window/ephemeralSharedScope.test-support.js';
import { SourcePanelActionsFixture, invokeSourcePanelFixtureAction } from '../../../../triage/src/ui/sourcePanelActions.test-support.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubChangedFileRows,
} from '../../triage/detail/projection.js';
import {
  useGithubChangedFileDiffLoader,
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

/** Drives the loader the way the shared review does: one read per file in view, cancelled when it leaves. */
function ExpandedDiffProbe({
  row,
}: Readonly<{ row: GithubChangedFileViewV1 }>) {
  const load = useGithubChangedFileDiffLoader(launchInput());
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const [text, setText] = React.useState('loading');
  React.useEffect(() => {
    const controller = new AbortController();
    setText('loading');
    void loadRef.current(row, controller.signal).then((read) => {
      if (controller.signal.aborted) return;
      setText(read.kind === 'ready'
        ? (read.value.unifiedDiff ?? read.value.evidence.state)
        : 'unavailable');
    });
    return () => controller.abort();
  }, [row]);
  return <Text testID="expanded-patch">{text}</Text>;
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
  options: Readonly<{ misbind?: boolean; probe?: boolean; review?: boolean }> = {},
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
      adapter: createPluginUiRnwSemanticSurfaceAdapter(options.review ? { changedFilesReview: true } : {}),
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
  it.each([
    ['status', 'github_forbidden'],
    ['transport', 'github_request_failed'],
    ['invalidJson', 'github_api_response_invalid'],
    ['invalidShape', 'github_graphql_response_invalid'],
    ['graphqlError', 'github_forbidden'],
    ['missingData', 'github_graphql_response_invalid'],
    ['invalidFeedbackData', 'github_feedback_response_invalid'],
    ['wrongRepository', 'route-body-mismatch'],
  ] as const)('keeps the parent Feedback thread and shows the registered earlier-replies failure %s code and issued request ID', async (refusal, code) => {
    const scope = createTriageEphemeralSharedScopeFixture();
    const input = TriageDetailSurfaceInputV1Schema.parse({ ...launchInput(), panel: 'activity' });
    let replyReadCount = 0;
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path === '/graphql') {
        // GitHub GraphQL is the genuine boundary; registered readers and projections stay real.
        const { query } = readRecordedJsonBody(request) as { query: string };
        if (query.includes('GithubFeedbackThreadReplies')) {
          replyReadCount += 1;
          if (replyReadCount === 1) return { status: 200, body: { data: { node: {
            id: 'PRRT_retained', pullRequest: { number: 1284, repository: { databaseId: Number(GITHUB_FIXTURE_REPOSITORY_ID) } },
            comments: { nodes: [{ id: 'PRRC_older', body: 'A previously loaded reply remains readable.', author: { login: 'reviewer' }, createdAt: '2026-08-11T13:00:00Z' }],
              pageInfo: { hasPreviousPage: true, startCursor: 'earlier-again' } },
          } } } };
          if (refusal === 'transport') throw new Error('Network unavailable');
          if (refusal === 'invalidJson') return { status: 200, rawBody: new TextEncoder().encode('{') };
          if (refusal === 'invalidShape') return { status: 200, body: [] };
          if (refusal === 'graphqlError') return { status: 200, body: { errors: [{ type: 'FORBIDDEN' }], data: null } };
          if (refusal === 'missingData') return { status: 200, body: {} };
          if (refusal === 'invalidFeedbackData') return { status: 200, body: { data: {} } };
          if (refusal === 'wrongRepository') return { status: 200, body: { data: { node: {
            id: 'PRRT_retained', pullRequest: { number: 1284, repository: { databaseId: 1 } },
          } } } };
          return { status: 403, body: {} };
        }
        const pageInfo = { hasPreviousPage: false, hasNextPage: false };
        const empty = { nodes: [], pageInfo };
        const pullRequest = query.includes('GithubFeedbackThreads') ? {
          reviewThreads: { nodes: [{ id: 'PRRT_retained', isResolved: false, path: 'src/pump.ts', line: 42,
            firstComment: { totalCount: 4, nodes: [{ id: 'PRRC_first', body: 'Keep the parent Feedback readable.', author: { login: 'reviewer' }, createdAt: '2026-08-09T13:00:00Z' }] },
            comments: { nodes: [{ id: 'PRRC_latest', body: 'The latest reply remains readable.', author: { login: 'reviewer' }, createdAt: '2026-08-12T13:00:00Z' }],
              pageInfo: { hasPreviousPage: true, startCursor: 'earlier-replies' } },
          }], pageInfo },
        } : query.includes('GithubFeedbackComments') ? { comments: empty }
          : query.includes('GithubFeedbackReviews') ? { reviews: empty }
            : query.includes('GithubFeedbackRequests') ? { reviewRequests: empty } : null;
        return pullRequest === null ? githubChecksBatchResponse(request)
          : { status: 200, body: { data: { repository: { databaseId: Number(GITHUB_FIXTURE_REPOSITORY_ID), pullRequest } } } };
      }
      if (path.endsWith('/pulls/1284')) return { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
      if (path.endsWith('/issues/1284')) return { status: 200, body: GITHUB_ISSUE_RESPONSE };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const replies: Array<Readonly<{ result: unknown; requestId: string }>> = [];
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: { instanceId: 'github-thread-failure', mountNonce: 'github-thread-failure-mount' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => {
          const body = renderSurface({ ...context, launchInput: input });
          if (body !== null && !React.isValidElement(body)) throw new Error('Expected a native GitHub surface');
          return <SourcePanelActionsFixture scope={scope}>{body}</SourcePanelActionsFixture>;
        }),
        launchInput: input,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ action, input: actionInput, requestId, signal }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          if (localId.startsWith('ui/') && actionInput !== undefined)
            return await invokeSourcePanelFixtureAction(scope, localId, actionInput, detail.context, signal);
          const result = await plugin.invokeAction(localId, actionInput, { surface: 'ui', requestId, signal });
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback
            && GithubFeedbackInputV1Schema.parse(actionInput).connection === 'threadReplies') replies.push({ result, requestId });
          return result;
        } },
      });
    });
    mounted.push(detail);
    await vi.waitFor(async () => expect(await detail.getByText('The latest reply remains readable.')).toBeDefined());
    await vi.waitFor(async () => expect(await detail.getByText('A previously loaded reply remains readable.')).toBeDefined());
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Load earlier replies' })); });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(GithubFeedbackResultV1Schema.parse(replies[1]!.result)).toMatchObject({
      kind: 'unavailable', failure: { code, requestId: replies[1]!.requestId },
    });
    await expect(detail.getByText('The latest reply remains readable.')).resolves.toBeDefined();
    await expect(detail.getByText('A previously loaded reply remains readable.')).resolves.toBeDefined();
    const notices = await detail.getAllByRole('button', { name: 'Details' });
    for (let index = 0; index < notices.length; index += 1) {
      await act(async () => { await detail.press((await detail.getAllByRole('button', { name: 'Details' }))[index]!); });
      if (await detail.queryByText(replies[1]!.requestId) !== undefined) break;
      await act(async () => { await detail.press((await detail.getAllByRole('button', { name: 'Details' }))[index]!); });
    }
    await expect(detail.getByText(code)).resolves.toBeDefined();
    await expect(detail.getByText(replies[1]!.requestId)).resolves.toBeDefined();
  });

  it.each([
    ['transport', 'github_request_failed'],
    ['invalidJson', 'github_api_response_invalid'],
    ['invalidShape', 'route-body-mismatch'],
    ['undeclaredKind', 'github_kind_undeclared'],
  ] as const)('retains the ordinary get request identity after a provider %s failure', async (refusal, code) => {
    const requestId = 'd5f4ff53-e307-4e2c-97f8-0b79bca51915';
    const transport = createStubGithubTransport({ respond: request => {
      if (!new URL(request.url).pathname.endsWith('/issues/7')) return undefined;
      if (refusal === 'transport') throw new Error('Network unavailable');
      return refusal === 'invalidJson'
        ? { status: 200, rawBody: new TextEncoder().encode('{') }
        : { status: 200, body: {} };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const result = TriageGetResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, {
      v: 1, instance: launchInput().instance,
      localRef: { kindId: refusal === 'undeclaredKind' ? 'unknown-kind' : 'issue', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '7' },
      lastKnownLocator: { v: 1, routingToken: 'octo-org/example-app' },
    }, { surface: 'ui', requestId }));
    expect(result).toMatchObject({ kind: 'unresolved', failure: { code, requestId } });
  });
  it.each([['status', 'github_forbidden'], ['transport', 'github_request_failed']] as const)(
    'retains the cold get request identity through a partial repository capability %s failure and native strict parsing', async (refusal, code) => {
    const requestId = '79edcd0f-6e82-4b1a-9f31-130ac82375e0';
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path === '/repos/octo-org/example-app') {
        if (refusal === 'transport') throw new Error('Network unavailable');
        return { status: 403, body: {} };
      }
      if (path.endsWith('/issues/7')) return { status: 200, body: { ...GITHUB_ISSUE_RESPONSE,
        repository: GITHUB_REPOSITORY_RESPONSE,
        url: 'https://api.github.com/repos/octo-org/example-app/issues/7',
        repository_url: 'https://api.github.com/repos/octo-org/example-app',
        html_url: 'https://github.com/octo-org/example-app/issues/7' } };
      if (path.endsWith('/parent')) return { status: 404, body: {} };
      if (path.endsWith('/sub_issues') || path.endsWith('/blocked_by')) return { status: 200, body: [] };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const opening = launchInput();
    const result = TriageGetResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, {
      v: 1, instance: opening.instance, localRef: { kindId: 'issue', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '7' },
      lastKnownLocator: { v: 1, routingToken: 'octo-org/example-app' },
    }, { surface: 'ui', requestId }));
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'present' });
    if (result.kind !== 'present') return;
    const native = GithubIssueOpeningDetailV1Schema.parse(result.detailData);
    expect(native.capabilities).toMatchObject({ kind: 'unavailable', failure: { code, requestId } });
    const input = TriageDetailSurfaceInputV1Schema.parse({ ...opening, panel: 'overview', detailData: result.detailData,
      observation: { entryRef: { source: opening.observation.entryRef.source, ...result.localRef },
        observedAtMs: opening.observation.observedAtMs, locator: result.locator, snapshot: result.snapshot, viewer: result.viewer } });
    let detail!: PluginUiTestkit;
    const scope = createTriageEphemeralSharedScopeFixture();
    await act(async () => {
      detail = await createPluginUiTestkit({ identity: { instanceId: 'cold-issue-failure', mountNonce: 'cold-issue-failure' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' }, launchInput: input,
        surface: defineUiSurface(context => <SourcePanelActionsFixture scope={scope}>
          {renderSurface({ ...context, launchInput: input }) as React.ReactNode}
        </SourcePanelActionsFixture>), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ action, input: actionInput, signal }) => {
          if (typeof action === 'string' || actionInput === undefined) throw new Error('Unexpected cold issue Action');
          return plugin.invokeAction(action.localId, actionInput, { surface: 'ui', signal });
        } },
      });
    });
    mounted.push(detail);
    const details = await detail.getByRole('button', { name: 'Details' });
    await act(async () => { await detail.press(details); });
    await expect(detail.getByText(requestId)).resolves.toBeDefined();
    expect(document.body.textContent).toContain('The client reconnects in a loop after resume.');
  });
  it('settles current after the second Unassign through the native completion owner', async () => {
    let assigned = false;
    let writes = 0;
    let nativeReads = 0;
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/assignees') && request.method !== 'GET') {
        writes++;
        assigned = request.method === 'POST';
        return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, assignees: assigned ? [GITHUB_PULL_REQUEST_RESPONSE.user] : [] } };
      }
      if (path.endsWith('/assignees')) return { status: 200, body: [GITHUB_PULL_REQUEST_RESPONSE.user] };
      if (path.endsWith('/labels')) return { status: 200, body: [] };
      if (path.endsWith('/pulls/1284') || path.endsWith('/issues/1284')) return { status: 200, body: {
        ...GITHUB_PULL_REQUEST_RESPONSE, assignees: assigned ? [GITHUB_PULL_REQUEST_RESPONSE.user] : [], labels: [],
      } };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const opening = launchInput();
    const instance = opening.instance;
    const selection = { sectionId: null, entryRef: opening.observation.entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
    // The host supplies opaque admitted operation handles; all native reads and folds beneath it are real.
    const admitted = [{ contributor: { pluginId: GITHUB_PLUGIN_ID, contributionId: 'github-forge' },
      descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1, operations: { get: {} } }] as unknown as readonly TriageAdmittedSourceV1[];
    const lanes = Object.freeze([]);
    function Entry({ context }: { context: Parameters<typeof renderSurface>[0] }) {
      const detail = useTriagePostMutationRow(null, lanes, selection);
      const selected = detail.row === null ? null : readTriageSelectedObservationV1(detail.row);
      if (selected === null) return <Text value="Opening PR" />;
      const input = { ...opening, panel: 'actions' as const, observation: selected.observation,
        ...(detail.exactRead?.detailData === undefined ? {} : { detailData: detail.exactRead.detailData }) };
      return <TriagePostMutationCompletionProvider onComplete={detail.completePostMutation}>
        <Tabs value="entry" onValueChange={() => {}} ariaLabel="Native entry">
          <Tabs.Item value="entry" title="Entry">
            <Story input={input} />
            {renderSurface({ ...context, launchInput: input }) as React.ReactNode}
          </Tabs.Item>
        </Tabs>
      </TriagePostMutationCompletionProvider>;
    }
    function Story({ input }: { input: ReturnType<typeof launchInput> }) {
      const overview = useGithubOverview(input, { readWhenActive: true });
      return <Text value={`Story current:${overview.value?.assignees?.join(',') ?? 'reading'}`} />;
    }
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({ identity: { instanceId: 'repeated-removal', mountNonce: 'repeated-removal' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <Entry context={context} />),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
        handlers: { executeAction: async request => {
          if (typeof request.action !== 'string') return plugin.invokeAction(request.action.localId, request.input!, { surface: 'ui', signal: request.signal });
          if (request.action !== TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) throw new Error(`Unexpected Action ${request.action}`);
          nativeReads++;
          const input = TriageReobserveEntryInputV1Schema.parse(request.input);
          const result = await reobserveTriageEntry({ ...input, lastKnownLocator: opening.observation.locator }, {
            readConfiguredInstance: async () => instance, readSourceSnapshot: async () => ({ contributions: admitted }),
            executeGet: async (_operation, getInput, options) => plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, getInput,
              { surface: 'ui', signal: options?.signal }), nowMs: () => Date.now(), signal: request.signal,
          });
          if (result.kind !== 'observed') throw new Error(result.kind);
          const { entryRef, ...observation } = result.observation;
          return { ...result, entryRef, observation: toTriageWireObservation(observation) };
        } },
      });
    });
    mounted.push(detail);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.body.textContent).not.toContain('Opening PR');
      await expect(detail.getByRole('button', { name: 'Assignees, None' })).resolves.toBeDefined();
    });
    for (const [index, next] of [true, false, true, false].entries()) {
      const current = next ? 'None' : GITHUB_PULL_REQUEST_RESPONSE.user.login;
      if (await detail.queryByRole('menuitemcheckbox', {}) !== undefined) {
        await act(async () => { await detail.press(await detail.getByRole('button', { name: `Assignees, ${current}` })); });
      }
      await act(async () => { await detail.press(await detail.getByRole('button', { name: `Assignees, ${current}` })); });
      const choices = await detail.getAllByRole('menuitemcheckbox');
      await act(async () => { await detail.press(choices[0]!); });
      await vi.waitFor(async () => { await act(async () => {}); expect(writes, document.body.textContent ?? '').toBe(index + 1); });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(await detail.queryByRole('button', { name: `Assignees, ${next ? GITHUB_PULL_REQUEST_RESPONSE.user.login : 'None'}` }),
          `current after mutation ${index + 1}; provider assigned=${assigned}; ${document.body.textContent}`).toBeDefined();
        await expect(detail.getByRole('button', { name: 'Labels, None' })).resolves.toBeDefined();
        await expect(detail.getByText(`Story current:${next ? GITHUB_PULL_REQUEST_RESPONSE.user.login : ''}`)).resolves.toBeDefined();
      });
    }
    expect(nativeReads).toBe(5);
  });

  it.each(['remounted reader', 'unchanged provider revision'] as const)('keeps both property editors and current membership after a settled write with %s', async (change) => {
    const scope = createTriageEphemeralSharedScopeFixture();
    let assigned = false;
    let observationVersion = 0;
    let directoryUnavailable = false;
    let directoryReads = 0;
    let entryReads = 0;
    const transport = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/assignees') || path.endsWith('/labels')) {
        directoryReads++;
        if (directoryUnavailable) return { status: 403, body: { message: 'Forbidden' } };
        return { status: 200, body: path.endsWith('/assignees')
          ? [GITHUB_PULL_REQUEST_RESPONSE.user] : [{ id: 11, name: 'bug' }] };
      }
      if (!path.endsWith('/pulls/1284')) return undefined;
      entryReads++;
      return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE,
        assignees: assigned ? [GITHUB_PULL_REQUEST_RESPONSE.user] : [],
        labels: assigned ? [{ id: 11, name: 'bug' }] : [],
      } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const observed = new Map<string, GithubOverviewControllerV1>();
    const mount = async (name: string, includePropertyChoices: boolean) => {
      function Probe() {
        const input = launchInput();
        const overview = useGithubOverview({ ...input, observation: { ...input.observation,
          observedAtMs: input.observation.observedAtMs + observationVersion,
          sourceUpdatedAtMs: change === 'remounted reader' ? 3_000 + observationVersion : 3_000,
        } }, { readWhenActive: name === 'story', includePropertyChoices });
        observed.set(name, overview);
        const value = overview.value;
        return !includePropertyChoices || value === null ? null : <>
          {(['assignees', 'labels'] as const).map(property => <GithubEntryPropertyPicker key={property}
            property={property} overview={value} pending={false} disabledReason={null}
            feedback={null} refresh={overview.refresh} onChange={async () => {}} />)}
        </>;
      }
      let detail!: PluginUiTestkit;
      await act(async () => {
        detail = await createPluginUiTestkit({
          identity: { instanceId: name, mountNonce: `${name}-mount` },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(() => <Tabs value="overview" onValueChange={() => {}} ariaLabel={name}>
            <Tabs.Item value="overview" title="Overview"><Probe /></Tabs.Item>
          </Tabs>),
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
          handlers: { executeAction: async ({ action, input, signal }) => {
            if (typeof action === 'string' || input === undefined) throw new Error('Expected an Overview Action');
            return plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
          } },
        });
      });
      mounted.push(detail);
      return detail;
    };
    let story = await mount('story', false);
    const properties = await mount('properties', true);
    await act(async () => { await observed.get('properties')!.refresh(); });
    await vi.waitFor(async () => {
      await expect(properties.getByRole('button', { name: 'Assignees, None' })).resolves.toBeDefined();
      await expect(properties.getByRole('button', { name: 'Labels, None' })).resolves.toBeDefined();
    });
    expect(directoryReads).toBe(2);
    const openingReads = entryReads;
    const publishNativeRead = async () => {
      observationVersion++;
      if (change === 'remounted reader') {
        await act(async () => { await story.dispose(); });
        mounted.splice(mounted.indexOf(story), 1);
        story = await mount('story', false);
      } else {
        await act(async () => { await story.updateSurface(createSurfaceContextFixture()); });
      }
      await act(async () => { await properties.updateSurface(createSurfaceContextFixture()); });
    };
    // The aggregate's approved-write completion publishes a native observation.
    // A provider timestamp/head is allowed to stay unchanged across membership writes.
    assigned = true;
    await publishNativeRead();
    await vi.waitFor(() => expect(observed.get('properties')?.value).toMatchObject({
      assignees: [GITHUB_PULL_REQUEST_RESPONSE.user.login], labels: ['bug'],
    }));
    await vi.waitFor(async () => {
      await expect(properties.getByRole('button', { name: `Assignees, ${GITHUB_PULL_REQUEST_RESPONSE.user.login}` })).resolves.toBeDefined();
      await expect(properties.getByRole('button', { name: 'Labels, bug' })).resolves.toBeDefined();
    });
    assigned = false;
    await publishNativeRead();
    await vi.waitFor(async () => {
      await expect(properties.getByRole('button', { name: 'Assignees, None' })).resolves.toBeDefined();
      await expect(properties.getByRole('button', { name: 'Labels, None' })).resolves.toBeDefined();
      expect(observed.get('story')?.value).toMatchObject({ assignees: [], labels: [] });
    });
    expect(directoryReads).toBe(2);
    // Each native completion spends one existing entity read, and reparsing
    // the same publication spends none. Directory work stays opt-in.
    expect(entryReads).toBe(openingReads + 2);
    await act(async () => {
      await story.updateSurface(createSurfaceContextFixture());
      await properties.updateSurface(createSurfaceContextFixture());
    });
    expect(entryReads).toBe(openingReads + 2);
    directoryUnavailable = true;
    await act(async () => { await observed.get('properties')!.refresh(); });
    await expect(properties.queryByRole('button', { name: 'Labels, None' })).resolves.toBeUndefined();
    expect(observed.get('properties')?.value?.propertyChoices?.labels?.kind).toBe('unavailable');
  });

  it('publishes exact Overview membership rereads to mounted action readers without another provider read', async () => {
    const scope = createTriageEphemeralSharedScopeFixture();
    let assigned = false;
    let refuse = false;
    let revision = 3_000;
    let holdNext = false;
    let releaseHeld: ((response: StubHttpResponse) => void) | undefined;
    let holdChecks = false;
    let releaseChecks: ((response: StubHttpResponse) => void) | undefined;
    let reads = 0;
    const transport = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (holdChecks && path === '/graphql') {
        holdChecks = false;
        return new Promise<StubHttpResponse>((resolve) => { releaseChecks = resolve; });
      }
      if (!path.endsWith('/pulls/1284')) return undefined;
      reads++;
      if (holdNext) {
        holdNext = false;
        return new Promise<StubHttpResponse>((resolve) => { releaseHeld = resolve; });
      }
      return refuse ? { status: 503, body: { message: 'Unavailable' } } : { status: 200, body: {
        ...GITHUB_PULL_REQUEST_RESPONSE,
        assignees: assigned ? [{ ...GITHUB_PULL_REQUEST_RESPONSE.user, login: 'leeroybrun' }] : [],
        labels: assigned ? [{ id: 11, name: 'performance' }] : [],
      } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const observed = new Map<string, GithubOverviewControllerV1>();
    const mount = async (name: string, readWhenActive: boolean, entryId = '1284') => {
      function Probe() {
        const input = launchInput();
        observed.set(name, useGithubOverview({ ...input, observation: { ...input.observation,
          sourceUpdatedAtMs: revision,
          entryRef: { ...input.observation.entryRef, entryId } } }, { readWhenActive }));
        return null;
      }
      let detail!: PluginUiTestkit;
      await act(async () => {
        detail = await createPluginUiTestkit({
          identity: { instanceId: name, mountNonce: `${name}-mount` },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(() => <Tabs value="overview" onValueChange={() => {}} ariaLabel={name}>
            <Tabs.Item value="overview" title="Overview"><Probe /></Tabs.Item>
          </Tabs>),
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
          handlers: { executeAction: async ({ action, input, signal }) => {
            if (typeof action === 'string' || input === undefined) throw new Error('Expected an Overview Action');
            return plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
          } },
        });
      });
      mounted.push(detail);
      return detail;
    };
    const story = await mount('story', true);
    await vi.waitFor(() => expect(observed.get('story')).toMatchObject({ value: { assignees: [], labels: [] } }));
    const actions = await mount('actions', false);
    await mount('other-entry', false, '1285');
    expect(observed.get('actions')).toMatchObject({ value: { assignees: [], labels: [] } });
    expect(reads).toBe(1);
    assigned = true;
    await act(async () => { await observed.get('story')!.refresh(); });
    expect(observed.get('story')).toMatchObject({ value: { assignees: ['leeroybrun'], labels: ['performance'] } });
    expect(observed.get('actions')).toMatchObject({ value: { assignees: ['leeroybrun'], labels: ['performance'] } });
    expect(observed.get('other-entry')).toMatchObject({ value: null, failure: null });
    expect(reads).toBe(2);
    await act(async () => { await actions.dispose(); });
    mounted.splice(mounted.indexOf(actions), 1);
    const reopened = await mount('actions', false);
    expect(observed.get('actions')).toMatchObject({ value: { assignees: ['leeroybrun'], labels: ['performance'] } });
    expect(reads).toBe(2);
    refuse = true;
    await act(async () => { await observed.get('story')!.refresh(); });
    expect(observed.get('actions')).toMatchObject({ value: { assignees: ['leeroybrun'] }, failure: { class: 'transient' } });
    refuse = false;
    assigned = false;
    await act(async () => { await observed.get('story')!.refresh(); });
    expect(observed.get('actions')).toMatchObject({ value: { assignees: [], labels: [] }, failure: null });
    expect(reads).toBe(4);
    revision = 4_000;
    assigned = true;
    await act(async () => {
      await story.updateSurface(createSurfaceContextFixture());
      await reopened.updateSurface(createSurfaceContextFixture());
    });
    await vi.waitFor(() => expect(observed.get('actions')).toMatchObject({ value: { assignees: ['leeroybrun'], labels: ['performance'] } }));
    expect(reads).toBe(5);
    // A sibling publication cannot settle this reader's own pending Action.
    // Hold the publisher after its entity read, so the Account request owner's
    // legitimate in-flight GET join does not make the second read depend on it.
    holdChecks = true;
    let publishing!: Promise<boolean>;
    await act(async () => { publishing = observed.get('story')!.refresh(); });
    await vi.waitFor(() => expect(releaseChecks).toBeTypeOf('function'));
    holdNext = true;
    let pending!: Promise<boolean>;
    await act(async () => { pending = observed.get('actions')!.refresh(); });
    await vi.waitFor(() => expect(reads).toBe(7));
    await act(async () => {
      releaseChecks!({ status: 503, body: { message: 'Unavailable' } });
      await publishing;
    });
    expect(observed.get('actions')!.refreshing).toBe(true);
    await act(async () => {
      releaseHeld!({ status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, assignees: [], labels: [] } });
      await pending;
    });
    expect(observed.get('story')).toMatchObject({ value: { assignees: [], labels: [] }, refreshing: false });
    expect(observed.get('actions')).toMatchObject({ value: { assignees: [], labels: [] }, refreshing: false });
    expect(reads).toBe(7);
  });

  it('uses exact opening data, retains a later explicit refresh across tab mounts, and accepts a fresh reopen', async () => {
    const scope = createTriageEphemeralSharedScopeFixture();
    const input = launchInput();
    const { source: _source, ...localRef } = input.observation.entryRef;
    let body = 'First exact opening body';
    let reads = 0;
    const transport = createStubGithubTransport({ respond: request => {
      if (!new URL(request.url).pathname.endsWith('/pulls/1284')) return undefined;
      reads++;
      return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, body } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    plugins.push(plugin);
    const exact = async () => GithubOverviewResultV1Schema.parse(await plugin.invokeAction(
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
      { v: 1, instance: input.instance, localRef, routingToken: input.observation.locator.routingToken },
      { surface: 'ui' },
    ));
    let initialOverview = await exact();
    const observed: { current: GithubOverviewControllerV1 | null } = { current: null };
    const mount = async () => {
      function Probe() {
        observed.current = useGithubOverview(input, { readWhenActive: true, initialOverview });
        return <Text>{observed.current.value?.body ?? 'pending'}</Text>;
      }
      let detail!: PluginUiTestkit;
      await act(async () => {
        detail = await createPluginUiTestkit({
          identity: { instanceId: 'seeded-overview', mountNonce: `seeded-overview-${reads}` },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(() => <Tabs value="overview" onValueChange={() => {}} ariaLabel="Seeded Overview">
            <Tabs.Item value="overview" title="Overview"><Probe /></Tabs.Item>
          </Tabs>),
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
          handlers: { executeAction: async ({ action, input: request, signal }) => {
            if (typeof action === 'string' || request === undefined) throw new Error('Expected native Overview Action');
            return plugin.invokeAction(action.localId, request, { surface: 'ui', signal });
          } },
        });
      });
      mounted.push(detail);
      return detail;
    };
    const close = async (detail: PluginUiTestkit) => {
      await act(async () => { await detail.dispose(); });
      mounted.splice(mounted.indexOf(detail), 1);
    };
    const first = await mount();
    await vi.waitFor(() => expect(observed.current?.value?.body).toBe(body));
    expect(reads).toBe(1);
    body = 'Explicit fresh native body';
    await act(async () => { await observed.current!.refresh(); });
    expect(observed.current?.value?.body).toBe(body);
    expect(reads).toBe(2);
    await close(first);
    const tab = await mount();
    await vi.waitFor(() => expect(observed.current?.value?.body).toBe(body));
    expect(reads).toBe(2);
    await close(tab);
    body = 'New exact opening body';
    initialOverview = await exact();
    await mount();
    await vi.waitFor(() => expect(observed.current?.value?.body).toBe(body));
    expect(reads).toBe(3);
  });

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

  it('hands every changed file to the shared review and reads one diff only when the review asks for it', async () => {
    const { detail, transport, release } = await mountRegisteredFiles({ review: true });
    await act(async () => {
      release({
        status: 200,
        body: ['open', 'second', 'third'].map((name) => ({
          ...githubChangedFile({ filename: `src/${name}.ts` }),
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: `@@ -1 +1 @@\n-old\n+${name}-line`,
        })),
      });
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Files this pull request changes"]')).not.toBeNull(),
    );
    const filesReads = () =>
      transport.requests.filter((request) => request.url.includes('/files?'))
        .length;
    const listed = filesReads();
    for (const name of ['open', 'second', 'third']) expect(document.body.textContent).toContain(`src/${name}.ts`);
    expect(document.body.textContent).not.toContain('+open-line');
    await act(async () => {
      // The Files List row discloses its own diff (QB-72); there is no separate Open control.
      await detail.press((await detail.queryAllByRole('button')).find(button => button.name?.startsWith('src/open.ts'))!);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.body.textContent).toContain('open-line');
    });
    expect(filesReads(), 'one file asked for is one read').toBe(listed + 1);
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
