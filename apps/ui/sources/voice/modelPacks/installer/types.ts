export type InstallMode = 'require_installed' | 'download_if_missing';
export type UpdatePolicy = 'none' | 'manual_update_if_available';

/**
 * Minimal structural view of the Expo `File` handle the installer host uses
 * (LB-L5). Typed to the exact surface consumed so the adapter edge is not `any`.
 * Mirrors `expo-file-system`'s `File`.
 */
export type ExpoFsFile = {
  readonly uri: string;
  readonly name: string;
  readonly exists: boolean;
  /** Byte size of the file (0 when absent), used for resume offsets without reading bytes. */
  readonly size?: number;
  bytes: () => Promise<Uint8Array>;
  text: () => Promise<string>;
  /** Write content; `{ append: true }` appends without rewriting the whole file. */
  write: (content: string | Uint8Array, options?: { append?: boolean }) => void;
  create?: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
  delete?: (options?: { idempotent?: boolean }) => void;
};

/** Minimal structural view of the Expo `Directory` handle. Mirrors `expo-file-system`'s `Directory`. */
export type ExpoFsDirectory = {
  uri: string;
  readonly name: string;
  readonly exists: boolean;
  create?: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
  delete?: (options?: { idempotent?: boolean }) => void;
  move: (destination: ExpoFsDirectory | { uri: string }) => void;
  list: () => (ExpoFsDirectory | ExpoFsFile)[];
};

export type ExpoFsDirectoryCtor = new (...args: unknown[]) => ExpoFsDirectory;
export type ExpoFsFileCtor = new (...args: unknown[]) => ExpoFsFile;

export type InstallerFs = {
  Directory: ExpoFsDirectoryCtor;
  File: ExpoFsFileCtor;
  Paths: { document: unknown };
};

export type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
};

export type Progress = { loaded: number; total: number };
