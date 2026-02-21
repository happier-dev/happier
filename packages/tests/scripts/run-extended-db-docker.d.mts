export type ExtendedDbMode = 'e2e' | 'contract' | 'extended';
export type ExtendedDbName = 'postgres' | 'mysql';

export interface ExtendedDbArgs {
  help?: true;
  mode?: ExtendedDbMode;
  keep?: boolean;
  db?: ExtendedDbName;
  name?: string;
}

export function parseArgs(argv: string[]): ExtendedDbArgs;
export function resolveExtendedDbCommandTimeoutMs(raw: unknown, fallbackMs: number): number;
export function resolveExtendedDbStepTimeoutMs(env: NodeJS.ProcessEnv): number;
export function main(argv?: string[]): Promise<number>;
