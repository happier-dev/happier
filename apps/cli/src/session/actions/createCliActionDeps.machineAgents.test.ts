import { describe, expect, it } from 'vitest';
import { ActionIdSchema, createActionExecutor } from '@happier-dev/protocol';

import { createCliActionDeps } from './createCliActionDeps';
import { createCapabilitiesService } from '@/capabilities/service';
import { createAcpAgentInventoryCapability } from '@/capabilities/registry/machineAgentsInventory';
import type { CapabilitiesDetectRequest } from '@/capabilities/types';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

const facts = {
  installed: false, version: null, latestVersion: null,
  update: { supported: false, command: null },
  signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
  platform: { supported: true },
  install: { available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: null },
  dependencies: [{ key: 'dep.antigravity.agy-acp-server', installed: true, version: '1.0' }],
} as const;

describe('CLI machine Agent inventory Action transport', () => {
  const admittedListContext = (role: 'use' | 'manage') => {
    const actionId = 'machines.agents.list';
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admitted-root', binding: {
      accountId: role === 'use' ? 'guest' : 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home-1', actionId, requestId: 'list-read',
      machineId: 'machine-1', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    return { surface: 'cli', authority: 'present_user', serverId: 'home-1', actionRequestId: 'list-read',
      machineAdmission: { actorAccountId: authorization.binding.accountId, custodianAccountId: 'owner', machineId: 'machine-1',
        installationId: 'installation', role, encryptionMode: 'plain' },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target } satisfies RpcActionExecutorContext;
  };
  it.each(['use', 'manage'] as const)('finishes both phases of an admitted %s list without requester Account credentials', async role => {
    const context = admittedListContext(role);
    const executor = createActionExecutor(createCliActionDeps({ token: '', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test', serverIdentityId: 'home-1', externalActionMachineInstallationId: 'installation',
      externalActionMachineRequestPrivateKey: new Uint8Array(64),
      // Machine RPC is the boundary; keep the real Action, inventory projector,
      // admitted local transport selection and phase mapping below it.
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async method => {
        if (method === 'daemon.extensions.contributionRegistryProjection.describe') return {
          protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
            'acme/helper': { id: 'helper', title: 'Remote Helper', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
          } },
        };
        if (method !== 'capabilities.detect') throw new Error('Unexpected Machine RPC');
        return { protocolVersion: 1, results: { 'cli.acme/helper': { ok: true, checkedAt: 1, data: facts } } };
      } },
    }));
    expect(await executor.execute('machines.agents.list', { machineId: 'machine-1', agentId: 'acme/helper' }, context)).toMatchObject({
      ok: true, result: { items: [{ agentId: 'acme/helper', title: 'Remote Helper', ...facts }] },
    });
  });

  it('reports a typed authentication refusal when an admitted local root cannot use this installation and has no network credentials', async () => {
    const executor = createActionExecutor(createCliActionDeps({ token: '', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test', serverIdentityId: 'home-1', externalActionMachineInstallationId: 'another-installation',
      externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async () => {
        throw new Error('A root for another installation cannot invoke this local Machine');
      } },
    }));
    const result = await executor.execute('machines.agents.list', { machineId: 'machine-1', agentId: 'acme/helper' },
      admittedListContext('use'));
    expect(result).toMatchObject({ ok: false, errorCode: 'not_authenticated',
      failureCause: { phase: 'dispatch', errorCode: 'not_authenticated' } });
  });

  it('observes a normalized draft through the registered remote capability without an Account catalog read', async () => {
    const service = createCapabilitiesService({ capabilities: [createAcpAgentInventoryCapability({ accountId: 'alice' })],
      checklists: { 'machine-details': [], 'new-session': [] }, buildContext: async () => ({ cliSnapshot: null }) });
    const deps = createCliActionDeps({ token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test', machineActionDirectTargetTransport: {
        machineId: 'machine-1', invoke: async (method, request) => {
          if (method !== 'capabilities.detect') throw new Error('Draft detection must not enumerate the Account or roster');
          // The untyped transport body is parsed by the real registered capability.
          return service.detect(request as CapabilitiesDetectRequest);
        },
      } });
    const observed = await deps.machinesAgentsList?.({ machineId: 'machine-1', serverId: 'home-1',
      draftDefinitions: [{ definitionId: 'draft', title: 'Draft', launch: { kind: 'command', command: process.execPath, args: [] } }],
    }, { surface: 'cli', authority: 'account_automation' });
    expect(observed).toMatchObject({ items: [{ definitionId: 'draft', installed: true, managed: false, version: null }] });
  });
  it('reads daemon facts through the complete capability request on the admitted machine', async () => {
    const calls: Array<{ method: string; request: unknown; signal?: AbortSignal }> = [];
    const signal = new AbortController().signal;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test',
      machineActionDirectTargetTransport: {
        machineId: 'machine-1',
        invoke: async (method, request, options) => {
          calls.push({ method, request, signal: options?.signal });
          if (method === 'daemon.extensions.contributionRegistryProjection.describe') {
            return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
              'acme/helper': { id: 'helper', title: 'Remote Helper', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
            } } };
          }
          return { protocolVersion: 1, results: {
            'cli.acme/helper': { ok: true, checkedAt: 1, data: { ...facts, available: false, resolvedPath: null } },
          } };
        },
      },
    }));
    const result = await executor.execute(ActionIdSchema.parse('machines.agents.list'), {
      machineId: 'machine-1', serverId: 'home-1', agentId: 'acme/helper', refresh: true,
    }, { surface: 'cli', authority: 'account_automation', signal });
    expect(result).toEqual({ ok: true, result: { items: [{ agentId: 'acme/helper', title: 'Remote Helper', ...facts }] } });
    expect(calls).toEqual([{
      method: 'daemon.extensions.contributionRegistryProjection.describe', signal,
      request: { machineId: 'machine-1', selection: 'agents' },
    }, {
      method: 'capabilities.detect', signal,
      request: { requests: [{ id: 'cli.acme/helper', params: { includeLoginStatus: true, includeLatestVersion: true } }], bypassCache: true },
    }]);
  });

  it('rejects a different Home before using the admitted transport', async () => {
    let invoked = false;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test',
      machineActionDirectTargetTransport: {
        machineId: 'machine-1', invoke: async () => { invoked = true; return {}; },
      },
    }));
    await expect(executor.execute(ActionIdSchema.parse('machines.agents.list'), {
      machineId: 'machine-1', serverId: 'home-2',
    }, { surface: 'cli', authority: 'account_automation' })).resolves.toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(invoked).toBe(false);
  });

  it('returns healthy Agents and the unavailable reason when one daemon capability is unregistered', async () => {
    const executor = createActionExecutor(createCliActionDeps({
      token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test',
      machineActionDirectTargetTransport: {
        machineId: 'machine-1',
        invoke: async (method) => {
          if (method === 'daemon.extensions.contributionRegistryProjection.describe') {
            return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
              'acme/helper': { id: 'helper', title: 'Remote Helper', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
              missing: { id: 'missing', title: 'Missing', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
            } } };
          }
          return { protocolVersion: 1, results: {
            'cli.acme/helper': { ok: true, checkedAt: 1, data: facts },
            'cli.missing': { ok: false, checkedAt: 1, error: { code: 'unknown-capability', message: 'Unknown capability' } },
          } };
        },
      },
    }));
    await expect(executor.execute(ActionIdSchema.parse('machines.agents.list'), {
      machineId: 'machine-1', serverId: 'home-1',
    }, { surface: 'cli', authority: 'account_automation' })).resolves.toEqual({ ok: true, result: {
      items: [{ agentId: 'acme/helper', title: 'Remote Helper', ...facts }],
      unavailable: [{ agentId: 'missing', reason: 'probe_failed', errorCode: 'unknown-capability' }],
      definitionCatalog: { status: 'unavailable', reason: 'not-authenticated' },
    } });
  });
});
