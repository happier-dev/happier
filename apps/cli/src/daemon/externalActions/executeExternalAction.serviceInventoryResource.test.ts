import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1, openExternalActionResponseV2,
  sealExternalActionRequestV2 } from '@happier-dev/protocol/actions';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonHostResourceRead } from '@/rpc/handlers/daemonHostResourceRead';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

describe('credential-free shared service inventory Resource', () => {
  it.each(['plain', 'e2ee'] as const)('opens the same admitted %s codec for finite and Resource reads', async mode => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(18) };
    const principal = { accountId: 'grantee', authentication: { kind: 'account' as const, tokenEpoch: 0 },
      authority: 'present_user' as const };
    const target = { kind: 'machine' as const, machineId: 'shared-machine' };
    const input = { serverId: 'home-profile', machineId: target.machineId };
    const resource = { hostRead: 'machines.services.list' as const, input };
    const snapshot = { kind: 'snapshot' as const, services: [] };
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const resourceResponse = { ok: true, resource, contentType: 'application/json',
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytesBase64: bytes.toString('base64') };
    const resourceCalls: unknown[] = [];
    let ordinaryReads = 0;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      machineServiceAction: async () => { ordinaryReads++; return snapshot; } });
    const resources = createDaemonHostResourceRead({ resolveActionExecutor: async () => executor, readAccountId: () => 'owner' });
    const run = async (kind: 'finite' | 'resource' | 'mismatched-resource' | 'wrong-recipient' | 'refused-admission') => {
      const binding = { serverIdentityId: 'srv_home', accountId: principal.accountId, authentication: principal.authentication,
        actionId: 'machines.services.list' as const, requestId: `${mode}-${kind}`, target };
      const operands = kind === 'finite' ? {} : { resourceContinuation: {
        method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
        params: { machineId: target.machineId, resource: kind === 'mismatched-resource'
          ? { ...resource, input: { ...input, machineId: 'another-machine' } } : resource },
      } };
      const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material,
        randomBytes: tweetnacl.randomBytes, ...operands,
      }) : { v: 1 as const, requestId: binding.requestId, target, input, ...operands };
      const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-home-proof', binding: {
        ...binding, custodianAccountId: 'owner', machineId: target.machineId, installationId: 'installation',
        admittedMachineRole: 'manage', accountEncryptionMode: mode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const authorization = sealManagedControllerActionCodecV1({ authorization: admitted, material,
        installationPublicKey: kind === 'wrong-recipient' ? tweetnacl.sign.keyPair().publicKey : installation.publicKey,
        randomBytes: tweetnacl.randomBytes });
      // Home signature verification and the receiving Resource RPC are genuine
      // transport boundaries. Crypto, operand binding and dispatch stay real.
      const result = await executeExternalAction({ actionId: binding.actionId, envelope, principal,
        executionAuthorization: authorization, currentMachineId: target.machineId, currentAccountId: 'owner',
        currentInstallationId: 'installation', currentServerId: input.serverId, surface: 'ui',
        externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => kind !== 'refused-admission', signal: new AbortController().signal,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'owner-not-grantee', encryption: null } }),
        executor, invokeResource: async (method, params, context) => {
          resourceCalls.push({ method, params, requester: context.callerInputAuthorization?.binding.accountId });
          const content = await resources.read(resource, target.machineId, context);
          return { ok: true, resource, contentType: 'application/json', digest: content.digest,
            bytesBase64: content.bytes.toString('base64') };
        },
      });
      const execution = result.kind !== 'response' ? null : envelope.v === 2
        ? openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope })
        : result.response.v === 1 ? result.response.execution : null;
      return { result, execution };
    };
    expect(await run('finite')).toMatchObject({ result: { kind: 'response' }, execution: { ok: true, result: snapshot } });
    expect(ordinaryReads).toBe(1);
    expect(await run('resource')).toMatchObject({ result: { kind: 'response' }, execution: { ok: true, result: resourceResponse } });
    expect(resourceCalls).toEqual([{ method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
      params: { machineId: target.machineId, resource }, requester: principal.accountId }]);
    for (const kind of ['mismatched-resource', 'wrong-recipient', 'refused-admission'] as const) {
      expect(await run(kind)).toMatchObject({ result: { kind: 'invalid_request',
        errorCode: mode === 'e2ee' ? 'invalid_encrypted_envelope' : 'invalid_envelope' } });
    }
    expect(resourceCalls).toHaveLength(1);
    expect(ordinaryReads).toBe(2);
  });
});
