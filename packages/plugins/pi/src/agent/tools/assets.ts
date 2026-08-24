import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentSessionNativeToolBridgeConfig } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeAtomicTextFileIfChanged, writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';

import { buildPiHappierToolsExtensionSource } from './extensionSource.js';

export type PreparedPiHappierToolsExtension = Readonly<{
  extensionPath: string;
  configPath: string;
  dispose(): Promise<void>;
}>;

export async function preparePiHappierToolsExtension(params: Readonly<{
  agentDir: string;
  config: AgentSessionNativeToolBridgeConfig;
}>): Promise<PreparedPiHappierToolsExtension> {
  const extensionPath = join(
    params.agentDir,
    'extensions',
    'happier-pi-tools-bridge',
    'happier-pi-tools-bridge.js',
  );
  await writeAtomicTextFileIfChanged({
    path: extensionPath,
    contents: buildPiHappierToolsExtensionSource(),
    mode: 0o600,
  });
  const configPath = writeSecureTempTextFileSync({
    prefix: 'happier-pi-tools',
    suffix: '.json',
    contents: `${JSON.stringify(params.config)}\n`,
  });
  return Object.freeze({
    extensionPath,
    configPath,
    async dispose() {
      await rm(dirname(configPath), { recursive: true, force: true });
    },
  });
}
