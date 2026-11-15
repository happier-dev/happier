import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { readHeldNativeAgentCliAuthStatus } from './heldNativeAgentCliAuthStatus';
import type { CliAuthSpec } from './types';

describe('held native Agent sign-in fact', () => {
  it('holds only the signed-in state, never the probe account label or identity', async () => {
    const dir = await createTempDir('happier-held-auth-', tmpdir());
    try {
      const cli = join(dir, 'agent-cli');
      await writeFile(cli, '#!/bin/sh\n');
      let probes = 0;
      // The Agent's own probe callback is the external boundary; it reports an identity.
      const authSpec: CliAuthSpec = { binaryNames: ['agent-cli'], isSafeForBackgroundChecks: true,
        detectAuthStatus: async () => {
          probes += 1;
          return { state: 'logged_in', source: 'command', accountLabel: 'person@example.com' };
        } };
      const read = async () => await readHeldNativeAgentCliAuthStatus({ agentId: 'held-auth-fixture', resolvedPath: cli,
        authSpec, processEnv: { HOME: dir }, authEnvironmentVariables: [] });

      await read();
      const held = await read();
      expect(probes).toBe(1);
      expect(held?.state).toBe('logged_in');
      expect(JSON.stringify(held)).not.toContain('person@example.com');
      expect(held).not.toHaveProperty('accountLabel');
    } finally {
      await removeTempDir(dir);
    }
  });
});
