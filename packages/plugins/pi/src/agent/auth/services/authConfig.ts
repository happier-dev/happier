import { join } from 'node:path';

import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/fs';

async function writePiAuthConfig(input: Readonly<{
  agentDir: string;
  entries: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const path = join(input.agentDir, 'auth.json');
  await writeAtomicJsonFile({
    path,
    value: input.entries,
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
  });
}

export async function replacePiNativeModelsConfig(input: Readonly<{
  agentDir: string;
  providers: Readonly<Record<string, Readonly<{ baseUrl: string }>>>;
}>): Promise<void> {
  await writeAtomicJsonFile({ path: join(input.agentDir, 'models.json'), value: { providers: input.providers }, mode: 0o600 });
}
