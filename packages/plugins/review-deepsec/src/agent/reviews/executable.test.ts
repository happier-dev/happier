import type { SystemToolLaunchGrantV1, SystemToolResolveRequestV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { resolveDeepSecExecutable } from './executable.js';

describe('resolveDeepSecExecutable', () => {
  it('resolves DeepSec through the host system-tool grant API', async () => {
    const grant: SystemToolLaunchGrantV1 = {
      grantId: 'grant-1',
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'system',
      executablePath: '/usr/local/bin/deepsec',
      launch: { kind: 'binary', executablePath: '/usr/local/bin/deepsec' },
      expiresAt: null,
    };
    const resolve = vi.fn(async (_request: SystemToolResolveRequestV1) => grant);

    await expect(resolveDeepSecExecutable({
      cwd: '/repo',
      systemTools: { resolve },
      preferredExecutablePath: '/usr/local/bin/deepsec',
    })).resolves.toEqual(grant);

    expect(resolve).toHaveBeenCalledWith({
      toolId: 'deepsec',
      purpose: 'review security findings',
      cwd: '/repo',
      preferredPath: '/usr/local/bin/deepsec',
      signal: undefined,
    });
  });
});
