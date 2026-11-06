import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext } from '@/api/rpc/types';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createCliMachineActionTransport } from './machineTransport';
import type { MachineActionDirectTargetTransport } from '../createCliActionDeps';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AGENT_SIGN_IN_STATUS_RPC_METHOD } from '@happier-dev/protocol/daemon/agentSignIn';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

afterEach(() => vi.restoreAllMocks());

describe('Machine capability observation during unsigned approval replay', () => {
  it.each([
    ['machines.agents.list', RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, true],
    ['machines.agents.list', RPC_METHODS.CAPABILITIES_DETECT, true],
    ['machines.agents.signIn.status', AGENT_SIGN_IN_STATUS_RPC_METHOD, true],
    ['machines.command.run', RPC_METHODS.BASH, true],
    ['machines.agents.list', 'undeclared.fixture.read', false],
  ] as const)('spends the admitted %s root only on its declared method %s', async (actionId, method, local) => {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
      accountId: 'guest', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId, requestId: 'root-read',
      machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionRequestId: 'root-read',
      machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target } satisfies RpcActionExecutorContext;
    // Only the installed Machine RPC boundary is substituted. Root classification
    // and private admission/identity propagation use the real transport.
    const invoke = vi.fn<MachineActionDirectTargetTransport['invoke']>(async (_method, _request, options) => ({
      role: options?.rpcContext?.machineAdmission?.role,
      actor: options?.rpcContext?.machineAdmission?.actorAccountId,
    }));
    const transport = createCliMachineActionTransport({ serverId: 'home', serverIdentityId: 'home',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine', invoke } });
    const result = transport.callMachineAction({ machineId: 'machine', method, effectActionId: actionId, request: {}, context });
    if (local) await expect(result).resolves.toEqual({ role: 'use', actor: 'guest' });
    else {
      await expect(result).rejects.toMatchObject({ rpcErrorCode: 'not_authenticated' });
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it.each([RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES, RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY])('keeps native credential %s on authenticated Machine ingress', async method => {
      const local = vi.fn<MachineActionDirectTargetTransport['invoke']>();
      const admitted = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'unavailable', code: 'permission_denied' });
      const transport = createCliMachineActionTransport({
        credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
        serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: local },
      });
      expect(await transport.callMachineAction({ machineId: 'machine', method, request: {} }))
        .toEqual({ status: 'unavailable', code: 'permission_denied' });
      expect(local).not.toHaveBeenCalled();
      expect(admitted).toHaveBeenCalledOnce();
    });
  it.each(['current', 'foreign_requester'] as const)(
    'uses receiving Home admission rather than an unadmitted local hop (%s)', async control => {
      const admission = createFilesystemEffectAdmission({
        resolveHomeServerIdentityId: async () => 'srv_home',
        resolveHostIdentity: async () => ({ custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' }),
      });
      const ingress: RpcHandlerContext = {
        signal: new AbortController().signal,
        callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: control === 'foreign_requester' ? 'member' : 'owner',
          custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => !ingress.signal.aborted,
      };
      const observed = { results: { 'tool.executionRuns': { ok: true, data: { backends: {}, features: {} } } } };
      // Only the authenticated RPC boundary is substituted. Its native-effect
      // admission is the real owner, including local cancellation and Account identity.
      const detect = async (context?: RpcHandlerContext) => {
        const refused = await admission.rpc(context);
        if (refused) throw new RpcError(refused.error, refused.errorCode);
        return observed;
      };
      const homeRead = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async () => detect(ingress));
      const localRead = vi.fn<MachineActionDirectTargetTransport['invoke']>(async (_method, _request, options) => detect(options?.rpcContext
        ? { ...options.rpcContext, signal: options.signal ?? ingress.signal } : undefined));
      const transport = createCliMachineActionTransport({
        credentials: { token: 'fixture-owner', encryption: null, credentialProvenance: 'stored_session' },
        serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: localRead },
      });
      const read = transport.callMachineAction({ machineId: 'machine', method: RPC_METHODS.CAPABILITIES_DETECT,
        request: { requests: [{ id: 'tool.executionRuns' }] } });
      if (control === 'current') await expect(read).resolves.toEqual(observed);
      else await expect(read).rejects.toMatchObject({ rpcErrorCode: 'filesystem_identity_custody_unavailable' });
      expect(homeRead).toHaveBeenCalledOnce();
      expect(localRead).not.toHaveBeenCalled();
    },
  );
});
