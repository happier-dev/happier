import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '@happier-dev/plugin-sdk';
import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/fs';

type PiDirectAuthProviderId = 'openai' | 'anthropic';
type PiDirectAuthEntry = Readonly<{
  type: 'api_key';
  key: string;
}>;

async function writePiAuthConfig(input: Readonly<{
  agentDir: string;
  entries: Readonly<Record<string, unknown>>;
  preserveExisting: boolean;
}>): Promise<void> {
  const path = join(input.agentDir, 'auth.json');
  let existing: Readonly<Record<string, unknown>> = {};
  if (input.preserveExisting) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Pi qualified Connected Account launch requires the pre-materialized auth.json');
      }
      throw error;
    }
    if (!isRecord(parsed)) {
      throw new Error('Pi qualified Connected Account launch found an invalid pre-materialized auth.json');
    }
    existing = parsed;
  }
  await writeAtomicJsonFile({
    path,
    value: { ...existing, ...input.entries },
    mode: 0o600,
  });
}

export async function replacePiAuthConfig(input: Readonly<{
  agentDir: string;
  entries: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  await writePiAuthConfig({
    agentDir: input.agentDir,
    entries: input.entries,
    preserveExisting: false,
  });
}

export async function overlayPiDirectAuthConfig(input: Readonly<{
  agentDir: string;
  entries: Readonly<Partial<Record<PiDirectAuthProviderId, PiDirectAuthEntry>>>;
}>): Promise<void> {
  await writePiAuthConfig({
    agentDir: input.agentDir,
    entries: input.entries,
    preserveExisting: true,
  });
}
