/** Shared by fresh quota observations and retained-record reads of this declaration. */
export const CLAUDE_ACCOUNT_USAGE_PLAN_METADATA = {
  planLabels: {
    pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise',
    max_5x: 'Claude Max 5x', max_20x: 'Claude Max 20x',
  },
} as const;
