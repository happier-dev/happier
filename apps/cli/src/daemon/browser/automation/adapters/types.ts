import type {
  BrowserAutomationActionKindV1,
  BrowserAutomationActionRequestV1,
  BrowserAutomationActionStatusV1,
  BrowserAutomationErrorCodeV1,
  BrowserAutomationFidelityV1,
  BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';

/**
 * The leaf result a browser automation adapter produces for a single action. The
 * automation action runtime (`actions.ts`) wraps this into the full protocol
 * `BrowserAutomationActionResultV1` + timeline entry, applying navigation/epoch
 * accounting and redaction. Adapters only describe the outcome of the CDP/stream
 * boundary — they never own lease/timeline state.
 */
export type BrowserAutomationAdapterExecuteResult = Readonly<{
  status: BrowserAutomationActionStatusV1;
  fidelity: BrowserAutomationFidelityV1;
  trustedInput: boolean;
  errorCode?: BrowserAutomationErrorCodeV1;
  resultSummary?: Readonly<Record<string, unknown>>;
  diagnostics?: Readonly<Record<string, unknown>>;
}>;

export type BrowserAutomationAdapter = Readonly<{
  adapterKind: BrowserSemanticAdapterKindV1;
  /**
   * The action kinds this adapter (i.e. this host/engine version) can actually perform. When
   * present, the daemon service
   * negotiates UP-FRONT: a request for an operation outside this set fails closed with
   * `unsupported_action` BEFORE any lease acquisition or dispatch, so a mixed host-version /
   * engine-skew can never silently mis-route a verb the host does not support. When omitted, the
   * adapter accepts every kind and surfaces its own per-action outcome (legacy/declared-fail-closed
   * adapters).
   */
  supportedOperations?: ReadonlySet<BrowserAutomationActionKindV1>;
  execute(request: BrowserAutomationActionRequestV1): Promise<BrowserAutomationAdapterExecuteResult>;
}>;
