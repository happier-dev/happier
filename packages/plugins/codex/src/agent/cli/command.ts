export type CodexCliRuntimeMode = 'terminal' | 'remote';
export type CodexHostStartingMode = 'local' | 'remote';

export type CodexCliSessionExtraOptions = Readonly<{
  startingMode?: CodexHostStartingMode;
  directory?: string;
  codexArgs?: readonly string[];
}>;

export type CodexCliSessionParsedArgs = Readonly<{
  startingMode?: string;
  directory?: string;
  providerArgs: readonly string[];
}>;

export type CodexCliSessionExtraOptionsResult =
  | Readonly<{ ok: true; options: CodexCliSessionExtraOptions }>
  | Readonly<{ ok: false; errorMessage: string }>;

export const codexCliSessionCommandConfig = {
  backendIdForSessionRuntime: 'codex',
  agentIdForAccountSettings: 'codex',
  directoryFlags: ['-C', '--cd'],
  forwardModelFlag: true,
  versionFlags: ['-V', '--version'],
} as const;

export function codexRuntimeModeToHostStartingMode(
  runtimeMode: CodexCliRuntimeMode,
): CodexHostStartingMode {
  return runtimeMode === 'terminal' ? 'local' : 'remote';
}

function resolveCodexRuntimeMode(raw: string | undefined): CodexCliRuntimeMode | undefined {
  if (raw === 'terminal' || raw === 'remote') {
    return raw;
  }
  return undefined;
}

export function resolveCodexCliSessionExtraOptions(
  parsed: CodexCliSessionParsedArgs,
): CodexCliSessionExtraOptionsResult {
  const startingRuntimeModeRaw = parsed.startingMode;
  const startingRuntimeMode = resolveCodexRuntimeMode(startingRuntimeModeRaw);
  if (startingRuntimeModeRaw && !startingRuntimeMode) {
    return {
      ok: false,
      errorMessage: `Invalid --happy-starting-mode: ${startingRuntimeModeRaw}. Use "terminal" or "remote".`,
    };
  }

  return {
    ok: true,
    options: {
      ...(startingRuntimeMode
        ? { startingMode: codexRuntimeModeToHostStartingMode(startingRuntimeMode) }
        : {}),
      ...(parsed.directory ? { directory: parsed.directory } : {}),
      ...(parsed.providerArgs.length > 0 ? { codexArgs: [...parsed.providerArgs] } : {}),
    },
  };
}
