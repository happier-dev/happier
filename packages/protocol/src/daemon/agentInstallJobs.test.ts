import { describe, expect, it } from 'vitest';
import * as protocol from './agentInstallJobs.js';
import { getActionSpec } from '../actions/actionSpecs.js';

describe('agent install job wire contract', () => {
  it('requires explicit vendor consent and rejects extra authority fields', () => {
    const input = { agentId: 'plugin-agent', intent: 'install', consent: { vendorRecipe: false } };
    expect(protocol.DaemonAgentInstallStartRequestSchema.parse(input)).toEqual(input);
    expect(protocol.DaemonAgentInstallStartRequestSchema.safeParse({ ...input, consent: undefined }).success).toBe(false);
    expect(protocol.DaemonAgentInstallStartRequestSchema.safeParse({ ...input, consent: { vendorRecipe: true, dryRun: true } }).success).toBe(false);
    expect(protocol.DaemonAgentInstallStartRequestSchema.safeParse({ ...input, command: 'unsafe' }).success).toBe(false);
    const reviewed = { ...input, definitionId: 'registry-definition', expectedDefinitionVersion: '1.2.3' };
    expect(protocol.DaemonAgentInstallStartRequestSchema.parse(reviewed)).toEqual(reviewed);
    expect(protocol.DaemonAgentInstallStartRequestSchema.safeParse({ ...reviewed, expectedDefinitionVersion: '' }).success).toBe(false);
  });

  it('keeps the reviewed-version precondition private to Machine RPC admission', () => {
    const input = { machineId: 'machine', agentId: 'custom-acp', definitionId: 'registry-definition', intent: 'install', consent: { vendorRecipe: false } };
    const publicInputSchema = getActionSpec('machines.agents.install').inputSchema;
    expect(publicInputSchema.parse(input)).toEqual(input);
    expect(publicInputSchema.parse({ ...input, consent: { vendorRecipe: true } })).toEqual({ ...input, consent: { vendorRecipe: true } });
    expect(publicInputSchema.parse({ ...input, consent: undefined })).toEqual({ ...input, consent: { vendorRecipe: true } });
    expect(publicInputSchema.safeParse({ ...input, consent: null }).success).toBe(false);
    expect(publicInputSchema.safeParse({ ...input, expectedDefinitionVersion: '1.2.3' }).success).toBe(false);
  });

  it('requires a current snapshot alongside cursor replay and typed recovery', () => {
    const response = { ok: true, events: [
      { t: 'step', stepId: 'cli', label: 'Install CLI', state: 'running' },
      { t: 'progress', stepId: 'cli', bytesDone: 512, bytesTotal: null },
      { t: 'log', line: 'Downloading' },
    ], steps: [{ stepId: 'cli', label: 'Install CLI', state: 'failed' }],
    progress: [{ stepId: 'cli', bytesDone: 512, bytesTotal: null }],
    nextCursor: 3, done: true, outcome: { kind: 'failed', code: 'install_not_available', stepId: 'cli', message: 'Install manually', guideUrl: 'https://example.com/install' } };
    expect(protocol.DaemonAgentInstallReadResponseSchema.parse(response)).toEqual(response);
    expect(protocol.DaemonAgentInstallReadResponseSchema.safeParse({ ...response, steps: undefined }).success).toBe(false);
    expect(protocol.DaemonAgentInstallReadResponseSchema.safeParse({ ...response, progress: undefined }).success).toBe(false);
    expect(protocol.DaemonAgentInstallReadRequestSchema.safeParse({ jobId: 'job', cursor: -1 }).success).toBe(false);
    expect(protocol.AgentInstallJobEventSchema.safeParse({ t: 'progress', stepId: 'cli', bytesDone: -1, bytesTotal: null }).success).toBe(false);
  });
});
