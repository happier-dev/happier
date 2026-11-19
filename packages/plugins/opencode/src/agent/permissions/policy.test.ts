import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { listHappierToolAutoApprovedNamesV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import {
  buildOpenCodePermissionEnv,
  buildOpenCodeSessionPermissionRuleset,
  buildOpenCodeSessionScopedPermissionRuleset,
  resolveOpenCodePermissionConfig,
} from './policy.js';
import { buildOpenCodeManagedLaunchEnvironment } from '../runtime/server/spawnSpec.js';

describe('OpenCode permission policy', () => {
  it('keeps explicit workspace denial above permissive permission intent', () => {
    const config = resolveOpenCodePermissionConfig('yolo', 'deny');
    expect(config.read).toBe('allow');
    for (const tool of ['edit', 'write', 'patch', 'apply_patch', 'multiedit', 'bash', 'task']) {
      expect(config[tool], tool).toBe('deny');
    }
    expect(resolveOpenCodePermissionConfig('yolo', 'allow').write).toBe('allow');
  });
  it('spawns with the composed default launch environment and retains native safe-tool approval', () => {
    const env = buildOpenCodeManagedLaunchEnvironment(undefined, 'default');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.OPENCODE_PERMISSION)'], { env, encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const policy = JSON.parse(child.stdout);
    for (const name of listHappierToolAutoApprovedNamesV1()) expect(policy[`happier_${name}`], name).toBe('allow');
    expect(policy.happier_daemon_filesystem_delete).not.toBe('allow');
    expect(policy.mcp__happier__action_execute).toBeUndefined();
  });
  it('projects MCP policies after mode rules without letting native Allow bypass live host decisions', () => {
    const rules = buildOpenCodeSessionScopedPermissionRuleset('yolo', {
      registrations: [{ originalName: 'docs__team', projectedName: 'session-docs' }],
      requiredHappierServerName: null,
    }, { docs__team: { unlisted: 'allow', tools: { search: 'allow', delete: 'off', inspect: 'ask' } } });
    expect(rules.slice(-4)).toEqual([
      { permission: 'session-docs_*', pattern: '*', action: 'ask' },
      { permission: 'session-docs_search', pattern: '*', action: 'ask' },
      { permission: 'session-docs_delete', pattern: '*', action: 'deny' },
      { permission: 'session-docs_inspect', pattern: '*', action: 'ask' },
    ]);
  });
  it('denies a native alias shared by distinct tool names', () => {
    const rules = buildOpenCodeSessionScopedPermissionRuleset('yolo', {
      registrations: [{ originalName: 'docs', projectedName: 'session-docs' }], requiredHappierServerName: null,
    }, { docs: { unlisted: 'ask', tools: { 'file.read': 'off', 'file/read': 'allow' } } });
    expect(rules.at(-1)).toEqual({ permission: 'session-docs_file_read', pattern: '*', action: 'deny' });
  });
  it('keeps native questions usable under read-only intent without permitting effects', () => {
    const config = JSON.parse(buildOpenCodeManagedLaunchEnvironment(undefined, 'read-only').OPENCODE_PERMISSION!);

    expect(config['*']).toBe('deny');
    expect(config.read).toBe('allow');
    expect(config.glob).toBe('allow');
    expect(config.question).toBe('allow');
    expect(config.edit).toBe('deny');
    expect(config.write).toBe('deny');
    expect(config.bash).toBe('deny');
    expect(config.happier_change_title).toBe('allow');
    expect(config.happier_session_title_set).toBe('allow');
    expect(config.happier_action_execute).toBe('allow');
  });

  it('promotes safe-yolo intent to allow edit aliases in the emitted session ruleset', () => {
    const ruleset = buildOpenCodeSessionPermissionRuleset('safe-yolo');
    const byPermission = new Map(ruleset.map((entry) => [entry.permission, entry.action] as const));

    expect(byPermission.get('*')).toBe('ask');
    expect(byPermission.get('read')).toBe('allow');
    expect(byPermission.get('edit')).toBe('allow');
    expect(byPermission.get('write')).toBe('allow');
    expect(byPermission.get('happier_action_execute')).toBe('allow');
  });

  it('serializes OpenCode permission env from the canonical policy', () => {
    expect(JSON.parse(buildOpenCodePermissionEnv('plan').OPENCODE_PERMISSION)).toMatchObject({
      '*': 'deny',
      read: 'allow',
      write: 'deny',
    });
  });

  it('denies other session namespaces and then restores the current mode plus exact built-in safe tools', () => {
    const rules = buildOpenCodeSessionScopedPermissionRuleset('default', {
      registrations: [
        { projectedName: 'happier-session-session-a--happier' },
        { projectedName: 'happier-session-session-a--custom' },
      ],
      requiredHappierServerName: 'happier-session-session-a--happier',
    });

    const names = listHappierToolAutoApprovedNamesV1();
    expect(rules.slice(-(3 + names.length))).toEqual([
      { permission: 'happier-session-*', pattern: '*', action: 'deny' },
      { permission: 'happier-session-session-a--happier_*', pattern: '*', action: 'ask' },
      { permission: 'happier-session-session-a--custom_*', pattern: '*', action: 'ask' },
      ...names.map((name) => ({ permission: `happier-session-session-a--happier_${name}`, pattern: '*', action: 'allow' })),
    ]);
    expect(rules).not.toContainEqual({ permission: 'happier-session-session-a--happier_daemon_filesystem_delete', pattern: '*', action: 'allow' });
  });
});
