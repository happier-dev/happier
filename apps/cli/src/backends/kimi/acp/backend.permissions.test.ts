import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createKimiBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

function getArgs(permissionMode: PermissionMode): string[] {
  const backend = createKimiBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  }) as unknown as AcpBackendLike;
  return backend.options.args;
}

function readAgentFilePath(args: string[]): string | null {
  const index = args.indexOf('--agent-file');
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

describe('Kimi ACP backend permissions', () => {
  it.each([
    { mode: 'default', hasYolo: false, hasAgentFile: false },
    { mode: 'acceptEdits', hasYolo: false, hasAgentFile: false },
    { mode: 'safe-yolo', hasYolo: false, hasAgentFile: false },
    { mode: 'yolo', hasYolo: true, hasAgentFile: false },
    { mode: 'bypassPermissions', hasYolo: true, hasAgentFile: false },
    { mode: 'read-only', hasYolo: false, hasAgentFile: true },
    { mode: 'plan', hasYolo: false, hasAgentFile: true },
  ])('maps permissionMode="$mode" to expected Kimi CLI args', ({ mode, hasYolo, hasAgentFile }) => {
    const args = getArgs(mode as PermissionMode);

    expect(args.slice(0, 2)).toEqual(['--work-dir', '/tmp']);
    expect(args.includes('--yolo')).toBe(hasYolo);
    expect(args.includes('--agent-file')).toBe(hasAgentFile);
    expect(args[args.length - 1]).toBe('acp');

    const agentFilePath = readAgentFilePath(args);
    if (hasAgentFile) {
      expect(agentFilePath).toBeTruthy();
      expect(agentFilePath).toContain('readonly-agent.yaml');
    } else {
      expect(agentFilePath).toBeNull();
    }
  });
});
