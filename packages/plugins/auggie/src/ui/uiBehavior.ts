export const HAPPIER_AUGGIE_ALLOW_INDEXING_ENV_VAR = 'HAPPIER_AUGGIE_ALLOW_INDEXING' as const;
export const AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING = 'allowIndexing' as const;

type AuggieUiEnvironmentVariables = Record<string, string> | undefined;
type AuggieAgentOptionState = Record<string, unknown> | null | undefined;

export type AuggieAllowIndexingChipInput = Readonly<{
  allowIndexing: boolean;
  setAllowIndexing: (next: boolean) => void;
}>;

export type AuggieUiBehaviorDependencies<TChip> = Readonly<{
  createAllowIndexingChip: (input: AuggieAllowIndexingChipInput) => TChip;
}>;

export function applyAuggieAllowIndexingEnv(
  env: AuggieUiEnvironmentVariables,
  allowIndexing: boolean,
): AuggieUiEnvironmentVariables {
  if (allowIndexing !== true) return env;
  return { ...(env ?? {}), [HAPPIER_AUGGIE_ALLOW_INDEXING_ENV_VAR]: '1' };
}

function readAuggieAllowIndexingFromAgentOptionState(agentOptionState: AuggieAgentOptionState): boolean {
  return agentOptionState?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
}

export function createAuggieUiBehaviorOverride<TChip>(
  deps: AuggieUiBehaviorDependencies<TChip>,
) {
  return {
    newSession: {
      buildNewSessionOptions: ({ agentOptionState }: {
        agentOptionState?: Record<string, unknown> | null;
      }) => {
        const allowIndexing = readAuggieAllowIndexingFromAgentOptionState(agentOptionState);
        return { [AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING]: allowIndexing };
      },
      getAgentInputExtraActionChips: ({ agentOptionState, setAgentOptionState }: {
        agentOptionState?: Record<string, unknown> | null;
        setAgentOptionState: (key: string, value: unknown) => void;
      }) => {
        const allowIndexing = readAuggieAllowIndexingFromAgentOptionState(agentOptionState);
        return [
          deps.createAllowIndexingChip({
            allowIndexing,
            setAllowIndexing: (next) => setAgentOptionState(AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING, next),
          }),
        ];
      },
    },
    payload: {
      buildSpawnEnvironmentVariables: ({ environmentVariables, newSessionOptions }: {
        environmentVariables?: Record<string, string> | undefined;
        newSessionOptions?: Record<string, unknown> | null;
      }) => {
        const allowIndexing = newSessionOptions?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
        return applyAuggieAllowIndexingEnv(environmentVariables, allowIndexing) ?? environmentVariables;
      },
    },
  } as const;
}

export const AUGGIE_UI_BEHAVIOR_OVERRIDE = {
  newSession: {
    buildNewSessionOptions: ({ agentOptionState }: {
      agentOptionState?: Record<string, unknown> | null;
    }) => {
      const allowIndexing = readAuggieAllowIndexingFromAgentOptionState(agentOptionState);
      return { [AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING]: allowIndexing };
    },
  },
  payload: {
    buildSpawnEnvironmentVariables: ({ environmentVariables, newSessionOptions }: {
      environmentVariables?: Record<string, string> | undefined;
      newSessionOptions?: Record<string, unknown> | null;
    }) => {
      const allowIndexing = newSessionOptions?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
      return applyAuggieAllowIndexingEnv(environmentVariables, allowIndexing) ?? environmentVariables;
    },
  },
} as const;
