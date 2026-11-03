import { BrowserCookieApplyV1Schema, BrowserPasskeysApplyV1Schema, type BrowserProfileLoginsImportResultV1 } from '@happier-dev/protocol/browser/profile/v1';
import { applyDesktopBrowserLoginCookies, getDesktopBrowserNativePasskeyAvailability } from '../adapters/desktopWebViewBridge';
import { UiBrowserAutomationDispatchRequestV1Schema, UiBrowserAutomationDispatchResultV1Schema, MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { createBrowserRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { readRegisteredBrowserRuntimeAutomationAdapter, readRegisteredBrowserRuntimeControlAdapter, readRegisteredBrowserRuntimeDiagnosticsAdapter } from '../actions/runtimeControlRegistry';

function nativeProfileDestinationRefusal(
  target: Readonly<{ browserSessionId: string; viewId: string }>,
  view: Readonly<{ browserSessionId: string; viewId: string }>,
): Extract<BrowserProfileLoginsImportResultV1, { status: 'unavailable' }> | null {
  if (target.browserSessionId !== view.browserSessionId || target.viewId !== view.viewId) {
    return { status: 'unavailable', code: 'destination_unavailable' };
  }
  const currentView = readRegisteredBrowserRuntimeControlAdapter(view.browserSessionId, view.viewId)
    ?.readState()?.viewsById[view.viewId];
  if (!currentView || currentView.browserSessionId !== view.browserSessionId) {
    return { status: 'unavailable', code: 'destination_unavailable' };
  }
  return currentView.engineKind === 'desktopWebView' || currentView.engineKind === 'nativeWebView'
    ? null : { status: 'unavailable', code: 'engine_unsupported' };
}

const unavailable = { ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_view_unavailable' } as const;
const invalid = { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } as const;

export async function handleUiBrowserAutomationDispatchRequest(
  rawRequest: unknown,
  view: Readonly<{ browserSessionId: string; viewId: string; sessionId: string }>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<unknown> {
  // The Machine's private import continuation consumes the same view/profile binding without
  // re-entering Action admission. The existing account-scoped reverse channel owns transport auth.
  const cookies = BrowserCookieApplyV1Schema.safeParse(rawRequest);
  if (cookies.success) {
    const refusal = nativeProfileDestinationRefusal(cookies.data, view);
    return refusal ?? applyDesktopBrowserLoginCookies(cookies.data, options?.signal);
  }
  const passkeys = BrowserPasskeysApplyV1Schema.safeParse(rawRequest);
  if (passkeys.success) {
    const refusal = nativeProfileDestinationRefusal(passkeys.data, view);
    if (refusal) return refusal;
    // Native views use origin-bound OS ceremonies; imported keys never enter native IPC.
    const { browserSessionId, viewId, profileId } = passkeys.data;
    const availability = await getDesktopBrowserNativePasskeyAvailability({ browserSessionId, viewId, profileId }, options?.signal);
    return availability.status === 'available' ? { status: 'unavailable', code: 'passkey_import_unavailable' } : availability;
  }
  const request = UiBrowserAutomationDispatchRequestV1Schema.safeParse(rawRequest);
  if (!request.success) return invalid;
  if (request.data.sessionId !== view.sessionId) return unavailable;
  const parsed = getActionSpec(request.data.actionId).inputSchema.safeParse(request.data.input);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') return invalid;
  const target = parsed.data as Readonly<{ browserSessionId?: unknown; viewId?: unknown }>;
  if (target.browserSessionId !== view.browserSessionId || target.viewId !== view.viewId) return unavailable;
  const control = readRegisteredBrowserRuntimeControlAdapter(view.browserSessionId, view.viewId);
  if (!control) return unavailable;
  const currentView = control.readState()?.viewsById[view.viewId];
  if (!currentView || currentView.browserSessionId !== view.browserSessionId) return unavailable;
  const automation = readRegisteredBrowserRuntimeAutomationAdapter(view.browserSessionId, view.viewId);
  const isDiagnostics = (MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS as readonly string[]).includes(request.data.actionId);
  const diagnostics = isDiagnostics ? readRegisteredBrowserRuntimeDiagnosticsAdapter(view.browserSessionId, view.viewId) : null;
  if (isDiagnostics ? !diagnostics : request.data.actionId !== 'browser.view.openExternal' && !automation?.controlService) return unavailable;
  if (options?.signal?.aborted) return unavailable;
  const execute = createBrowserRuntimeActionExecutor({ control, ...(automation ? { automation } : {}), ...(diagnostics ? { diagnostics } : {}) });
  const result = await execute({ actionId: request.data.actionId, input: parsed.data, context: {
    surface: 'agent', authority: request.data.authority, defaultSessionId: request.data.sessionId, signal: options?.signal,
  } });
  const response = UiBrowserAutomationDispatchResultV1Schema.safeParse(result);
  return response.success ? response.data : unavailable;
}
