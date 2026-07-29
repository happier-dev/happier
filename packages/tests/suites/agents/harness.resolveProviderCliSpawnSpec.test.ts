import { describe, expect, it } from 'vitest';

import type { ProviderScenario } from '../../src/testkit/providers/types';
import { resolveProviderCliSpawnSpec } from '../../src/testkit/providers/harness/resolveProviderCliSpawnSpec';

describe('resolveProviderCliSpawnSpec', () => {
  it('wraps the provider CLI command in a pseudo-TTY when requested by the scenario', () => {
    const scenario: ProviderScenario = {
      id: 'needs_tty',
      title: 'needs tty',
      tier: 'smoke',
      prompt: () => 'hi',
      cliRequiresTty: true,
    };

    const resolved = resolveProviderCliSpawnSpec({
      platform: 'darwin',
      scriptPath: '/usr/bin/script',
      baseCommand: 'yarn',
      baseArgs: ['-s', 'workspace', '@happier-dev/cli', 'dev', 'claude'],
      scenario,
    });

    expect(resolved).toEqual({
      command: '/usr/bin/script',
      args: ['-q', '/dev/null', 'yarn', '-s', 'workspace', '@happier-dev/cli', 'dev', 'claude'],
    });
  });
});

