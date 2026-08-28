export function resolveQaStackRuntimeJsonPath(env?: NodeJS.ProcessEnv): string;

export function resolveQaUiUrl(env?: NodeJS.ProcessEnv): string;
export function resolveQaUiRuntimeIdentity(env?: NodeJS.ProcessEnv): Readonly<{
  mode: 'snapshot' | 'expo' | 'borrowedExpo';
  consumerRuntimePath: string;
  producerRuntimePath: string;
  producerStackName: string;
}>;
export function resolveQaRunningExpoState(producerRuntimePath: string): Promise<Readonly<{
  statePath: string;
  state: Readonly<Record<string, unknown>>;
}> | null>;

export function withQaUiBase(
  baseUrl: string,
  pathname: string,
  opts?: Readonly<{ stripServerParam?: boolean }>,
): string;

export function ensureQaUiUrlHasHmrDisabled(url: string): string;

export function isQaUiUrlPathSuffix(url: string, suffix: string): boolean;
