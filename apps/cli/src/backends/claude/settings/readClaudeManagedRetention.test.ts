import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readClaudeManagedRetention } from './readClaudeManagedRetention';

describe('Claude local administrative retention declarations', () => {
  it('finds a retention override in a managed drop-in without treating unrelated or hidden settings as retention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-managed-retention-'));
    try {
      const dropIns = join(root, 'managed-settings.d');
      await mkdir(dropIns);
      await writeFile(join(root, 'managed-settings.json'), JSON.stringify({ model: 'sonnet' }));
      await writeFile(join(dropIns, '.hidden.json'), JSON.stringify({ cleanupPeriodDays: 1 }));
      expect(await readClaudeManagedRetention(root)).toBe('absent');
      await writeFile(join(dropIns, '10-retention.json'), JSON.stringify({ cleanupPeriodDays: 7 }));
      expect(await readClaudeManagedRetention(root)).toBe('present');
      await writeFile(join(dropIns, '20-invalid.json'), '{invalid');
      expect(await readClaudeManagedRetention(root)).toBe('unreadable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
