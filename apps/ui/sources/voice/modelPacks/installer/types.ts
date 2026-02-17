export type InstallMode = 'require_installed' | 'download_if_missing';
export type UpdatePolicy = 'none' | 'manual_update_if_available';

export type InstallerFs = {
  Directory: any;
  File: any;
  Paths: { document: any };
};

export type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
};

export type Progress = { loaded: number; total: number };

