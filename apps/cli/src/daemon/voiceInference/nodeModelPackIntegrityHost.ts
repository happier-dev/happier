/** Node filesystem adapter for installed model-pack integrity verification. */
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { filePathParts } from '@happier-dev/protocol/voice/modelPacks/pathSafety';
import type { InstalledModelPackIntegrityHost } from '@happier-dev/voice-modelpacks';

import { assertVoiceInferencePackIdFilesystemSafe } from './voiceInferenceWorker.shared';

export function createNodeInstalledModelPackIntegrityHost(
  packsRootDir: string,
): InstalledModelPackIntegrityHost {
  return Object.freeze({
    streamFile: async (packId, filePath, onChunk) => {
      const safePackId = assertVoiceInferencePackIdFilesystemSafe(packId);
      const absolutePath = join(packsRootDir, safePackId, ...filePathParts(filePath));
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('model_pack_installed_file_invalid');
      let streamed = 0;
      for await (const rawChunk of createReadStream(absolutePath)) {
        const chunk = new Uint8Array(rawChunk);
        streamed += chunk.byteLength;
        await onChunk(chunk);
      }
      return streamed;
    },
  });
}
