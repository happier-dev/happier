import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  extendedDbOwnerToken,
  isExtendedDbOwnerAlive,
  selectOrphanedExtendedDbContainers,
} from '../../../scripts/extended-db-docker.ownership.mjs';

describe('extended DB container ownership', () => {
  it('selects only containers whose harness process is gone', async () => {
    // A real child process is the boundary: it owns a container token, then exits.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const deadToken = extendedDbOwnerToken(child.pid);
    child.kill();
    await once(child, 'exit');
    const liveToken = extendedDbOwnerToken();

    expect(isExtendedDbOwnerAlive(liveToken)).toBe(true);
    expect(isExtendedDbOwnerAlive(deadToken)).toBe(false);
    expect(isExtendedDbOwnerAlive('other-host:1:1')).toBe(true);

    const rows = [
      `aaaaaaaaaaaa ${deadToken}`,
      `bbbbbbbbbbbb ${liveToken}`,
      'cccccccccccc other-host:1:1',
      'dddddddddddd ',
    ].join('\n');
    expect(selectOrphanedExtendedDbContainers(rows)).toEqual(['aaaaaaaaaaaa']);
  });
});
