import type { AgentId } from '@happier-dev/agents';
import { onTestFinished } from 'vitest';

import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

/** Resolvable provider executables for tests whose runner process boundary is replaced. */
export async function createProviderCliFixture(agentIds: readonly AgentId[]): Promise<Record<string, string>> {
  const dir = await createTempDir('happier-provider-cli-fixture-');
  onTestFinished(async () => await removeTempDir(dir));
  const environment: Record<string, string> = {};
  for (const agentId of agentIds) {
    environment[`HAPPIER_${agentId.toUpperCase()}_PATH`] = await writeExecutableShim({
      dir,
      fileName: process.platform === 'win32' ? `${agentId}.cmd` : agentId,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
    });
  }
  return environment;
}
