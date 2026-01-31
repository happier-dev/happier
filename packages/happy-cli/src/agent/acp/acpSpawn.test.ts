import { describe, it, expect } from 'vitest';

import { buildAcpSpawnSpec } from './acpSpawn';

describe('buildAcpSpawnSpec', () => {
  it('preserves args as separate entries (no string join)', () => {
    const spec = buildAcpSpawnSpec({
      command: 'agent',
      args: ['--path', 'C:\\My Documents\\file.txt', '--flag'],
    });

    expect(spec.command).toBe('agent');
    expect(spec.args).toEqual(['--path', 'C:\\My Documents\\file.txt', '--flag']);
  });
});

