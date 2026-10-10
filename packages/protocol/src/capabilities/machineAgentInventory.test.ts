import { describe, expect, it } from 'vitest';

import {
  buildMachineAgentsDetectRequest,
  MachinesAgentsListOutputSchema,
  MachineAgentInventoryUnavailableError,
  projectMachineAgentsDetectResponse,
} from './index.js';

const agents = [{ agentId: 'antigravity', title: 'Antigravity' }, { agentId: 'acme/helper', title: 'Helper' }];
const facts = {
  installed: false, version: null, latestVersion: null,
  update: { supported: false, command: null },
  signIn: { status: 'unknown', loginSupport: 'manual_only' },
  platform: { supported: false, reason: 'arch' },
  install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
  dependencies: [{ key: 'antigravity-acp', installed: true, version: '1.0' }],
} as const;

describe('machine Agent inventory projection', () => {
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
