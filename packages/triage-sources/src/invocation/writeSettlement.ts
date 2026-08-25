/**
 * The source-neutral settlement of an at-most-once provider write.
 *
 * The provider still owns every policy decision: which operation is at-most-once, which response
 * proves that no effect was attempted, what an authoritative read is, and what that read means.
 * This owner supplies only the lifecycle those decisions share: invoke the dispatch closure once;
 * when its provider-owned classification says state may have changed, invoke the confirming read
 * once; never turn an answer-lost timeout or transport failure into a blind retry.
 *
 * Naturally idempotent writes do not need this owner to manufacture a retry policy. They remain on
 * the provider client's ordinary request policy when that provider contract permits it.
 */

export type ProviderWriteConfirmation<TObservation, TFailure> =
  | Readonly<{ kind: 'applied'; observation: TObservation }>
  | Readonly<{ kind: 'unchanged'; observation: TObservation }>
  | Readonly<{ kind: 'uncertain'; observation?: TObservation; failure?: TFailure }>;

export type AtMostOnceProviderWriteSettlement<TDispatch, TObservation, TFailure> =
  | Readonly<{ kind: 'settled'; result: TDispatch }>
  | ProviderWriteConfirmation<TObservation, TFailure>;

export async function settleAtMostOnceProviderWrite<TDispatch, TObservation, TFailure>(input: Readonly<{
  dispatch(): Promise<TDispatch>;
  /** Provider-owned classification: true only when this dispatch may have changed remote state. */
  mayHaveChanged(result: TDispatch): boolean;
  /** One authoritative provider read, already reduced to applied, unchanged, or uncertain. */
  confirm(): Promise<ProviderWriteConfirmation<TObservation, TFailure>>;
}>): Promise<AtMostOnceProviderWriteSettlement<TDispatch, TObservation, TFailure>> {
  const result = await input.dispatch();
  if (!input.mayHaveChanged(result)) return Object.freeze({ kind: 'settled', result });
  return await input.confirm();
}
