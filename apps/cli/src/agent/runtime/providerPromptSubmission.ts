export class ProviderPromptSubmissionUnconfirmedError extends Error {
  constructor() {
    super('Provider prompt submission was unconfirmed');
    this.name = 'ProviderPromptSubmissionUnconfirmedError';
  }
}

export type ProviderPromptSubmissionRejectedBeforeEffectReason =
  | 'runtime_disposed_before_delivery'
  | 'provider_rejected_before_acceptance'
  | 'provider_unavailable_before_acceptance';

export class ProviderPromptSubmissionRejectedBeforeEffectError extends Error {
  readonly reason: ProviderPromptSubmissionRejectedBeforeEffectReason;
  override readonly cause: unknown;

  constructor(
    reason: ProviderPromptSubmissionRejectedBeforeEffectReason,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ProviderPromptSubmissionRejectedBeforeEffectError';
    this.reason = reason;
    this.cause = cause;
  }
}

export function resolveProviderPromptFailureDeliveryReason(
  error: unknown,
  didAttemptProviderSend: boolean,
): 'ambiguous_terminal_delivery' | ProviderPromptSubmissionRejectedBeforeEffectReason {
  if (error instanceof ProviderPromptSubmissionRejectedBeforeEffectError) {
    return error.reason;
  }
  if (error instanceof ProviderPromptSubmissionUnconfirmedError) {
    return 'ambiguous_terminal_delivery';
  }
  return didAttemptProviderSend
    ? 'ambiguous_terminal_delivery'
    : 'runtime_disposed_before_delivery';
}

export type ProviderPromptSubmissionCallbacks =
  | Readonly<{
      onProviderPromptAccepted?: () => void;
      onProviderPromptSubmitted?: never;
    }>
  | Readonly<{
      onProviderPromptSubmitted: () => Promise<void>;
      onProviderPromptAccepted?: never;
    }>;

export type ProviderPromptWithMeta = Readonly<{
  text: string;
  localId?: string | null;
  meta?: Record<string, unknown>;
}> & ProviderPromptSubmissionCallbacks;

/** Final output captured by the turn owner, independent of subsequent provider activity. */
export type ProviderTurnCompletionResult = Readonly<{
  assistantText: string | null;
}>;
