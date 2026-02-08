import { describe, expect, it } from 'vitest';

import type { AgentBackend } from '@/agent/core';
import { createAuggieBackend } from './backend';

type BackendWithArgs = AgentBackend & { options: { args: string[] } };

function getBackendArgs(permissionMode: 'read-only' | 'safe-yolo' | 'yolo'): string[] {
  const backend = createAuggieBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  });
  return (backend as unknown as BackendWithArgs).options.args;
}

function getPermissionRules(args: string[]): string[] {
  const rules: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--permission') continue;
    const value = args[i + 1];
    if (typeof value === 'string') rules.push(value);
  }
  return rules;
}

describe('Auggie ACP backend permissions', () => {
  it('enables --ask in read-only mode', () => {
    const args = getBackendArgs('read-only');
    expect(args).toContain('--ask');
  });

  it('allows all tools in yolo mode via explicit --permission rules', () => {
    const args = getBackendArgs('yolo');
    const rules = getPermissionRules(args);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).toContain('launch-process:allow');
    expect(rules).toContain('save-file:allow');
    expect(rules).toContain('apply_patch:allow');
  });

  it('allows editing tools in safe-yolo mode via explicit --permission rules', () => {
    const args = getBackendArgs('safe-yolo');
    const rules = getPermissionRules(args);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).toContain('save-file:allow');
    expect(rules).toContain('apply_patch:allow');
    expect(rules).toContain('launch-process:ask-user');
  });
});
