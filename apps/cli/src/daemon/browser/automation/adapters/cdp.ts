import {
  isBrowserAutomationMutatingActionKind,
  type BrowserAutomationActionKindV1,
  type BrowserAutomationActionRequestV1,
  type BrowserAutomationErrorCodeV1,
  type BrowserCommandDispatchResultV1,
  type BrowserCommandV1,
} from '@happier-dev/protocol';

import type { BrowserAutomationViewRef } from '../owners';
import type {
  BrowserAutomationAdapter,
  BrowserAutomationAdapterExecuteResult,
} from './types';

export type BrowserAutomationCdpPageQueryInput = BrowserAutomationViewRef & Readonly<{
  actionKind: BrowserAutomationActionKindV1;
  navigationGeneration: number;
  payload: Readonly<Record<string, unknown>>;
}>;

export type BrowserAutomationCdpPageQueryResult =
  | Readonly<{ ok: true; data?: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; errorCode?: BrowserAutomationErrorCodeV1 }>;

export type BrowserAutomationCdpInputInput = BrowserAutomationViewRef & Readonly<{
  actionKind: BrowserAutomationActionKindV1;
  navigationGeneration: number;
  payload: Readonly<Record<string, unknown>>;
}>;

export type BrowserAutomationCdpInputResult =
  | Readonly<{ ok: true; data?: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; errorCode?: BrowserAutomationErrorCodeV1 }>;

/**
 * The CDP boundary the automation adapter drives. Navigation maps onto the existing
 * chromiumSidecar control command surface; read-only queries map onto a CDP page
 * query. This is the only seam that touches Chromium — lease/timeline/redaction stay
 * in the daemon service and are tested for real.
 */
export type BrowserAutomationCdpTransport = Readonly<{
  ownsView(view: BrowserAutomationViewRef): boolean;
  dispatchControlCommand(command: BrowserCommandV1): Promise<BrowserCommandDispatchResultV1>;
  dispatchPageQuery(
    input: BrowserAutomationCdpPageQueryInput,
  ): Promise<BrowserAutomationCdpPageQueryResult>;
  /**
   * Mutating-input transport (MCH-4): click/tap/type/press/scroll/hover/focus/select/setValue
   * dispatch over the SAME live CDP transport via `Input.dispatch*`/DOM commands. Optional so an
   * adapter without a live CDP surface (in-memory/QA) leaves mutating-input fail-closed.
   */
  dispatchInputCommand?(
    input: BrowserAutomationCdpInputInput,
  ): Promise<BrowserAutomationCdpInputResult>;
}>;

const READ_ONLY_QUERY_ACTIONS = new Set<BrowserAutomationActionKindV1>([
  'getStatus',
  'snapshot',
  'semanticSnapshot',
  'queryElements',
  'getDiagnosticsSummary',
  'waitFor',
]);

const NAVIGATION_ACTIONS: readonly BrowserAutomationActionKindV1[] = [
  'navigate',
  'reload',
  'goBack',
  'goForward',
];

// Mutating-input verbs that ride the CDP `Input.dispatch*`/DOM transport (MCH-4). The adapter only
// advertises these in `supportedOperations` when the live input transport is bound, so a host whose
// CDP surface lacks the input transport negotiates them away (engine-skew fail-closed) instead of
// mis-routing the verb.
const CDP_INPUT_ACTIONS: readonly BrowserAutomationActionKindV1[] = [
  'click',
  'tap',
  'type',
  'press',
  'scroll',
  'hover',
  'focus',
  'select',
  'setValue',
];

function resolveCdpSupportedOperations(
  transport: BrowserAutomationCdpTransport,
): ReadonlySet<BrowserAutomationActionKindV1> {
  const operations = new Set<BrowserAutomationActionKindV1>([
    ...READ_ONLY_QUERY_ACTIONS,
    ...NAVIGATION_ACTIONS,
  ]);
  if (transport.dispatchInputCommand) {
    for (const actionKind of CDP_INPUT_ACTIONS) {
      operations.add(actionKind);
    }
  }
  return operations;
}

function navigationCommand(
  request: BrowserAutomationActionRequestV1,
): BrowserCommandV1 | null {
  const base = {
    commandId: `automation_${request.automationRequestId}`,
    browserSessionId: request.browserSessionId,
    viewId: request.viewId,
  } as const;
  switch (request.actionKind) {
    case 'navigate': {
      const url = request.payload.url;
      if (typeof url !== 'string' || url.length === 0) return null;
      return { kind: 'navigate', ...base, url };
    }
    case 'reload':
      return { kind: 'reload', ...base };
    case 'goBack':
      return { kind: 'goBack', ...base };
    case 'goForward':
      return { kind: 'goForward', ...base };
    default:
      return null;
  }
}

function controlErrorToAutomationError(
  result: Extract<BrowserCommandDispatchResultV1, { status: 'failed' }>,
): BrowserAutomationErrorCodeV1 {
  switch (result.error.code) {
    case 'view_not_found':
      return 'view_closed';
    case 'permission_denied':
      return 'policy_denied';
    case 'unsupported_command':
      return 'unsupported_action';
    default:
      return 'runtime_unavailable';
  }
}

export function createBrowserAutomationCdpAdapter(input: Readonly<{
  transport: BrowserAutomationCdpTransport;
}>): BrowserAutomationAdapter {
  async function execute(
    request: BrowserAutomationActionRequestV1,
  ): Promise<BrowserAutomationAdapterExecuteResult> {
    const view = { browserSessionId: request.browserSessionId, viewId: request.viewId };
    const trustedInput = !isBrowserAutomationMutatingActionKind(request.actionKind);

    if (!input.transport.ownsView(view)) {
      return { status: 'failed', fidelity: 'unavailable', trustedInput, errorCode: 'view_closed' };
    }

    if (READ_ONLY_QUERY_ACTIONS.has(request.actionKind)) {
      const query = await input.transport.dispatchPageQuery({
        ...view,
        actionKind: request.actionKind,
        navigationGeneration: request.navigationGeneration,
        payload: request.payload,
      });
      if (!query.ok) {
        return {
          status: 'failed',
          fidelity: 'cdp',
          trustedInput,
          errorCode: query.errorCode ?? 'runtime_unavailable',
        };
      }
      return {
        status: 'succeeded',
        fidelity: 'cdp',
        trustedInput,
        ...(query.data ? { resultSummary: query.data } : {}),
      };
    }

    const command = navigationCommand(request);
    if (!command) {
      // Mutating non-navigation verbs (click/tap/type/press/scroll/hover/focus/select/setValue)
      // ride the CDP Input transport (MCH-4). Absent ⇒ honestly unsupported.
      if (input.transport.dispatchInputCommand) {
        const inputResult = await input.transport.dispatchInputCommand({
          ...view,
          actionKind: request.actionKind,
          navigationGeneration: request.navigationGeneration,
          payload: request.payload,
        });
        if (!inputResult.ok) {
          return {
            status: 'failed',
            fidelity: 'cdp',
            trustedInput,
            errorCode: inputResult.errorCode ?? 'runtime_unavailable',
          };
        }
        return {
          status: 'succeeded',
          fidelity: 'cdp',
          trustedInput,
          ...(inputResult.data ? { resultSummary: inputResult.data } : {}),
        };
      }
      return {
        status: 'unsupported',
        fidelity: 'cdp',
        trustedInput,
        errorCode: 'unsupported_action',
      };
    }

    const dispatch = await input.transport.dispatchControlCommand(command);
    if (dispatch.status === 'failed') {
      return {
        status: 'failed',
        fidelity: 'cdp',
        trustedInput,
        errorCode: controlErrorToAutomationError(dispatch),
      };
    }
    return { status: 'succeeded', fidelity: 'cdp', trustedInput };
  }

  return {
    adapterKind: 'chromiumSidecar',
    supportedOperations: resolveCdpSupportedOperations(input.transport),
    execute,
  };
}
