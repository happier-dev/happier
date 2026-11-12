import { describe, expect, it } from 'vitest';

import {
  buildMachineAgentsDetectRequest,
  MachinesAgentsListOutputSchema,
  MachineAgentInventoryUnavailableError,
  projectMachineAgentsDetectResponse,
  MachineAcpInventoryRequestSchema,
  projectAcpCatalogForMachineInventory,
} from './index.js';
import { resolveMachineAgentAcquireIntentV1, resolveMachineAgentExecutionStateV1 } from './machineAgentInventory.js';

const agents = [{ agentId: 'antigravity', title: 'Antigravity' }, { agentId: 'acme/helper', title: 'Helper' }];
const facts = {
  installed: false, version: null, latestVersion: null,
  update: { supported: false, command: null },
  signIn: { status: 'unknown', loginSupport: 'manual_only' },
  platform: { supported: false, reason: 'arch' },
  install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
  dependencies: [{ key: 'antigravity-acp', installed: true, version: '1.0' }],
} as const;

describe('machine Agent execution prerequisites', () => {
  it('acquires missing Agents and comparable updates while preserving installed unknown versions', () => {
    const installed = { installed: true, version: '1.2.3', latestVersion: '1.2.4', update: { supported: true } };
    expect(resolveMachineAgentAcquireIntentV1({ ...installed, installed: false })).toBe('install');
    expect(resolveMachineAgentAcquireIntentV1(installed)).toBe('update');
    expect(resolveMachineAgentAcquireIntentV1({ ...installed, version: '1.2.4' })).toBeNull();
    expect(resolveMachineAgentAcquireIntentV1({ ...installed, version: '1.2.3-beta.1' })).toBeNull();
    expect(resolveMachineAgentAcquireIntentV1({ ...installed, latestVersion: '1.2.4-beta.1' })).toBeNull();
    expect(resolveMachineAgentAcquireIntentV1({ ...installed, update: null })).toBeNull();
    expect(resolveMachineAgentAcquireIntentV1({ ...installed, version: null })).toBeNull();
  });

  const runnable = { installed: true, platform: { supported: true },
    fit: { kind: 'can_run', via: 'npm' }, dependencies: [] } as const;

  it('normalizes inventory lifecycle overlays without re-deciding selected authentication', () => {
    for (const inventoryState of ['ready', 'needsSignIn', 'notInstalled', 'unsupported', 'checking', 'unknown'] as const) {
      expect(resolveMachineAgentExecutionStateV1({ inventoryState })).toBe(inventoryState);
    }
    expect(resolveMachineAgentExecutionStateV1({ inventoryState: 'updateAvailable' })).toBe('ready');
    for (const inventoryState of ['installing', 'failed'] as const) {
      expect(resolveMachineAgentExecutionStateV1({ inventoryState })).toBe('notInstalled');
    }
    expect(resolveMachineAgentExecutionStateV1({ inventoryState: 'ready', known: false })).toBe('unknown');
    expect(resolveMachineAgentExecutionStateV1({ inventoryState: 'unknown', checking: true })).toBe('checking');
    expect(resolveMachineAgentExecutionStateV1({ inventoryState: 'ready', checking: true })).toBe('ready');
    expect(resolveMachineAgentExecutionStateV1({ inventoryState: 'ready', known: false, checking: true })).toBe('unknown');
  });

  it.each(['unknown', 'signedOut'] as const)('admits runnable no-login Agents with %s native status', status => {
    const signIn = { status, loginSupport: 'unsupported' } as const;
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn })).toBe('ready');
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: { status, native: signIn } })).toBe('ready');
  });

  it('preserves required sign-in and selected credential admission', () => {
    const signIn = { status: 'signedOut', loginSupport: 'unsupported', required: true } as const;
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn })).toBe('needsSignIn');
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: { status: signIn.status, native: signIn } })).toBe('needsSignIn');
    const noLogin = { status: 'unknown', loginSupport: 'unsupported' } as const;
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: noLogin, authenticationRequired: true })).toBe('unknown');
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: noLogin, credentialRouteReady: false })).toBe('unknown');
  });

  it('preserves supported and legacy login requirements', () => {
    for (const loginSupport of ['login_terminal', 'status_only', 'manual_only'] as const) {
      const signedOut = { status: 'signedOut', loginSupport } as const;
      expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: signedOut })).toBe('needsSignIn');
      expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: { ...signedOut, status: 'signedIn' } })).toBe('ready');
    }
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: { status: 'unknown' } })).toBe('unknown');
    expect(resolveMachineAgentExecutionStateV1({ ...runnable, signIn: { status: 'signedOut' } })).toBe('needsSignIn');
  });

  it('keeps executable prerequisites authoritative for no-login Agents', () => {
    const input = { ...runnable, signIn: { status: 'unknown', loginSupport: 'unsupported' } } as const;
    expect(resolveMachineAgentExecutionStateV1({ ...input, known: false })).toBe('unknown');
    expect(resolveMachineAgentExecutionStateV1({ ...input, known: false, checking: true })).toBe('checking');
    expect(resolveMachineAgentExecutionStateV1({ ...input, installed: false })).toBe('notInstalled');
    expect(resolveMachineAgentExecutionStateV1({ ...input, dependencies: [{ installed: false }] })).toBe('notInstalled');
    expect(resolveMachineAgentExecutionStateV1({ ...input, platform: { supported: false, reason: 'arch' } })).toBe('unsupported');
    expect(resolveMachineAgentExecutionStateV1({ ...input, fit: { kind: 'unknown', reason: 'arch_unknown' } })).toBe('unknown');
    expect(resolveMachineAgentExecutionStateV1({ ...input, fit: { kind: 'cant_run', reason: 'no_build_for_platform' } })).toBe('unsupported');
  });
});

describe('machine Agent inventory projection', () => {
  it('preserves native member install scope while accepting existing machine inventory facts', () => {
    const project = (install: unknown) => projectMachineAgentsDetectResponse({ agents: agents.slice(1), response: {
      protocolVersion: 1, results: { 'cli.acme/helper': { ok: true, checkedAt: 2, data: { ...facts, install } } },
    } });
    const member = project({ ...facts.install, available: true, mode: 'vendor_recipe', executionScope: 'member' });
    expect(member).toMatchObject({ items: [{ install: { executionScope: 'member', available: true, mode: 'vendor_recipe' } }] });
    expect(MachinesAgentsListOutputSchema.parse(member)).toEqual(member);
    expect(project(facts.install).items[0]?.install).toEqual(facts.install);
    expect(project({ ...facts.install, executionScope: 'machine' }).items[0]?.install).toMatchObject({ executionScope: 'machine' });
    expect(project({ ...facts.install, executionScope: 'unknown' }).unavailable).toEqual([
      { agentId: 'acme/helper', reason: 'invalid_facts' },
    ]);
  });

  it('preserves explicit optional authentication without inventing a signed-in status', () => {
    const signIn = { status: 'unknown' as const, loginSupport: 'unsupported' as const, required: false };
    const item = { ...agents[1], ...facts, installed: true, signIn };
    const output = projectMachineAgentsDetectResponse({ agents: agents.slice(1), response: { protocolVersion: 1,
      results: { 'cli.acme/helper': { ok: true, checkedAt: 2, data: item } },
    } });
    expect(output).toEqual({ items: [item] });
    expect(MachinesAgentsListOutputSchema.parse(output)).toEqual(output);
    expect(MachinesAgentsListOutputSchema.parse({ items: [{ ...item, signIn: facts.signIn }] }).items[0].signIn)
      .toEqual(facts.signIn);
    for (const invalid of [{ ...signIn, required: 'false' }, { ...signIn, unexpected: true }]) {
      expect(MachinesAgentsListOutputSchema.safeParse({ items: [{ ...item, signIn: invalid }] }).success).toBe(false);
    }
  });
  it('rejects secret-bearing requests and unsolicited or mismatched definition responses', () => {
    const definition = { definitionId: 'first', title: 'Caller title', launch: { kind: 'npm' as const, package: 'fixture', version: '1', args: [] } };
    expect(MachineAcpInventoryRequestSchema.safeParse({ definitions: [{ ...definition, env: { TOKEN: 'private' } }] }).success).toBe(false);
    expect(MachineAcpInventoryRequestSchema.safeParse({ definitions: [{ ...definition, launch: { kind: 'command', command: 'npx', args: [], env: { TOKEN: 'private' } } }] }).success).toBe(false);
    for (const invalid of [{ definitionId: 'foreign', title: definition.title }, { definitionId: 'first', title: 'Custodian private title' }]) {
      const output = projectMachineAgentsDetectResponse({ agents: [], definitions: [definition], response: { protocolVersion: 1,
        results: { 'tool.acpAgentInventory': { ok: true, checkedAt: 2, data: { items: [{ ...facts, ...invalid,
          agentId: 'happier.agent.custom-acp/custom-acp', managed: true, fit: { kind: 'can_run', via: 'npm' } }] } } } } });
      expect(output.items).toEqual([]);
      expect(output.unavailable).toEqual([{ agentId: 'happier.agent.custom-acp/custom-acp', definitionId: 'first', reason: 'invalid_facts' }]);
      expect(JSON.stringify(output)).not.toContain('Custodian');
    }
    expect(projectAcpCatalogForMachineInventory({ status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions: [] }, diagnostics: [] }))
      .toEqual({ definitions: [], definitionCatalog: { status: 'unavailable', reason: 'incomplete-inventory' } });
  });
  it('requests definition inventory from only the caller catalog and preserves distinct definition rows', () => {
    const definitions = ['first', 'second'].map(definitionId => ({ definitionId, title: definitionId,
      launch: { kind: 'npm' as const, package: 'acp-fixture', version: '1.0', args: [] } }));
    expect(buildMachineAgentsDetectRequest({ agents: [], definitions }).requests).toEqual([
      { id: 'tool.acpAgentInventory', params: { definitions } },
    ]);
    // 01F: current configured rows carry the actual qualified contribution, never a host fallback identity.
    const items = definitions.map(({ definitionId, title }) => ({ ...facts, agentId: 'happier.agent.custom-acp/custom-acp', definitionId, title,
      installed: true, managed: true, version: '1.0', fit: { kind: 'can_run', via: 'npm' } }));
    expect(projectMachineAgentsDetectResponse({ agents: [], definitions,
      response: { protocolVersion: 1, results: { 'tool.acpAgentInventory': { ok: true, checkedAt: 2, data: { items } } } },
    })).toEqual({ items });
  });

  it('marks a failed definition read unavailable instead of withdrawing its known definition', () => {
    const definitions = [{ definitionId: 'first', title: 'First', launch: { kind: 'npm' as const, package: 'fixture', version: '1', args: [] } }];
    expect(projectMachineAgentsDetectResponse({ agents: [], definitions,
      response: { protocolVersion: 1, results: { 'tool.acpAgentInventory': { ok: false, checkedAt: 2, error: { code: 'catalog-unavailable' } } } },
    })).toEqual({ items: [], unavailable: [{ agentId: 'happier.agent.custom-acp/custom-acp', definitionId: 'first', reason: 'probe_failed', errorCode: 'catalog-unavailable' }] });
  });
  it('requests complete native status and latest versions for every registry Agent', () => {
    expect(buildMachineAgentsDetectRequest({ agents, refresh: true })).toEqual({
      requests: agents.map(({ agentId }) => ({ id: `cli.${agentId}`, params: { includeLoginStatus: true, includeLatestVersion: true } })),
      bypassCache: true,
    });
    expect(buildMachineAgentsDetectRequest({ agents })).not.toHaveProperty('bypassCache');
  });

  it('preserves own CLI absence independently of installed dependencies and strips legacy probe metadata', () => {
    expect(projectMachineAgentsDetectResponse({
      agents: agents.slice(0, 1),
      response: { protocolVersion: 1, results: {
        'cli.antigravity': { ok: true, checkedAt: 1, data: {
          ...facts, available: true, resolvedPath: '/private/path', authStatus: { state: 'logged_in' }, installSource: 'system',
        } },
      } },
    })).toEqual({ items: [{ agentId: 'antigravity', title: 'Antigravity', ...facts }] });
  });

  it.each([
    { result: undefined, reason: 'missing_result', errorCode: undefined },
    { result: { ok: false, checkedAt: 1, error: { code: 'unknown-capability', message: 'Unknown capability' } }, reason: 'probe_failed', errorCode: 'unknown-capability' },
    { result: { ok: true, checkedAt: 1 }, reason: 'invalid_facts', errorCode: undefined },
    { result: { ok: true, checkedAt: 1, data: { available: true } }, reason: 'invalid_facts', errorCode: undefined },
    { result: { ok: true, checkedAt: 1, data: { ...facts, installed: 'true' } }, reason: 'invalid_facts', errorCode: undefined },
  ])('isolates $reason without manufacturing facts or losing another Agent', ({ result, reason, errorCode }) => {
    const ready = { ...facts, installed: true, platform: { supported: true }, dependencies: [] };
    const output = projectMachineAgentsDetectResponse({ agents, response: { protocolVersion: 1, results: {
      'cli.antigravity': result, 'cli.acme/helper': { ok: true, checkedAt: 2, data: ready },
    } } });
    expect(output).toEqual({
      items: [{ ...agents[1], ...ready }],
      unavailable: [{ agentId: 'antigravity', reason, ...(errorCode ? { errorCode } : {}) }],
    });
    expect(MachinesAgentsListOutputSchema.parse(output)).toEqual(output);
  });

  it('still rejects an unavailable whole-response envelope', () => {
    for (const response of [null, [], {}, { protocolVersion: 2, results: {} }, { protocolVersion: 1, results: [] }]) {
      expect(() => projectMachineAgentsDetectResponse({ agents, response })).toThrow(MachineAgentInventoryUnavailableError);
    }
  });
});
