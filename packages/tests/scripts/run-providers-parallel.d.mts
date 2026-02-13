export interface ProvidersParallelRunArgs {
  presetId: string | null;
  tier: string | null;
  maxParallelRaw?: string;
  retrySerial: boolean;
  updateBaselines: boolean;
  strictKeys: boolean;
  flakeRetry: boolean;
}

export interface ProvidersParallelFailureReport {
  v: 1;
  providerId: string;
  scenarioId: string;
  error: string;
  ts: number;
}

export interface ProvidersParallelSummaryEntry {
  providerId: string;
  modelId: string | null;
  entries: number;
  tokens: Record<string, number>;
}

export interface ProvidersParallelSummaryByProviderEntry {
  providerId: string;
  entries: number;
  tokens: Record<string, number>;
}

export interface ProvidersParallelMergedTokenLedgers {
  entries: Array<Record<string, unknown>>;
  summary: ProvidersParallelSummaryEntry[];
  summaryByProvider: ProvidersParallelSummaryByProviderEntry[];
  totals: {
    entries: number;
    tokens: Record<string, number>;
  };
}

export function parseArgs(argv: string[]): ProvidersParallelRunArgs;
export function filterProviderIdsByScenarioRegistry(input: {
  providerIds: string[];
  tier: 'smoke' | 'extended';
  scenarioSelectionRaw: string;
}): Promise<string[]>;
export function parseFailureReportJson(raw: string): ProvidersParallelFailureReport | null;
export function resolveRetryScenarioIds(input: {
  orderedScenarioIds: string[];
  failedScenarioId: string;
}): string[] | null;
export function buildProviderChildEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  reportPath: string;
  scenarioIds: string[] | null;
  tokenLedgerPath: string | null;
}): NodeJS.ProcessEnv;
export function mergeTokenLedgersFromPaths(input: { paths: string[] }): Promise<ProvidersParallelMergedTokenLedgers>;
export function main(argv?: string[]): Promise<number>;
