import { describe, expect, it } from 'vitest';

import { parsePermissionIntentAlias } from '@happier-dev/agents';

describe('parsePermissionIntentAlias', () => {
  it('maps accept-edits alias to safe-yolo intent', () => {
    expect(parsePermissionIntentAlias('accept-edits')).toBe('safe-yolo');
    expect(parsePermissionIntentAlias('acceptEdits')).toBe('safe-yolo');
  });

  it('maps bypass-permissions alias to yolo intent', () => {
    expect(parsePermissionIntentAlias('bypass-permissions')).toBe('yolo');
    expect(parsePermissionIntentAlias('bypassPermissions')).toBe('yolo');
  });

  it('parses read-only aliases', () => {
    expect(parsePermissionIntentAlias('ro')).toBe('read-only');
    expect(parsePermissionIntentAlias('read only')).toBe('read-only');
    expect(parsePermissionIntentAlias('readonly')).toBe('read-only');
  });

  it('parses default intent aliases', () => {
    expect(parsePermissionIntentAlias('ask')).toBe('default');
    expect(parsePermissionIntentAlias('prompt')).toBe('default');
    expect(parsePermissionIntentAlias('auto')).toBe('default');
  });

  it('normalizes mixed formatting aliases', () => {
    expect(parsePermissionIntentAlias('  ACCEPT_EDITS  ')).toBe('safe-yolo');
    expect(parsePermissionIntentAlias('danger_full_access')).toBe('yolo');
    expect(parsePermissionIntentAlias('READ   ONLY')).toBe('read-only');
  });

  it('returns null for unknown or empty aliases', () => {
    expect(parsePermissionIntentAlias('')).toBe(null);
    expect(parsePermissionIntentAlias('   ')).toBe(null);
    expect(parsePermissionIntentAlias('unknown-mode')).toBe(null);
  });
});
