export type ClaudeCliSessionParsedArgs = Readonly<{
  startingMode?: string;
  directory?: string;
  resume?: string;
  providerArgs: readonly string[];
}>;

export type ClaudeCliSessionOptions = Readonly<{
  startingMode?: 'terminal' | 'remote';
  directory?: string;
  resume?: undefined;
  claudeArgs?: readonly string[];
  jsRuntime?: 'node' | 'bun';
}>;

export type ClaudeCliSessionOptionsResult =
  | Readonly<{ ok: true; options: ClaudeCliSessionOptions }>
  | Readonly<{ ok: false; errorMessage: string }>;

export const claudeCliSessionCommandConfig = {
  backendIdForSessionRuntime: 'claude',
  agentIdForAccountSettings: 'claude',
  implicitResumeDelegation: {
    resumeFlags: ['--resume', '-r'],
  },
  directoryFlags: ['-C', '--cd'],
  forwardModelFlag: true,
  yoloProviderArgs: ['--dangerously-skip-permissions'],
  versionFlags: ['-v', '--version'],
} as const;

function normalizeStartingMode(value: string | undefined): 'terminal' | 'remote' | undefined {
  if (value === undefined) return undefined;
  if (value === 'remote') return 'remote';
  if (value === 'terminal' || value === 'local') return 'terminal';
  return undefined;
}

function isExplicitClaudeInvocation(args: readonly string[]): boolean {
  return args[0] === 'claude';
}

function appendExplicitResumeArg(params: Readonly<{
  claudeArgs: string[];
  args: readonly string[];
  resume?: string;
}>): boolean {
  if (!isExplicitClaudeInvocation(params.args)) return false;
  if (!params.resume) return false;
  params.claudeArgs.push('--resume', params.resume);
  return true;
}

function readInlineFlagValue(arg: string, flag: string): string | undefined {
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined;
}

function normalizeJsRuntime(value: string | undefined): 'node' | 'bun' | null {
  if (value === 'node' || value === 'bun') return value;
  return null;
}

function consumeClaudeProviderArgs(providerArgs: readonly string[]): Readonly<{
  claudeArgs: string[];
  jsRuntime?: 'node' | 'bun';
  errorMessage?: string;
}> {
  const claudeArgs: string[] = [];
  let jsRuntime: 'node' | 'bun' | undefined;

  for (let index = 0; index < providerArgs.length; index += 1) {
    const arg = providerArgs[index];

    const inlineJsRuntime = readInlineFlagValue(arg, '--js-runtime');
    if (inlineJsRuntime !== undefined) {
      const normalized = normalizeJsRuntime(inlineJsRuntime);
      if (!normalized) {
        return { claudeArgs, errorMessage: `Invalid --js-runtime value: ${inlineJsRuntime}. Must be 'node' or 'bun'.` };
      }
      jsRuntime = normalized;
      continue;
    }

    if (arg === '--js-runtime') {
      const raw = providerArgs[index + 1];
      if (raw !== 'node' && raw !== 'bun') {
        return { claudeArgs, errorMessage: "Missing value for --js-runtime. Must be 'node' or 'bun'." };
      }
      jsRuntime = raw;
      index += 1;
      continue;
    }

    if (arg === '--settings') {
      const next = providerArgs[index + 1];
      if (typeof next === 'string' && !next.startsWith('-')) {
        index += 1;
      }
      continue;
    }

    claudeArgs.push(arg);
  }

  return {
    claudeArgs,
    ...(jsRuntime ? { jsRuntime } : {}),
  };
}

export function resolveClaudeCliSessionOptions(input: Readonly<{
  args: readonly string[];
  parsed: ClaudeCliSessionParsedArgs;
}>): ClaudeCliSessionOptionsResult {
  const startingMode = normalizeStartingMode(input.parsed.startingMode);
  if (input.parsed.startingMode && !startingMode) {
    return {
      ok: false,
      errorMessage: `Invalid --happy-starting-mode: ${input.parsed.startingMode}. Use "terminal" or "remote".`,
    };
  }

  const consumed = consumeClaudeProviderArgs(input.parsed.providerArgs);
  if (consumed.errorMessage) {
    return {
      ok: false,
      errorMessage: consumed.errorMessage,
    };
  }

  const forwardedExplicitResume = appendExplicitResumeArg({
    claudeArgs: consumed.claudeArgs,
    args: input.args,
    resume: input.parsed.resume,
  });

  return {
    ok: true,
    options: {
      ...(startingMode ? { startingMode } : {}),
      ...(input.parsed.directory ? { directory: input.parsed.directory } : {}),
      ...(forwardedExplicitResume ? { resume: undefined } : {}),
      ...(consumed.claudeArgs.length > 0 ? { claudeArgs: consumed.claudeArgs } : {}),
      ...(consumed.jsRuntime ? { jsRuntime: consumed.jsRuntime } : {}),
    },
  };
}
