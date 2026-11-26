import { randomBytes } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { projectActionOperationSnapshotForV1Reader, ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createEphemeralPluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { executeOriginalAccountCliApprovalRequest } from '@/session/actions/approvals/originalAccountRequest';
import { handleActionsCommand } from './actions';

it.each([false, true])('prints a separately held child Ask with --yes --json and returns the outer result (encrypted: %s)', async encrypted => {
  const accountId = 'requester';
  const machineId = 'machine';
  const homeId = 'srv_home';
  const requestId = 'root-request';
  const pluginId = 'acme.review';
  const localId = 'start';
  const wrapperInput = { action: { pluginId, localId }, input: {} };
  const target = { kind: 'machine' as const, machineId };
  const accountEncryption = encrypted ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } : null;
  const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    encryption: accountEncryption, credentialProvenance: 'stored_session' as const };
  const childActionId = 'scm.reviewWorkspace.materializePrepared';
  const artifactId = 'child-request';
  const socket = await createRequesterCurrentnessSocketHarness();
  const output = captureStdoutJsonOutput();
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const originalExitCode = process.exitCode;
  onTestFinished(async () => { stderr.mockRestore(); output.restore(); process.exitCode = originalExitCode; await socket.close(); });
  let pendingApproval = ApprovalRequestV2Schema.parse({
    v: 2, actionId: childActionId, actionArgs: {}, status: 'open', requestedSurface: 'cli',
    createdBy: { surface: 'cli' }, summary: 'Prepare review workspace',
    approval: { flow: 'blocking', result: 'required' }, createdAtMs: 1, updatedAtMs: 1,
    executionOriginV1: { v: 1, serverId: homeId, accountId, machineId, target, actionId: childActionId,
      requestId: 'child-origin', surface: 'cli', authority: 'present_user', caller: { kind: 'host' } },
  });
  let finish!: () => void;
  const childDecision = new Promise<void>(resolve => { finish = resolve; });
  let publish!: () => void;
  const childPublished = new Promise<void>(resolve => { publish = resolve; });
  let resolved = false;
  let attemptedDecision = false;
  let seed: PluginActionsServiceSeed | undefined;
  const host = createHostActionOperationRuntime({ serverId: homeId, machineId, resolveAccountId: async () => accountId,
    publishSnapshot: snapshot => {
      const payload = projectActionOperationSnapshotForV1Reader(snapshot);
      const content = accountEncryption ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: 'action_operation_snapshot', material: accountEncryption, payload,
        randomBytes: length => new Uint8Array(randomBytes(length)),
      }) } : { t: 'plain', v: payload };
      socket.server.emit('ephemeral', { type: ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, machineId, content });
    },
  });
  const runtime = createExternalActionRuntime('global', pluginId, async () => {
    // This fixture substitutes the child Machine effect and its independently
    // decided Artifact persistence. The contributed invocation and operation
    // ports, command parser, requester observer, and outer result are real.
    const approval = { kind: 'approval_request_created' as const, artifactId, actionId: childActionId };
    seed!.finiteOperation!.operationOwnerUpdate.update({ progress: { phase: 'waiting_for_approval', label: 'Awaiting approval', approval } });
    seed!.finiteOperation!.operationAcceptance.accept(approval);
    publish();
    await childDecision;
  }, undefined, undefined, value => { seed = value; }, undefined, 'safe', undefined, { localId, surfaces: ['cli'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } } });
  const definitions = (selection?: Parameters<typeof listRuntimeContributedActionDefinitions>[1]) =>
    listRuntimeContributedActionDefinitions(runtime, selection);
  const daemon = createCommittedContributedActionInvoker({
    acquireRuntimeRegistryLease: async () => createEphemeralPluginRuntimeRegistryLease(runtime),
    inheritedInvocation: { operationRequestId: requestId },
    observePluginExecution: host.observePluginExecution,
  });
  const reads = createActionExecutor({ approvalsGet: async ({ artifactId: id }) => id === artifactId ? pendingApproval : null,
    actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: async ({ method, payload, signal }) => method === ACTION_OPERATION_RPC_METHODS_V2.list
      ? host.handlers.listV2(payload, { signal }) : host.handlers.getV2(payload, { signal }) }),
  });
  const pending = handleActionsCommand(['invoke', 'action.invoke', '--input-json', JSON.stringify(wrapperInput),
    '--request-id', requestId, '--yes', '--json'], {
    readCredentialsFn: async () => credentials,
    getServerProfileFn: async () => { throw new Error('Fixture has no stored Home profile'); },
    createExecutorFn: params => ({
      ...createActionExecutor({ listContributedActionDefinitions: definitions,
        invokeContributedAction: args => {
          const context = { ...args.context, runtimeAccountId: accountId, serverId: homeId, serverIdentityId: homeId, externalActionTarget: target,
            actionRequestId: requestId };
          const options = { ...params, actionId: 'action.invoke', input: { action: args.action, input: args.input },
            requestId, homeId, accountId, target, token: credentials.token, serverHttpBaseUrl: socket.serverUrl,
            context, accountEncryption, onApprovalRequested: params.onApprovalRequested!,
            execute: (...values: Parameters<typeof reads.execute>) => {
              if (values[0] === 'approval.request.decide') attemptedDecision = true;
              return reads.execute(...values);
            },
            run: async (signal: AbortSignal) => {
              await expect.poll(() => socket.clients[0]?.connected).toBe(true);
              return daemon({ ...args, context: { ...context, signal }, signal });
            } };
          return executeOriginalAccountCliApprovalRequest(options).then(result => {
            if (!result) throw new Error('Expected an Account result');
            return result;
          });
        } }),
      resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); },
    }),
  }).then(() => { resolved = true; });
  const published = await Promise.race([childPublished.then(() => true), pending.then(() => false)]);
  try {
    if (!published) {
      const envelope = output.json<{ error?: { code?: string }; ok?: boolean }>();
      throw new Error(`Fixture settled before the child was published (ok=${envelope.ok}, code=${envelope.error?.code})`);
    }
    expect(await host.handlers.listV2({})).toMatchObject({ items: [{ progress: {
      phase: 'waiting_for_approval', approval: { artifactId },
    } }] });
    // Artifact creation wakes the requester; the held operation revision carries its child Ask.
    await socket.hintAccountChange();
    expect(resolved).toBe(false);
    expect(pendingApproval.status).toBe('open');
    await expect.poll(() => ({ notices: stderr.mock.calls.flatMap(([line]) => {
      try { return [JSON.parse(String(line))]; } catch { return []; }
    }) })).toMatchObject({ notices: expect.arrayContaining([expect.objectContaining({
      kind: 'actions_invoke', data: expect.objectContaining({ kind: 'approval_pending', actionId: childActionId, artifactId, requestId }),
    })]) });
  } finally {
    pendingApproval = { ...pendingApproval, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } };
    finish();
    await pending;
  }
  expect(attemptedDecision).toBe(false);
  expect(output.json()).toMatchObject({ ok: true, kind: 'actions_invoke', data: { surface: 'cli' } });
});
