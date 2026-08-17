import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { buildPiRpcArgs, buildPiToolsForPermissionMode, createPiBackend, resolveHappyBridgeExtensionArgs } from './backend';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  PI_BROKER_SELECTIONS_ENV,
  resolvePiBrokerExtensionPath,
  serializePiBrokerSelections,
} from '@/backends/pi/brokerExtension';

const envKeys = ['PATH', 'HAPPIER_PI_PATH', HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

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

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
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

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
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

  it('forwards appendSystemPromptText via spawn options, never as literal argv', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      appendSystemPromptText: 'CLAUDE_PATTERN_PROMPT',
    });

    // The args array must never carry the literal prompt text (process-list-visible,
    // unbounded); the backend materializes a protected temp file and injects the flag at
    // spawn time.
    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('CLAUDE_PATTERN_PROMPT');
    expect((backend as any).options?.appendSystemPromptText).toBe('CLAUDE_PATTERN_PROMPT');
  });

  it('treats blank appendSystemPromptText as null', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      appendSystemPromptText: '   ',
    });

    expect((backend as any).options?.appendSystemPromptText).toBeNull();
  });
});

describe('happy tools bridge extension args', () => {
  const baseBridge = {
    extensionPath: '/agent/extensions/happier-pi-tools-bridge.js',
    sessionRenameMode: 'ongoing' as const,
    promptOptionsEnabled: true,
    memoryMachineId: 'machine-1' as string | null,
  };

  it('passes --extension, the session binding, and the resolved config flags', () => {
    expect(resolveHappyBridgeExtensionArgs({
      happierSessionId: 'happy-session-1',
      happyToolsBridge: baseBridge,
    })).toEqual([
      '--extension',
      baseBridge.extensionPath,
      '--happy-session-id',
      'happy-session-1',
      '--happy-session-rename',
      'ongoing',
      '--happy-prompt-options',
      '--happy-memory-machine-id',
      'machine-1',
    ]);
  });

  it('omits config flags entirely in their disabled state (absent = disabled)', () => {
    expect(resolveHappyBridgeExtensionArgs({
      happierSessionId: 'happy-session-1',
      happyToolsBridge: {
        extensionPath: baseBridge.extensionPath,
        sessionRenameMode: 'disabled',
        promptOptionsEnabled: false,
        memoryMachineId: null,
      },
    })).toEqual([
      '--extension',
      baseBridge.extensionPath,
      '--happy-session-id',
      'happy-session-1',
    ]);
  });

  it('passes the initial rename mode verbatim', () => {
    const args = resolveHappyBridgeExtensionArgs({
      happierSessionId: 'happy-session-1',
      happyToolsBridge: { ...baseBridge, sessionRenameMode: 'initial' },
    });
    expect(args).toContain('--happy-session-rename');
    expect(args[args.indexOf('--happy-session-rename') + 1]).toBe('initial');
  });

  it('emits no bridge args without the session binding (extension never travels alone)', () => {
    expect(resolveHappyBridgeExtensionArgs({
      happierSessionId: null,
      happyToolsBridge: baseBridge,
    })).toEqual([]);
    expect(resolveHappyBridgeExtensionArgs({
      happierSessionId: '   ',
      happyToolsBridge: baseBridge,
    })).toEqual([]);
  });

  it('emits no bridge args without the resolved bridge options (binding never travels alone)', () => {
    expect(resolveHappyBridgeExtensionArgs({
      happierSessionId: 'happy-session-1',
      happyToolsBridge: undefined,
    })).toEqual([]);
  });

  it('wires bridge args into the Pi backend without env side channels', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
      happyToolsBridge: baseBridge,
    }) as unknown as { options?: { args?: string[]; env?: Record<string, string> } };

    expect(backend.options?.args).toEqual(expect.arrayContaining([
      '--extension',
      baseBridge.extensionPath,
      '--happy-session-id',
      'happy-session-1',
      '--happy-session-rename',
      'ongoing',
      '--happy-prompt-options',
      '--happy-memory-machine-id',
      'machine-1',
    ]));
    expect(backend.options?.env).not.toHaveProperty('HAPPIER_PI_BRIDGE_MEMORY_MACHINE_ID');
  });

  it('omits the memory machine id flag when no machine id is bound', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
      happyToolsBridge: { ...baseBridge, memoryMachineId: null },
    }) as unknown as { options?: { args?: string[]; env?: Record<string, string> } };

    expect(backend.options?.args).not.toContain('--happy-memory-machine-id');
    expect(backend.options?.env).not.toHaveProperty('HAPPIER_PI_BRIDGE_MEMORY_MACHINE_ID');
  });
});

describe('buildPiRpcArgs', () => {
  it('never emits --append-system-prompt (the backend injects the file-backed flag at spawn time)', () => {
    const args = buildPiRpcArgs();
    expect(args).not.toContain('--append-system-prompt');
    expect(args).toEqual(['--mode', 'rpc']);
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
