import { expect, it } from 'vitest';
import { createActionExecutor, TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { GITHUB_PLUGIN, GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { closeGithubPullRequestAction } from '../../../../../packages/plugins/scm-github/src/triage/mutationOperations';
import { configuredInstance, PULL_REQUEST_REF, pullRequestBody, json, REPOSITORY_KEY, REPOSITORY_PATH, CONFIGURED_ACCOUNT } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubMutation.test-support';
import { createStubGithubTransport, readRecordedJsonBody } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { GITHUB_REPOSITORY_RESPONSE } from '../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { createTriageReadEntryDetailActionHandler } from '../../../../../packages/plugins/triage/src/actions/readEntryDetail';
import { createConfiguredTaskSourceStorage } from '../../../../../packages/plugins/triage/src/corpus/testkit/taskWrites.test-support';
import { createExternalActionRuntime } from './externalActionRuntime.testkit';

it('guides an MCP caller from a PR detail read through one approved close', async () => {
  const localId = GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose;
  const pluginId = GITHUB_PLUGIN.manifest.id;
  const action = { pluginId, localId };
  const actionId = formatQualifiedPluginActionId(action);
  const declaration = GITHUB_PLUGIN.manifest.contributes.actions?.find(item => item.id === localId);
  if (!declaration?.inputSchema) throw new Error('Missing GitHub Close declaration');
  const configured = configuredInstance();
  const { source } = configured.instance;
  const localRef = { ...PULL_REQUEST_REF, entryId: '119' };
  const entryRef = { ...localRef, source };
  // Account collections and the admitted source snapshot cross process boundaries.
  const detailContext = { surface: 'mcp', signal: new AbortController().signal, services: {
    storage: createConfiguredTaskSourceStorage(configured),
    actions: { executeAdmittedTargetedOperation: async () => ({ kind: 'complete', links: [] }) },
    targetedContributions: { observeForSelf: () => ({
      readCurrent: async () => ({ contributions: [{
        contributor: { pluginId, contributionId: source.localId }, descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
        operations: { readSessionLinks: { role: 'readSessionLinks' }, linkSession: { role: 'linkSession' } },
      }] }),
      dispose: () => {},
    }) },
  } } as unknown as PluginAccountActionContext;
  const detail = await createTriageReadEntryDetailActionHandler()({
    v: 1, entryRef, sourceInstanceId: configured.instance.sourceInstanceId,
  }, detailContext);
  if (detail.kind !== 'read') throw new Error('The fixture PR must be readable');
  const input = { v: 1, localRef, routingToken: REPOSITORY_KEY, instance: detail.instance };

  let state: 'open' | 'closed' = 'open';
  const stub = createStubGithubTransport({ binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: CONFIGURED_ACCOUNT }, respond: request => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
    if (path !== `${REPOSITORY_PATH}/pulls/119`) return json({}, 404);
    if (request.method === 'PATCH') state = 'closed';
    return json({ ...pullRequestBody({ state }), number: 119 });
  } });
  const calls: unknown[] = [];
  const runtime = createExternalActionRuntime('global', pluginId, async () => {
    expect(await closeGithubPullRequestAction(calls.at(-1), stub.context)).toMatchObject({ kind: 'applied', effect: 'changed' });
  }, undefined, undefined, undefined, undefined,
    'writesRemote', undefined, { localId, surfaces: ['mcp'], inputSchema: declaration.inputSchema, executionTarget: 'account',
      inputHints: declaration.inputHints, confirmation: declaration.confirmation, confirmationWhen: declaration.confirmationWhen,
      onInput: value => calls.push(value) });
  const { resolveCurrentPluginApprovalReplayPlacement: _daemonReplay, ...accountRuntime } = runtime;
  const lease: PluginRuntimeRegistryLease = {
    registry: { ...accountRuntime, revalidateAccountExecution: async () => true },
    source: 'committed', durableRevision: 1, release: async () => {},
  };
  const acquireRuntimeRegistryLease = async () => lease;
  let stored: TargetActionApprovalRequestV1 | null = null;
  const read = async () => stored;
  const artifactId = 'mcp-close-approval';
  const controller = new AbortController();
  const created = Promise.withResolvers<void>();
  const update = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
    if (!stored) throw new Error('Missing approval');
    const transition = admitTargetActionApprovalTransition(stored, request);
    if (!transition.ok) return transition;
    stored = TargetActionApprovalRequestV1Schema.parse(request);
    return { ok: true as const };
  };
  const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease,
    requestCurrentIntent: createTargetActionCurrentIntentAdapter({
      create: async (request, onReady) => {
        stored = request;
        onReady?.({ artifactId, request });
        created.resolve();
        return { artifactId };
      },
      read, update,
    }),
  });
  const listDefinitions = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
  const executor = createActionExecutor({
    listContributedActionDefinitions: listDefinitions,
    readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions),
    invokeContributedAction: invoke, approvalsGet: read,
    targetActionApprovalReplay: createTargetActionApprovalDecision({ read, update }),
  });
  const context = { surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' },
    serverId: 'server-external', serverIdentityId: 'srv_home', runtimeAccountId: 'account-1',
    executionRunTargetMachineId: 'machine-local', signal: controller.signal } as const;
  try {
    const spec = await executor.execute('action.spec.get', { id: actionId }, context);
    expect(spec).toMatchObject({ ok: true, result: { actionSpec: { inputHints: {
      fields: expect.arrayContaining([expect.objectContaining({
        path: 'instance', description: expect.stringContaining('happier.triage/actions/entries/read-detail-v1'),
      })]),
    } } } });
    for (const { instance, path } of [
      { instance: null, path: ['instance'] },
      { instance: { ...detail.instance, v: 2 }, path: ['instance', 'v'] },
    ]) {
      const invalid = await executor.execute('action.invoke', { action, input: { ...input, instance } }, context);
      expect(invalid).toMatchObject({ ok: false, errorCode: 'plugin_action_input_schema_invalid',
        details: { issues: [expect.objectContaining({ path,
          message: expect.stringContaining('happier.triage/actions/entries/read-detail-v1') })] } });
    }
    expect(stored).toBeNull();
    expect(calls).toEqual([]);
    expect(stub.requests).toEqual([]);

    const pending = executor.execute('action.invoke', { action, input }, context);
    await Promise.race([created.promise, pending.then(result => {
      throw new Error(`Close settled before requesting approval: ${JSON.stringify(result)}`);
    })]);
    expect(await read()).toMatchObject({ status: 'open', requestedSurface: 'mcp', approvalInputCustody: 'live_only' });
    expect(calls).toEqual([]);
    expect(stub.requests).toEqual([]);
    const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account-1' });
    const decision = await decide();
    if (!decision.ok) throw new Error(`Close approval was refused: ${JSON.stringify(decision)}`);
    const result = await pending;
    if (!result.ok) throw new Error(`Approved close failed: ${JSON.stringify(result)}`);
    await expect(decide()).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(calls).toEqual([input]);
    expect(stub.requests.filter(request => request.method === 'PATCH').map(readRecordedJsonBody)).toEqual([{ state: 'closed' }]);
  } finally {
    controller.abort();
    await runtime.dispose();
  }
});
