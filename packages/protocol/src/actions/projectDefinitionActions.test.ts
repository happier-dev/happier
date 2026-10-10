import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' };

describe('project definition Actions', () => {
  it('admits exact qualified inspection and a strict guarded write while retaining document bytes as data', () => {
    const inspect = getActionSpec('projects.inspect');
    expect(inspect).toBeDefined();
    expect(inspect.inputSchema.safeParse({ workspace }).success).toBe(true);
    expect(inspect.inputSchema.safeParse({ workspace: { ...workspace, accountId: 'forged' } }).success).toBe(false);
    const update = getActionSpec('projects.manifest.update');
    expect(update).toBeDefined();
    expect(update.inputSchema.safeParse({ workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1,"future":true}' }).success).toBe(true);
    expect(update.inputSchema.safeParse({ workspace, bytes: '{"version":1}' }).success).toBe(false);
    expect(update.inputSchema.safeParse({ workspace, expectedBasis: { kind: 'absent' }, bytes: '{}', bypass: true }).success).toBe(false);
  });

  it('exposes inspection on every surface and defaults edits to configurable Ask first', () => {
    const inspect = getActionSpec('projects.inspect');
    const update = getActionSpec('projects.manifest.update');
    expect(inspect.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true });
    expect(inspect.cli?.commands[0]?.path).toEqual(['project', 'inspect']);
    expect(update.cli?.commands[0]?.path).toEqual(['project', 'manifest', 'update']);
    expect(update.safety).toBe('danger');
    expect(isApprovalRequiredByActionsSettings('projects.manifest.update', { v: 1, actions: {} }, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings('projects.manifest.update', { v: 1, actions: {} }, { surface: 'ui', authority: 'present_user' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings('projects.manifest.update', { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.manifest.update': ['ui'] } }, { surface: 'ui', authority: 'present_user' })).toBe(false);
  });
});
