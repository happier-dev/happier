import { describe, expect, it } from 'vitest';

import { buildPiRpcArgs } from './args.js';
import { buildPiToolsForPermissionMode } from './permissions.js';

describe('buildPiToolsForPermissionMode', () => {
  it.each([
    { mode: 'plan', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'read-only', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'default', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'safe-yolo', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'acceptEdits', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'yolo', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'bypassPermissions', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
  ] as const)('maps $mode to tools list', ({ mode, expected }) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(expected);
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
      '--tools',
      'read,bash,edit,write,grep,find,ls',
      '--session',
      'pi-session-1',
    ]);
  });
});
