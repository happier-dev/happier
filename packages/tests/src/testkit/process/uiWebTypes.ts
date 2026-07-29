import type { SpawnedProcess } from './spawnProcess';

export type StartedUiWeb = {
  mode: UiWebMode;
  baseUrl: string;
  proc: SpawnedProcess | null;
  stop: () => Promise<void>;
};

export type UiWebMode = 'export' | 'metro';
