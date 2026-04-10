import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { createScpReadyPayloadCopy } from './createScpReadyPayloadCopy.js';

const execFileAsync = promisify(execFile);

export async function createScpReadyPayloadArchive(payloadRoot: string): Promise<Readonly<{
  archiveStageRoot: string;
  archiveFileName: string;
  extractedPayloadDirName: string;
  cleanup: () => Promise<void>;
}>> {
  const scpReadyPayload = await createScpReadyPayloadCopy(payloadRoot);
  const archiveStageRoot = await mkdtemp(join(tmpdir(), 'happier-first-party-scp-archive-'));
  const extractedPayloadDirName = basename(scpReadyPayload.payloadRoot);
  const archiveFileName = `${extractedPayloadDirName}.tar`;

  try {
    await execFileAsync('tar', [
      '-cf',
      join(archiveStageRoot, archiveFileName),
      '-C',
      join(scpReadyPayload.payloadRoot, '..'),
      extractedPayloadDirName,
    ]);
    return {
      archiveStageRoot,
      archiveFileName,
      extractedPayloadDirName,
      cleanup: async () => {
        await Promise.all([
          scpReadyPayload.cleanup(),
          rm(archiveStageRoot, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      scpReadyPayload.cleanup(),
      rm(archiveStageRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
