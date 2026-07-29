import { RPC_METHODS, type UiBrowserRecordingCaptureFrameRequestV1 } from '@happier-dev/protocol';

import type { ReverseDesktopBrowserRecordingCaptureUiCall } from '../adapters/reverseCaptureInvoke';

/**
 * The minimal slice of the machine client the reverse capture channel needs: a machine-scoped
 * outbound RPC call to the connected client/UI (W2C-BA-1). Kept as a tiny structural type so this
 * module does not depend on the full `ApiMachineClient` and stays unit-testable against a fake.
 */
export type ReverseCaptureMachineRpcClient = Readonly<{
  callConnectedClientRpc: (
    method: string,
    params: unknown,
    options?: Readonly<{ timeoutMs?: number }>,
  ) => Promise<
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error?: string; errorCode?: string }>
  >;
}>;

export type CreateDesktopReverseBrowserRecordingCaptureUiCallOptions = Readonly<{
  /** Resolves the connected machine client at call time (null when the socket is not yet up). */
  getMachineClient: () => ReverseCaptureMachineRpcClient | null | undefined;
  /** Per-call reverse-RPC timeout. */
  timeoutMs?: number;
}>;

/**
 * Builds the production `callUi` transport for the desktop reverse capture channel: it carries the
 * reference-only `UiBrowserRecordingCaptureFrameRequestV1` over the persistent machine socket via
 * `callConnectedClientRpc(RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME)`. On success it returns the
 * UI's raw (already-decrypted) response for the reverse-invoke adapter to validate against the shared
 * contract. On ANY transport failure — no machine socket, no desktop UI registered, timeout — it
 * THROWS, so the reverse-invoke adapter maps it to a fail-closed `ui_unavailable` result and the
 * recording producer honestly reports it cannot capture (never a fabricated frame).
 */
export function createDesktopReverseBrowserRecordingCaptureUiCall(
  options: CreateDesktopReverseBrowserRecordingCaptureUiCallOptions,
): ReverseDesktopBrowserRecordingCaptureUiCall {
  return async (payload: UiBrowserRecordingCaptureFrameRequestV1): Promise<unknown> => {
    const client = options.getMachineClient();
    if (!client) {
      throw new Error('reverse_capture_machine_client_unavailable');
    }
    const response = await client.callConnectedClientRpc(
      RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
      payload,
      options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
    );
    if (!response.ok) {
      throw new Error(response.errorCode ?? response.error ?? 'reverse_capture_rpc_failed');
    }
    return response.result;
  };
}
