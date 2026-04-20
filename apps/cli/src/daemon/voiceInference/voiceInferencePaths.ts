import { join } from 'node:path';

import { configuration } from '@/configuration';
import { ensurePrivateInferenceDirectory, resolveInferenceModelsRootDir } from '@/daemon/inference/inferencePaths';

export type VoiceInferencePaths = Readonly<{
  rootDir: string;
  modelsRootDir: string;
  packsRootDir: string;
  tempDir: string;
  installsStateFilePath: string;
}>;

export function resolveVoiceInferencePaths(): VoiceInferencePaths {
  const rootDir = join(configuration.activeServerDir, 'voiceInference');
  const modelsRootDir = resolveInferenceModelsRootDir({ ownerRootDir: rootDir });
  const packsRootDir = join(rootDir, 'packs');
  const tempDir = join(rootDir, 'tmp');
  const installsStateFilePath = join(rootDir, 'installs.json');

  ensurePrivateInferenceDirectory(rootDir);
  ensurePrivateInferenceDirectory(modelsRootDir);
  ensurePrivateInferenceDirectory(packsRootDir);
  ensurePrivateInferenceDirectory(tempDir);

  return {
    rootDir,
    modelsRootDir,
    packsRootDir,
    tempDir,
    installsStateFilePath,
  };
}
