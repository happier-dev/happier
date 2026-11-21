type HookForwarderCommand =
  | { type: 'raw'; command: string }
  | {
      type: 'node';
      runtimeExecutable: string;
      scriptPath: string;
      port: number;
      hookEventName?: string;
      secretFile?: string;
    };

export function findArgValue(argv: string[], name: string): string | null;
export function fakeClaudeEchoResponseText(promptText: string): string;
export function fakeClaudeEchoResponseTextFromSha256(promptSha256: string): string;
export function parseMcpConfigs(argv: string[]): Array<Record<string, unknown>>;
export function mergeMcpServers(configs: Array<Record<string, unknown>>): Record<string, unknown>;
export function parseHookForwarderCommand(argv: string[]): HookForwarderCommand | null;
export function runHookForwarder(params: {
  hook: HookForwarderCommand | null | undefined;
  payload: unknown;
  logPath?: string;
  invocationId?: string;
  spawnImpl?: (...args: unknown[]) => unknown;
}): Promise<void>;
