import type { SpawnedProcess } from './spawnProcess';

export type StartedUiWeb = {
  baseUrl: string;
  proc: SpawnedProcess | null;
  stop: () => Promise<void>;
};

export type UiWebMode = 'export' | 'metro';
