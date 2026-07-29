import { unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { createVoiceDiagnosticsController, type VoiceDiagnosticsController } from './controller';
import { createVoiceDiagnosticStore } from './store';

const OWNED_ORPHAN_FILENAME = 'deadbeef.wav';

export async function createDiagnosticsControllerWithRemovalFailure(input: Readonly<{
  happyHomeDir: string;
}>): Promise<Readonly<{
  controller: VoiceDiagnosticsController;
  recoverRemoval: () => void;
}>> {
  let removalFails = true;
  const controller = createVoiceDiagnosticsController({
    happyHomeDir: input.happyHomeDir,
    createStore: (settings) => createVoiceDiagnosticStore({
      happyHomeDir: input.happyHomeDir,
      policy: settings,
      statfs: async () => ({ bavail: Number.MAX_SAFE_INTEGER, bsize: 1 }),
      removeFile: async (path) => {
        if (removalFails && basename(path) === OWNED_ORPHAN_FILENAME) {
          throw Object.assign(new Error('simulated_voice_diagnostics_remove_failure'), { code: 'EPERM' });
        }
        await unlink(path);
      },
    }),
  });

  await controller.configure({
    v: 1,
    enabled: true,
    consentVersion: 1,
    captureSttInput: true,
    captureTtsOutput: true,
    maxAgeMs: 86_400_000,
    maxFiles: 20,
    maxBytes: 104_857_600,
    maxDurationMs: 300_000,
  });
  await writeFile(join(controller.root, OWNED_ORPHAN_FILENAME), Buffer.from('orphaned-private-audio'));

  return {
    controller,
    recoverRemoval: () => {
      removalFails = false;
    },
  };
}
