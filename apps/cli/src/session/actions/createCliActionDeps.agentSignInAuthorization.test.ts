import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { AGENT_SIGN_IN_PREPARE_RPC_METHOD, AGENT_SIGN_IN_STATUS_RPC_METHOD,
  machineAgentSignInTerminalKey } from '@happier-dev/protocol/daemon/agentSignIn';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('CLI admitted Machine sign-in lifecycle', () => {
  for (const [operation, method] of [['start', 'native'], ['cancel', 'native'], ['restart', 'native'], ['start', 'connected']] as const) {
    it(`retains the admitted requester through ${method} ${operation} effects`, async () => {
      const actionId = ACTION_ID_FAMILIES_V1.machine_agent_sign_in.find(id => id.endsWith(`.${operation}`))!;
      const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
        bypassApprovals: true,
        actionRequestId: 'sign-in-request', externalActionTarget: { kind: 'machine', machineId: 'target' },
        externalActionExecutionAuthorization: { v: 1, token: 'home-issued-token', binding: {
          accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
          machineId: 'target', custodianAccountId: 'custodian', installationId: 'target-install', actionId,
          requestId: 'sign-in-request', requestEnvelopeDigest: 'a'.repeat(43),
          target: { kind: 'machine', machineId: 'target' },
        } },
      };
      const terminalKey = machineAgentSignInTerminalKey('target', 'fixture/agent');
      let activeTerminal: string | null = operation === 'start' ? null : 'old-terminal';
      let connectedStarted = false;
      // The Machine RPC transport is the network boundary; sign-in and its
      // terminal sequencing run through the real CLI dependency composition.
      vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
        const authorization = request.externalAction?.context.externalActionExecutionAuthorization;
        if (authorization?.token !== 'home-issued-token'
          || request.externalAction?.effectActionId !== resolveMachineRpcExternalActionEffectV1(request.method, authorization.binding)) {
          throw Object.assign(new Error('Requester admission missing'), { code: 'not_authenticated' });
        }
        if (request.method === AGENT_SIGN_IN_STATUS_RPC_METHOD) return {
          status: 'signedOut', checkedAt: 0, nativeLogin: 'login_terminal', connectedServices: [],
        };
        if (request.method === AGENT_SIGN_IN_PREPARE_RPC_METHOD && method === 'connected') return {
          method: 'connected', command: { operation: 'beginConnect', service: { pluginId: 'fixture.accounts', localId: 'login' }, modeId: 'oauth' },
        };
        if (request.method === CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) {
          connectedStarted = true;
          return { status: 'starting', attemptId: 'connect-attempt' };
        }
        if (request.method === AGENT_SIGN_IN_PREPARE_RPC_METHOD) return {
          method: 'native', launch: { kind: 'agent_login', agentId: 'fixture/agent' },
        };
        if (request.method === RPC_METHODS.DAEMON_TERMINAL_LIST) return { ok: true,
          terminals: activeTerminal ? [{ terminalId: activeTerminal, terminalKey, cwd: '/repo', ended: false, exit: null }] : [],
        };
        if (request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE) { activeTerminal = null; return { ok: true }; }
        if (request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE) {
          activeTerminal = 'new-terminal';
          return { ok: true, terminalId: activeTerminal, reused: false };
        }
        throw new Error(`Unexpected Machine method: ${request.method}`);
      });
      const deps = createCliActionDeps({ token: 'requester-token', credentials: { token: 'requester-token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        externalActionMachineInstallationId: 'source-install', externalActionMachineRequestPrivateKey: new Uint8Array(32).fill(3),
      });
      const input = { machineId: 'target', serverId: 'home', agentId: 'fixture/agent', terminalId: 'old-terminal' };
      const executor = createActionExecutor(deps);
      // Status already preserves its own admission: prove the boundary first.
      const statusContext: ActionExecutorContext = { ...context, externalActionExecutionAuthorization: {
        ...context.externalActionExecutionAuthorization!, binding: { ...context.externalActionExecutionAuthorization!.binding,
          actionId: ACTION_ID_FAMILIES_V1.machine_agent_sign_in.find(id => id.endsWith('.status'))!,
        },
      } };
      expect(await executor.execute(statusContext.externalActionExecutionAuthorization!.binding.actionId,
        { machineId: input.machineId, agentId: input.agentId }, statusContext))
        .toMatchObject({ ok: true, result: { status: 'signedOut' } });
      const result = await executor.execute(actionId, operation === 'start'
        ? { machineId: input.machineId, agentId: input.agentId, method }
        : { machineId: input.machineId, agentId: input.agentId, terminalId: input.terminalId }, context);
      expect(result).toMatchObject({ ok: true, result: method === 'connected' ? { status: 'starting', attemptId: 'connect-attempt' }
        : operation === 'cancel' ? { ok: true } : { terminalKey, terminalId: 'new-terminal' } });
      expect(activeTerminal).toBe(operation === 'cancel' || method === 'connected' ? null : 'new-terminal');
      expect(connectedStarted).toBe(method === 'connected');
    });
  }
});
