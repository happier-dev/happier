import type {
  ResolvedSystemTool as PluginResolvedSystemTool,
  SystemToolResolveRequest as PluginSystemToolResolveRequest,
} from '@happier-dev/plugin-sdk/exec';
import { describe, expect, it, vi } from 'vitest';

import { resolveDeepSecExecutable } from './executable.js';

describe('resolveDeepSecExecutable', () => {
  it('resolves DeepSec through the host system-tool grant API', async () => {
    const grant: PluginResolvedSystemTool = {
      executable: { kind: 'systemTool', id: 'deepsec-cli' },
      executablePath: '/usr/local/bin/deepsec',
    };
    const resolve = vi.fn(async (_request: PluginSystemToolResolveRequest) => grant);

    await expect(resolveDeepSecExecutable({
      cwd: '/repo',
      systemTools: { resolve },
      preferredExecutablePath: '/usr/local/bin/deepsec',
    })).resolves.toEqual(grant);

    expect(resolve).toHaveBeenCalledWith({
      toolId: 'deepsec-cli',
      purpose: 'review security findings',
      cwd: '/repo',
      preferredPath: '/usr/local/bin/deepsec',
      signal: undefined,
    });
  });
});
