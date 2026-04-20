import { describe, expect, it } from 'vitest';

import {
  isPermissionGuardToolName,
  isSharedHappierShellBridgeToolName,
  isSharedPermissionSafeToolName,
} from './permissionTaxonomy';

describe('permissionTaxonomy', () => {
  it('recognizes shared safe tools without substring collisions', () => {
    expect(isSharedPermissionSafeToolName('think')).toBe(true);
    expect(isSharedPermissionSafeToolName('session_title_set')).toBe(true);
    expect(isSharedPermissionSafeToolName('save_memory')).toBe(true);
    expect(isSharedPermissionSafeToolName('mcp__happier__change_title')).toBe(true);
    expect(isSharedPermissionSafeToolName('think_malware')).toBe(false);
  });

  it('recognizes safer shell-bridge tool aliases through the shared owner', () => {
    expect(isSharedHappierShellBridgeToolName('change_title')).toBe(true);
    expect(isSharedHappierShellBridgeToolName('save_memory')).toBe(true);
    expect(isSharedHappierShellBridgeToolName('bash')).toBe(false);
  });

  it('recognizes guard tools independently from write-like heuristics', () => {
    expect(isPermissionGuardToolName('external_directory')).toBe(true);
    expect(isPermissionGuardToolName('doom_loop')).toBe(true);
    expect(isPermissionGuardToolName('bash')).toBe(false);
  });
});
