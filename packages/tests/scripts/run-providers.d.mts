export interface ProvidersRunArgs {
  presetId: string | null;
  tier: string | null;
  updateBaselines: boolean;
  strictKeys: boolean;
  flakeRetry: boolean;
}

export function resolveProvidersRunTimeoutFallbackMs(input: { presetId: string; tier: string }): number;
export function parseArgs(argv: string[]): ProvidersRunArgs;
export function resolveProvidersRunTimeoutMs(raw: unknown, fallbackMs?: number): number;
export function main(argv?: string[]): Promise<number>;
