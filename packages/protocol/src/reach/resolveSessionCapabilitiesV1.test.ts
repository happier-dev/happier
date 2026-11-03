import { describe, expect, it } from 'vitest';
import { resolveSessionCapabilitiesV1 } from './resolveSessionCapabilitiesV1.js';
import type { ReachContextV1 } from './resolveReachV1.js';
import type { McpServersSettingsV1 } from '../mcp/servers/settingsV1.js';

const context: ReachContextV1 = { machineId: 'm', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' };
const server = { id: 's', name: 'server', transport: 'stdio' as const, stdio: { command: 'server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 };
const settings: McpServersSettingsV1 = { v: 1, strictMode: false, servers: [server], bindings: [{ id: 'r', serverId: 's', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1 }] };

describe('resolveSessionCapabilitiesV1', () => {
  it('reports a disabled first-party feature as managed off rather than a portability failure', () => {
    const result = resolveSessionCapabilitiesV1({ context, mcp: null, agentAcceptsUserMcp: true,
      skills: { items: [{ skillId: 'happier:deploy', name: 'deploy' }], rules: [] },
      isFeatureEnabled: () => false, selection: { skills: { v: 1, forceIncludeSkillIds: ['happier:deploy'],
        forceExcludeSkillIds: [], excludeNativeSkillNames: [] } } });
    expect(result.skills.items[0]).toMatchObject({ selected: false, selectable: false, reason: 'managed_off' });
  });
  it('resolves MCP and skills through the same session level with exclude winning', () => {
    const result = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: { items: [{ skillId: 'lint', name: 'lint' }], rules: [] }, selection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['s'], forceExcludeServerIds: [] }, skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native'] } }, agentAcceptsUserMcp: true });
    expect(result.mcp.items[0]).toMatchObject({ selected: true, reason: 'session_added', sessionOverride: 'added', decidedBy: { ruleId: 'r' } });
    expect(result.skills.items).toEqual([{ kind: 'skill', id: 'lint', name: 'lint', selected: true, selectable: true, reason: 'session_added', sessionOverride: 'added', decidedBy: null }]);
    expect(result.skills.excludeNativeSkillNames).toEqual(['native']);
    const excluded = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: { items: [{ skillId: 'lint', name: 'lint' }], rules: [] }, selection: { skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: ['lint'], excludeNativeSkillNames: [] } }, agentAcceptsUserMcp: true });
    expect(excluded.skills.items[0]).toMatchObject({ selected: false, reason: 'session_removed', sessionOverride: 'removed' });
  });
  it('reports an unsupported Agent even for a session-forced MCP server', () => {
    const result = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: null, selection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['s'], forceExcludeServerIds: [] } }, agentAcceptsUserMcp: false });
    expect(result.mcp.items[0]).toMatchObject({ selected: false, selectable: false, reason: 'agent_unsupported' });
  });
  it('allows a session include over managed Off', () => {
    const portable = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: null, selection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['s'], forceExcludeServerIds: [] } }, agentAcceptsUserMcp: true });
    expect(portable.mcp.items[0]).toMatchObject({ selected: true, reason: 'session_added' });
  });
  it.each([
    { bindings: [] },
    { bindings: [{ ...settings.bindings[0]!, target: { t: 'machine' as const, machineId: 'elsewhere' } }] },
    { bindings: [{ ...settings.bindings[0]!, agentId: 'gemini' }] },
  ])('admits explicit Session includes regardless of default rules %j', ({ bindings }) => {
    const input = { context, mcp: { ...settings, bindings }, skills: null, agentAcceptsUserMcp: true };
    expect(resolveSessionCapabilitiesV1({ ...input, selection: {} }).mcp.items[0])
      .toMatchObject({ selected: false, selectable: true, reason: 'no_rule' });
    expect(resolveSessionCapabilitiesV1({ ...input, selection: { mcp: { v: 1, managedServersEnabled: true,
      forceIncludeServerIds: ['s'], forceExcludeServerIds: [] } } }).mcp.items[0])
      .toMatchObject({ selected: true, selectable: true, reason: 'session_added', sessionOverride: 'added' });
  });
});
