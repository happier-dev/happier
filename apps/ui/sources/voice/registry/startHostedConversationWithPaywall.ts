type HostedConversationAdmission =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: string }>;

function admissionAborted(): Error {
  return Object.assign(new Error('hosted_conversation_attempt_aborted'), {
    name: 'AbortError',
    code: 'hosted_conversation_attempt_aborted',
  });
}

/**
 * Keeps app purchase UI at the exact hosted-authority boundary. Provider
 * leaves observe only a final admission result and never receive a modal host.
 */
export async function startHostedConversationWithPaywall<
  TResult extends HostedConversationAdmission,
>(input: Readonly<{
  start(): Promise<TResult>;
  presentPaywall(): Promise<Readonly<{ purchased: boolean }>>;
  signal: AbortSignal;
}>): Promise<TResult> {
  if (input.signal.aborted) throw admissionAborted();
  const initial = await input.start();
  if (input.signal.aborted) throw admissionAborted();
  if (initial.allowed
    || (initial.reason !== 'subscription_required' && initial.reason !== 'quota_exceeded')) {
    return initial;
  }
  const purchase = await input.presentPaywall();
  if (input.signal.aborted) throw admissionAborted();
  if (!purchase.purchased) return initial;
  const retried = await input.start();
  if (input.signal.aborted) throw admissionAborted();
  return retried;
}
