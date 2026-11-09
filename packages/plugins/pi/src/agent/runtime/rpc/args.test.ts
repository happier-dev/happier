import { describe, expect, it } from 'vitest';

import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  resolvePiRequestAuthExtensionPath,
} from '../../auth/services/requestAuth/index.js';
import { buildPiRpcArgs } from './args.js';
import { buildPiToolsForPermissionMode } from './permissions.js';

type PermissionModule = Readonly<{
  resolvePiToolsForPermissionMode?: (permissionMode?: string) => Readonly<{
    tools: readonly string[] | null;
    resolvedIntent: string;
    diagnostic: Readonly<{
      kind: 'unknown_permission_mode';
      requestedMode: string;
      appliedIntent: 'read-only';
    }> | null;
  }>;
}>;

describe('buildPiToolsForPermissionMode', () => {
  it.each([
    { mode: 'plan', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'read-only', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'read_only', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'default', expected: null },
    { mode: 'auto', expected: null },
    { mode: 'safe-yolo', expected: null },
    { mode: 'workspace_write', expected: null },
    { mode: 'acceptEdits', expected: null },
    { mode: 'yolo', expected: null },
    { mode: 'bypass', expected: null },
    { mode: 'bypassPermissions', expected: null },
  ] as const)('maps $mode to tools list', ({ mode, expected }) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(expected);
  });

  it.each(['yolo!', 'unexpected-mode'] as const)('fails closed for unknown mode %s', (mode) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('returns diagnostics for unknown permission modes', async () => {
    const loaded = await import('./permissions.js') as PermissionModule;
    expect(loaded.resolvePiToolsForPermissionMode).toEqual(expect.any(Function));

    const resolved = loaded.resolvePiToolsForPermissionMode?.('yolo!');

    expect(resolved).toEqual({
      tools: ['read', 'grep', 'find', 'ls'],
      resolvedIntent: 'read-only',
      diagnostic: {
        kind: 'unknown_permission_mode',
        requestedMode: 'yolo!',
        appliedIntent: 'read-only',
      },
    });
  });
});

describe('buildPiRpcArgs', () => {
  it('selects the bound source without treating slashes in its model id as provider identity', () => {
    const args = buildPiRpcArgs({ providerModelId: 'vendor/selected-model', connectedServiceId: 'openai' });
    expect(args.slice(0, 6)).toEqual(['--provider', 'happier-provider', '--model', 'vendor/selected-model', '--models', 'happier-provider/*']);
  });

  it('adds the session-private skills root without disabling native skills', () => {
    const args = buildPiRpcArgs({ skillsRoot: '/session/skills' });
    expect(args.filter((argument) => argument === '--skill')).toHaveLength(1);
    expect(args[args.indexOf('--skill') + 1]).toBe('/session/skills');
    expect(args).not.toContain('--no-skills');
    expect(buildPiRpcArgs()).not.toContain('--skill');
  });
  it('trusts the user-selected project for fresh and resumed launches', () => {
    expect(buildPiRpcArgs()).toContain('--approve');
    expect(buildPiRpcArgs({ resumeSessionId: 'existing-session' })).toContain('--approve');
  });
  it('builds Pi RPC argv with permission tools and normalized thinking level', () => {
    expect(buildPiRpcArgs({ permissionMode: 'read-only', thinkingLevel: 'HIGH' })).toEqual([
      '--mode',
      'rpc',
      '--approve',
      '--tools',
      'read,grep,find,ls',
      '--thinking',
      'high',
    ]);
  });

  it('omits invalid thinking levels and preserves provider-minted resume session ids', () => {
    expect(buildPiRpcArgs({
      permissionMode: 'default',
      thinkingLevel: 'invalid',
      resumeSessionId: ' pi-session-1 ',
    })).toEqual([
      '--mode',
      'rpc',
      '--approve',
      '--session',
      ' pi-session-1 ',
    ]);
  });

  it('adds provider, startup model, and model scope derived from the connected service selection', () => {
    expect(buildPiRpcArgs({
      permissionMode: 'default',
      connectedServiceId: 'openai-codex',
    })).toEqual([
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.5',
      '--models',
      'openai-codex/*',
      '--mode',
      'rpc',
      '--approve',
    ]);
  });

  it('starts the Anthropic connected service on Pi\'s own pinned Claude model', () => {
    expect(buildPiRpcArgs({
      permissionMode: 'default',
      connectedServiceId: 'anthropic',
    })).toEqual([
      '--provider',
      'anthropic',
      '--model',
      'claude-opus-5',
      '--models',
      'anthropic/*',
      '--mode',
      'rpc',
      '--approve',
    ]);
  });

  it('loads the explicit request-auth extension only when the child capability and agent dir are present', () => {
    const agentDir = '/tmp/pi-request-auth-agent';
    expect(buildPiRpcArgs({
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
      },
    })).toEqual([
      '--extension',
      resolvePiRequestAuthExtensionPath(agentDir),
      '--mode',
      'rpc',
      '--approve',
    ]);
    expect(buildPiRpcArgs({
      env: {
        PI_CODING_AGENT_DIR: agentDir,
      },
    })).not.toContain('--extension');
  });

  it('composes the Happier tools extension with request-auth', () => {
    const agentDir = '/tmp/pi-agent';
    expect(buildPiRpcArgs({
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
      },
      happierToolsExtension: {
        extensionPath: '/tmp/happier-pi-tools-bridge.js',
        configPath: '/tmp/happier-pi-tools-config.json',
        toolNames: ['change_title'],
      },
    })).toEqual([
      '--extension', resolvePiRequestAuthExtensionPath(agentDir),
      '--extension', '/tmp/happier-pi-tools-bridge.js',
      '--happier-tools-config', '/tmp/happier-pi-tools-config.json',
      '--mode', 'rpc',
      '--approve',
    ]);
  });

  it.each(['plan', 'read-only'] as const)(
    'keeps native extension tools available when %s restricts Pi built-in tools',
    (permissionMode) => {
      const args = buildPiRpcArgs({
        permissionMode,
        happierToolsExtension: {
          extensionPath: '/tmp/happier-pi-tools-bridge.js',
          configPath: '/tmp/happier-pi-tools-config.json',
          toolNames: ['change_title'],
        },
      });
      const toolsFlagIndex = args.indexOf('--tools');
      expect(toolsFlagIndex).toBeGreaterThanOrEqual(0);
      expect(args[toolsFlagIndex + 1]?.split(',')).toContain('change_title');
    },
  );
});
