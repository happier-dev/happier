export const AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING = 'allowIndexing' as const;

type AuggieAgentOptionState = Record<string, unknown> | null | undefined;
type AuggieSessionConfigOptionOverrides = Readonly<{
  v: 1;
  updatedAt: number;
  overrides: Readonly<Record<string, Readonly<{
    updatedAt: number;
    value: string | number | boolean | null;
  }>>>;
}>;

function readAuggieAllowIndexingFromAgentOptionState(agentOptionState: AuggieAgentOptionState): boolean {
  return agentOptionState?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
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
    buildSpawnSessionExtras: ({
      newSessionOptions,
      sessionConfigOptionOverrides,
      updatedAt,
    }: {
      newSessionOptions?: Record<string, unknown> | null;
      sessionConfigOptionOverrides?: AuggieSessionConfigOptionOverrides | null;
      updatedAt?: number;
    }) => {
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
        return {};
      }
      if (!Object.prototype.hasOwnProperty.call(
        newSessionOptions ?? {},
        AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING,
      )) {
        return {};
      }
      const allowIndexing = newSessionOptions?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
      return {
        sessionConfigOptionOverrides: {
          ...(sessionConfigOptionOverrides ?? {}),
          v: 1 as const,
          updatedAt,
          overrides: {
            ...(sessionConfigOptionOverrides?.overrides ?? {}),
            [AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING]: {
              updatedAt,
              value: allowIndexing,
            },
          },
        },
      };
    },
  },
} as const;
