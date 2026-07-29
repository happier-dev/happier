/**
 * Per-run change observation consumed by the coalesced workflow activity publisher (CWF3). The
 * tracker emits this after folding each event; the publisher uses the run-id partitions to decide
 * immediate vs debounced writes. Structurally compatible with the tracker's
 * `WorkflowActivityObservation`.
 */
export type WorkflowActivityObservationLike = Readonly<{
  changedRunIds: readonly string[];
  startedRunIds: readonly string[];
  terminalRunIds: readonly string[];
  statusChangedRunIds: readonly string[];
}>;
