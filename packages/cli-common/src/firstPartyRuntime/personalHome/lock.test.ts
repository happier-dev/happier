import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquirePersonalHomeOperationLock, PersonalHomeOperationError } from './lock.js';

describe('Personal Home operation lock', () => {
  it('serializes operations and writes owner metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-'));
    const release = await acquirePersonalHomeOperationLock(root, 'backup');
    await expect(acquirePersonalHomeOperationLock(root, 'restore')).rejects.toBeInstanceOf(PersonalHomeOperationError);
    const record = JSON.parse(await readFile(join(root, '.operations', 'lock'), 'utf8')) as { operation:string };
    expect(record.operation).toBe('backup');
    await release();
  });
});
