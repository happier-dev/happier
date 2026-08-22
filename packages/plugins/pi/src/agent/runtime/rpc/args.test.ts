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
    { mode: 'default', expected: null },
    { mode: 'safe-yolo', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'acceptEdits', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'yolo', expected: null },
    { mode: 'bypassPermissions', expected: null },
  ] as const)('maps $mode to tools list', ({ mode, expected }) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(expected);
  });

  it.each(['readOnly', 'yolo!', 'bypass'] as const)('fails closed for unknown mode %s', (mode) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('returns diagnostics for unknown permission modes', async () => {
    const loaded = await import('./permissions.js') as PermissionModule;
    expect(loaded.resolvePiToolsForPermissionMode).toEqual(expect.any(Function));

    const resolved = loaded.resolvePiToolsForPermissionMode?.('readOnly');

    expect(resolved).toEqual({
      tools: ['read', 'grep', 'find', 'ls'],
      resolvedIntent: 'read-only',
      diagnostic: {
        kind: 'unknown_permission_mode',
        requestedMode: 'readOnly',
        appliedIntent: 'read-only',
      },
    });
  });
});

describe('buildPiRpcArgs', () => {
  it('builds Pi RPC argv with permission tools and normalized thinking level', () => {
    expect(buildPiRpcArgs({ permissionMode: 'acceptEdits', thinkingLevel: 'HIGH' })).toEqual([
      '--mode',
      'rpc',
      '--tools',
      'read,edit,write,grep,find,ls',
      '--thinking',
      'high',
    ]);
  });

  it('omits invalid thinking levels and trims resume session ids', () => {
    expect(buildPiRpcArgs({
      permissionMode: 'default',
      thinkingLevel: 'invalid',
      resumeSessionId: ' pi-session-1 ',
    })).toEqual([
      '--mode',
      'rpc',
      '--session',
      'pi-session-1',
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
    ]);
    expect(buildPiRpcArgs({
      env: {
        PI_CODING_AGENT_DIR: agentDir,
      },
    })).not.toContain('--extension');
  });
});
