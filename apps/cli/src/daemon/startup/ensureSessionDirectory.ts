import fs from 'fs/promises';

import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

export type EnsureSessionDirectoryResult =
  | { ok: true; directoryCreated: boolean }
  | {
      ok: false;
      response: Extract<SpawnSessionResult, { type: 'requestToApproveDirectoryCreation' | 'error' }>;
    };

export async function ensureSessionDirectory(opts: {
  directory: string;
  approvedNewDirectoryCreation: boolean;
}): Promise<EnsureSessionDirectoryResult> {
  try {
    await fs.access(opts.directory);
    return { ok: true, directoryCreated: false };
  } catch {
    if (!opts.approvedNewDirectoryCreation) {
      return {
        ok: false,
        response: {
          type: 'requestToApproveDirectoryCreation',
          directory: opts.directory,
        },
      };
    }

    try {
      await fs.mkdir(opts.directory, { recursive: true });
      return { ok: true, directoryCreated: true };
    } catch (mkdirError: unknown) {
      const error = mkdirError as { code?: string; message?: string };
      let errorMessage = `Unable to create directory at '${opts.directory}'. `;

      if (error.code === 'EACCES') {
        errorMessage += "Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.";
      } else if (error.code === 'ENOTDIR') {
        errorMessage += 'A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.';
      } else if (error.code === 'ENOSPC') {
        errorMessage += 'No space left on device. Your disk is full. Please free up some space and try again.';
      } else if (error.code === 'EROFS') {
        errorMessage += 'The file system is read-only. Cannot create directories here. Please choose a writable location.';
      } else {
        errorMessage += `System error: ${error.message || String(mkdirError)}. Please verify the path is valid and you have the necessary permissions.`;
      }

      return {
        ok: false,
        response: {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
          errorMessage,
        },
      };
    }
  }
}
