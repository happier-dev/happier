import type { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';

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
  Paths: { document: string | Pick<ExpoDirectory, 'uri'> };
};

export type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
};

export type Progress = { loaded: number; total: number };

/** Pack-level progress: bytes are clamped to the manifest sizes; verified files count as done. */
export type ModelPackDownloadProgress = Readonly<{ loaded: number; total: number; filesDone: number; filesTotal: number }>;

