import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveForegroundFinalPluginPrerequisites } from './prepareForegroundAdmission';

describe('foreground Agent CLI launch admission', () => {
  it('keeps the profile-selected CLI spec while dropping raw profile environment', async () => {
    if (process.platform === 'win32') return;

    const root = await mkdtemp(join(tmpdir(), 'happier-foreground-agent-cli-'));
    const profileClaudePath = join(root, 'claude-profile');
    const previousClaudePath = process.env.HAPPIER_CLAUDE_PATH;
    await writeFile(profileClaudePath, '#!/bin/sh\necho foreground-profile-claude\n', 'utf8');
    await chmod(profileClaudePath, 0o755);
    process.env.HAPPIER_CLAUDE_PATH = process.execPath;
    try {
      const result = await resolveForegroundFinalPluginPrerequisites({
        // This focused CLI-owner test has no plugin prerequisite hook.
        happyHomeDir: '',
        pluginRuntimeRegistry: undefined as unknown as ResolvedExecutablePluginRuntimeRegistry,
        resolvedAgentId: 'claude',
        directory: '/workspace',
        backendTarget: {
          kind: 'backend',
          backendId: 'claude',
          sourceKind: 'built_in',
        },
        environment: {
          HAPPIER_CLAUDE_PATH: profileClaudePath,
          PRIVATE_LAUNCH_SECRET: 'must-not-be-retained',
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.agentCliLaunchSpec).toEqual({
        source: 'override',
        resolvedPath: profileClaudePath,
        command: profileClaudePath,
        args: [],
      });
    } finally {
      if (previousClaudePath === undefined) delete process.env.HAPPIER_CLAUDE_PATH;
      else process.env.HAPPIER_CLAUDE_PATH = previousClaudePath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
