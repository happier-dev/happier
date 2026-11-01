import type { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';

import type { InstallerSherpaNative } from './nativeEngines.native';

export type InstallMode = 'require_installed' | 'download_if_missing';
export type UpdatePolicy = 'none' | 'manual_update_if_available';

export type InstallerDirectory = Pick<ExpoDirectory, 'uri' | 'exists' | 'create' | 'delete'> & {
  readonly size?: number | null;
};

export type InstallerFile = Pick<ExpoFile, 'uri' | 'exists' | 'delete' | 'write' | 'text'> & {
  open(): Pick<ReturnType<ExpoFile['open']>, 'readBytes' | 'close'>;
  move(destination: { uri: string }): void;
};

export type InstallerFs = {
  Directory: new (...uris: string[]) => InstallerDirectory;
  File: new (...uris: string[]) => InstallerFile;
  // expo-file-system reports free bytes on the document volume; iOS can report none.
  Paths: { document: string | Pick<ExpoDirectory, 'uri'>; readonly availableDiskSpace?: number | null };
};

export type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
  /** Native speech module boundary; `null` means none is available. */
  sherpaNative?: InstallerSherpaNative | null;
};

export type Progress = { loaded: number; total: number };

/**
 * Pack-level progress: bytes are clamped to the manifest sizes; verified files count as done. `verified` counts
 * bytes already checked against the manifest hash, which trails `loaded` while downloaded files are hashed.
 */
export type ModelPackDownloadProgress = Readonly<{
  loaded: number;
  total: number;
  verified: number;
  filesDone: number;
  filesTotal: number;
}>;

