import { describe, expect, it } from 'vitest';
import { ActionIdSchema, createActionExecutor } from '@happier-dev/protocol';

import { createCliActionDeps } from './createCliActionDeps';

const facts = {
  installed: false, version: null, latestVersion: null,
  update: { supported: false, command: null },
  signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
  platform: { supported: true },
  install: { available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: null },
  dependencies: [{ key: 'dep.antigravity.agy-acp-server', installed: true, version: '1.0' }],
} as const;

describe('CLI machine Agent inventory Action transport', () => {
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
    } });
  });
});
