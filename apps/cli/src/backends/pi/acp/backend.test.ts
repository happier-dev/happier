import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { buildPiRpcArgs, buildPiToolsForPermissionMode, createPiBackend } from './backend';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  PI_BROKER_SELECTIONS_ENV,
  resolvePiBrokerExtensionPath,
  serializePiBrokerSelections,
} from '@/backends/pi/brokerExtension';

const envKeys = ['PATH', 'HAPPIER_PI_PATH', HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function readBackendArgs(backend: unknown): readonly string[] {
  if (!backend || typeof backend !== 'object' || !('options' in backend)) return [];
  const options = (backend as { options?: unknown }).options;
  if (!options || typeof options !== 'object' || !('args' in options)) return [];
  const args = (options as { args?: unknown }).args;
  return Array.isArray(args) && args.every((arg) => typeof arg === 'string') ? args : [];
}

function createFakeBin(name: string): string {
  const dir = createTempDirSync('happier-pi-backend-');
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

describe('pi backend argv', () => {
  it('fails closed when the Pi CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_PI_PATH;

    expect(() => createPiBackend({ cwd: '/tmp', env: {} })).toThrow(/system install/i);
  });

  it('adds --thinking when HAPPIER_PI_THINKING_LEVEL is set', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');
    const backend = createPiBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'high' },
      permissionMode: 'default',
    });

    const args = readBackendArgs(backend);
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
  });

  it('ignores invalid thinking levels', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');
    const backend = createPiBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'definitely-not-valid' },
      permissionMode: 'default',
    });

    const args = readBackendArgs(backend);
    expect(args).not.toContain('--thinking');
  });

  it('passes the Happier session id into the Pi RPC backend options', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
    }) as unknown as { options?: { happierSessionId?: string | null } };

    expect(backend.options?.happierSessionId).toBe('happy-session-1');
  });

  it('resolves the CLI from options.env PATH when process PATH is empty', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_PI_PATH;
    const binPath = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: { PATH: dirname(binPath) },
      permissionMode: 'default',
    }) as unknown as { options?: { command?: string } };

    expect(backend.options?.command).toBe(binPath);
  });

  it('uses the active connected-service provider with a concrete Pi startup model and scoped model cycle', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-work' },
        ]),
      },
      permissionMode: 'default',
    }) as unknown as { options?: { args?: string[] } };

    const args = backend.options?.args;
    expect(args).toEqual(expect.arrayContaining([
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.5',
      '--models',
      'openai-codex/*',
    ]));
    const modelIndex = args?.indexOf('--model') ?? -1;
    expect(args?.[modelIndex + 1]).not.toBe('openai-codex/*');
  });

  it('passes the broker extension path when launching a brokered connected-service provider', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');
    const agentDir = createTempDirSync('happier-pi-agent-dir-');
    TEMP_DIRS.add(agentDir);

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-work' },
        ]),
        [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
          openai: {
            serviceId: 'openai-codex',
            profileId: 'codex-work',
            accountId: 'acct_1',
            planType: 'pro',
          },
        }),
      },
      permissionMode: 'default',
    }) as unknown as { options?: { args?: string[] } };

    expect(backend.options?.args).toEqual(expect.arrayContaining([
      '--extension',
      resolvePiBrokerExtensionPath(agentDir),
    ]));
  });

  it('forwards appendSystemPromptText as --append-system-prompt', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      appendSystemPromptText: 'CLAUDE_PATTERN_PROMPT',
    });

    const args = readBackendArgs(backend);
    const flagIndex = args.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe('CLAUDE_PATTERN_PROMPT');
  });

  it('omits --append-system-prompt when appendSystemPromptText is blank', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      appendSystemPromptText: '   ',
    });

    const args = readBackendArgs(backend);
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('buildPiRpcArgs', () => {
  it('includes --append-system-prompt when appendSystemPromptText is provided', () => {
    const args = buildPiRpcArgs({ appendSystemPromptText: 'extra instructions' });
    const flagIndex = args.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe('extra instructions');
  });

  it('trims appendSystemPromptText before forwarding', () => {
    const args = buildPiRpcArgs({ appendSystemPromptText: '  spaced  ' });
    const flagIndex = args.indexOf('--append-system-prompt');
    expect(args[flagIndex + 1]).toBe('spaced');
  });

  it('omits --append-system-prompt when appendSystemPromptText is empty/whitespace', () => {
    expect(buildPiRpcArgs({ appendSystemPromptText: '' })).not.toContain('--append-system-prompt');
    expect(buildPiRpcArgs({ appendSystemPromptText: '   ' })).not.toContain('--append-system-prompt');
    expect(buildPiRpcArgs({})).not.toContain('--append-system-prompt');
  });
});

describe('buildPiToolsForPermissionMode', () => {
  it.each([
    { mode: 'plan', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'read-only', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'default', expected: null },
    { mode: 'safe-yolo', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'acceptEdits', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'yolo', expected: null },
    { mode: 'bypassPermissions', expected: null },
  ] as const)('maps $mode to tools list', ({ mode, expected }) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(expected);
  });
});

describe('buildPiRpcArgs', () => {
  it.each([undefined, 'default', 'yolo', 'bypassPermissions'] as const)(
    'leaves the native Pi tool catalog unrestricted for permission mode %s',
    (permissionMode) => {
      expect(buildPiRpcArgs({ permissionMode })).toEqual(['--mode', 'rpc']);
    },
  );

  it.each([
    { mode: 'read-only', tools: 'read,grep,find,ls' },
    { mode: 'plan', tools: 'read,grep,find,ls' },
    { mode: 'safe-yolo', tools: 'read,edit,write,grep,find,ls' },
    { mode: 'acceptEdits', tools: 'read,edit,write,grep,find,ls' },
  ] as const)('keeps the explicit tool restriction for $mode', ({ mode, tools }) => {
    expect(buildPiRpcArgs({ permissionMode: mode })).toEqual([
      '--mode',
      'rpc',
      '--tools',
      tools,
    ]);
  });
});
