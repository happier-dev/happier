import { uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { BrowserPasskeysApplyV1Schema, BrowserProfileLoginsImportResultV1Schema,
  type BrowserProfileLoginsImportResultV1 } from '@happier-dev/protocol/browser/profile/v1';
import type { ReverseCaptureMachineRpcClient } from '../recording/reverseChannel/desktopReverseCaptureUiCall';
import type { BrowserSidecarContextCaptureSurface } from '../sidecar/controlAdapter';
import type { BrowserProfilePasskeyActivation } from './passkeys';

export function createBrowserProfilePasskeyImporter(
  capture: BrowserSidecarContextCaptureSurface | undefined,
  options?: Readonly<{
    activateManaged?: (request: BrowserProfilePasskeyActivation) => Promise<BrowserProfileLoginsImportResultV1>;
    getNativeClient?: () => ReverseCaptureMachineRpcClient | null | undefined;
  }>,
) {
  return async (input: unknown, signal?: AbortSignal): Promise<BrowserProfileLoginsImportResultV1> => {
    const parsed = BrowserPasskeysApplyV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'unavailable', code: 'source_format_unsupported' };
    if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
    const request = parsed.data;
    if (capture?.resolvePageHandle(request)) {
      return options?.activateManaged ? options.activateManaged({ ...request, signal })
        : { status: 'unavailable', code: 'engine_unsupported' };
    }
    const client = options?.getNativeClient?.();
    if (!client) return { status: 'unavailable', code: 'destination_unavailable' };
    try {
      // Native webviews use their OS passkey provider. Imported keys never cross the renderer
      // boundary, including when the view changed engines after the destination probe.
      const response = await client.callConnectedClientRpc(uiBrowserAutomationDispatchMethod(request), {
        browserSessionId: request.browserSessionId, viewId: request.viewId, profileId: request.profileId, credentials: [],
      }, { timeoutMs: null, signal, answeringClient: { requireSingle: true } });
      if (signal?.aborted) return { status: 'unavailable', code: 'canceled' };
      if (response.ok) {
        const result = BrowserProfileLoginsImportResultV1Schema.safeParse(response.result);
        if (result.success) return result.data.status === 'unavailable' ? result.data
          : { status: 'unavailable', code: 'passkey_import_unavailable' };
      }
    } catch {
      // Native transport exceptions may contain material supplied to the private RPC.
    }
    return { status: 'unavailable', code: signal?.aborted ? 'canceled' : 'destination_unavailable' };
  };
}
