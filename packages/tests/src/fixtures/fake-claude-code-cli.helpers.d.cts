type HookForwarderCommand =
  | { type: 'raw'; command: string }
  | { type: 'node'; scriptPath: string; port: number };

export function findArgValue(argv: string[], name: string): string | null;
export function parseMcpConfigs(argv: string[]): Array<Record<string, unknown>>;
export function mergeMcpServers(configs: Array<Record<string, unknown>>): Record<string, unknown>;
export function parseHookForwarderCommand(settingsPath: string | null | undefined): HookForwarderCommand | null;
export function runHookForwarder(params: {
  hook: HookForwarderCommand | null | undefined;
  payload: unknown;
  logPath?: string;
  invocationId?: string;
  spawnImpl?: (...args: unknown[]) => unknown;
}): Promise<void>;
