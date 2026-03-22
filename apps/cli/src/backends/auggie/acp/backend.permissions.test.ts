import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import type { AgentBackend } from '@/agent/core';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createAuggieBackend } from './backend';

type BackendWithArgs = AgentBackend & { options: { args: string[] } };

const envKeys = ['PATH', 'HAPPIER_AUGGIE_PATH'] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function createFakeBin(name: string): string {
  const dir = createTempDirSync('happier-auggie-backend-');
  TEMP_DIRS.add(dir);
  const isWindows = process.platform === 'win32';
  return writeExecutableShimSync({
    dir,
    fileName: isWindows ? `${name}.cmd` : name,
    contents: isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
}

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

function getBackendArgs(permissionMode: 'read-only' | 'safe-yolo' | 'yolo'): string[] {
  process.env.PATH = '';
  process.env.HAPPIER_AUGGIE_PATH = createFakeBin('auggie');
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
  it('fails closed when the Auggie CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_AUGGIE_PATH;

    expect(() => createAuggieBackend({ cwd: '/tmp', env: {} })).toThrow(/system install/i);
  });

  it('enables --ask in read-only mode', () => {
    const args = getBackendArgs('read-only');
    expect(args).toContain('--ask');
  });

  it('resolves the CLI from options.env PATH when process PATH is empty', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_AUGGIE_PATH;
    const binPath = createFakeBin('auggie');

    const backend = createAuggieBackend({
      cwd: '/tmp',
      env: { PATH: dirname(binPath) },
    }) as unknown as { options: { command: string } };

    expect(backend.options.command).toBe(binPath);
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
