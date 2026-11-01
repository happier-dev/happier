import { describe, expect, it, vi } from 'vitest';

vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: (agentId: string) => ({ command: `/resolved/${agentId}`, args: [] }),
}));

import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { writeFx014AcpAgentScript } from '@/agent/acp/testkit/fx014';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('catalog-defined FX and Factory Droid ACP backends', () => {
  // 0.0.14 live payload: E-fx-live-probe.md §3, 2026-10-27, revision 1a070af32cdf.
  // 0.0.13: 4d966e272cfc4296cdf703f409480088cf2e72ba builtins/modes.zig code => auto.
  it.each([
    { modeIds: ['auto', 'ask', 'full-access'], expected: 'auto' },
    { modeIds: ['code', 'ask'], expected: 'code' },
    { modeIds: ['code', 'auto', 'ask', 'full-access'], expected: 'auto' },
    { modeIds: ['ask', 'full-access'], expected: null },
  ])('resolves safe-yolo against advertised FX modes $modeIds', async ({ modeIds, expected }) => {
    await withTempDir('happier-fx-permission-', async (dir) => {
      for (const resume of [false, true]) {
        const backend = createCatalogDefinedAcpBackend('fx', {
          cwd: dir, permissionMode: 'safe-yolo',
          launch: { command: process.execPath, args: [writeFx014AcpAgentScript({ dir, modeIds })] },
        });
        if (!(backend instanceof AcpBackend)) throw new Error('Expected the real ACP backend');
        try {
          const open = () => resume ? backend.loadSession('fx-fixture-session') : backend.startSession();
          if (expected === null) {
            await expect(open()).rejects.toThrow(/advertised.*mode|Unknown mode/);
            expect(backend.getSessionModeState()?.currentModeId).toBe('ask');
          } else {
            await open();
            expect(backend.getSessionModeState()?.currentModeId).toBe(expected);
          }
        } finally {
          await backend.dispose();
        }
      }
    });
  });

  it.each([
    ['fx', '/resolved/fx', ['acp']],
    ['droid', '/resolved/droid', ['exec', '--output-format', 'acp']],
  ] as const)('launches %s through its official ACP command', (agentId, command, args) => {
    const backend = createCatalogDefinedAcpBackend(agentId as never, { cwd: '/workspace' });

    expect(backend).toMatchObject({ options: { command, args, declaredSessionLoadSupport: true } });
    expect(backend.loadSession).toBeTypeOf('function');
  });
});
