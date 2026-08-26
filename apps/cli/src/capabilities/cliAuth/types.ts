import type { AgentCliAuthStatusV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export type CliAuthState = AgentCliAuthStatusV1['state'];

export type CliAuthMethod = NonNullable<AgentCliAuthStatusV1['method']>;

export type CliAuthReason = NonNullable<AgentCliAuthStatusV1['reason']>;

export type CliAuthSource = NonNullable<AgentCliAuthStatusV1['source']>;

export type CliAuthStatus = AgentCliAuthStatusV1 & Readonly<{
  checkedAt: number;
}>;

export type CliAuthStatusDraft = AgentCliAuthStatusV1;

export type CliAuthSpec = Readonly<{
  binaryNames: ReadonlyArray<string>;
  /**
   * Absent legacy/external declarations are intentionally unsafe. The value is
   * derived from the strict manifest auth facts, never from an Agent parser.
   */
  isSafeForBackgroundChecks: boolean;
  detectAuthStatus?: (args: Readonly<{ resolvedPath: string }>) => Promise<CliAuthStatusDraft>;
}>;
