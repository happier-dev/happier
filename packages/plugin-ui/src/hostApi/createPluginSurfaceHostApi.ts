import {
  PluginUiSurfaceContextV1Schema,
  type PluginUiHostApiErrorCodeV1,
  type PluginUiHostApiMethodV1,
  type PluginUiHostApiRequestEnvelopeV1,
  type PluginUiJsonValueV1,
  type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

/**
 * Phase 1.3 — the canonical scope-aware plugin-surface host-API factory.
 *
 * Every surface mount (app/session/project/workspace/services/browser, native
 * host / embedded / RN / hosted-web) constructs its host API through THIS owner
 * instead of omitting it (the previous state: only `browser.panel` built one).
 *
 * The factory OWNS the protocol-shaped request routing:
 *   - `getSurfaceContext` is answered locally from the supplied scope context
 *     (closing finding #10 — it was advertised but never mapped).
 *   - every other method is routed to an injected handler; an unhandled method
 *     fails closed with `unavailable`.
 *
 * The factory is intentionally side-effect free: the app supplies the concrete
 * `copy`/`openExternal`/`dispatchAction`/`openSurface`/resource handlers, so this
 * pure package never reaches into React Native, clipboard, or sync internals.
 */

export type PluginSurfaceHostApiV1 = Readonly<{
  platform: PluginUiSurfaceContextV1['platform'];
  channel: PluginUiSurfaceContextV1['channel'];
  handleRequest: (
    request: PluginUiHostApiRequestEnvelopeV1,
  ) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;
}>;

export type PluginSurfaceHostApiMethodHandler = (
  request: PluginUiHostApiRequestEnvelopeV1,
) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;

/**
 * Per-method handlers the surface mount supplies. Any method left unset fails
 * closed (`unavailable`). `getSurfaceContext` is intentionally NOT overridable —
 * it is owned by the factory and answered from the scope context.
 */
export type PluginSurfaceHostApiHandlers = Partial<
  Record<
    Exclude<PluginUiHostApiMethodV1, 'getSurfaceContext'>,
    PluginSurfaceHostApiMethodHandler
  >
>;

function errorPayload(
  code: PluginUiHostApiErrorCodeV1,
  diagnostics: readonly string[] = [],
): PluginUiJsonValueV1 {
  return { code, diagnostics: [...diagnostics] };
}

export type CreatePluginSurfaceHostApiInput = Readonly<{
  /**
   * The resolved surface scope context (Phase 1.2 supplies `resourceScope` +
   * `placement` + `targetKind`-derived fields). Returned verbatim from
   * `getSurfaceContext`.
   */
  surfaceContext: PluginUiSurfaceContextV1;
  handlers?: PluginSurfaceHostApiHandlers;
  /**
   * Optional fallback for methods with no declared handler (e.g. the browser
   * panel host API delegating non-`dispatchAction` methods). When absent, an
   * unhandled method fails closed with `unavailable`.
   */
  fallback?: PluginSurfaceHostApiMethodHandler;
}>;

/**
 * Fail-closed host API returned when the supplied surface context cannot be validated.
 * Every method (including `getSurfaceContext`, handlers, and the fallback) responds with
 * `invalid_payload` and a diagnostic instead of the factory throwing. Sentinel
 * `platform`/`channel` are the most-restrictive safe values (web / store). (F8)
 */
function createDisabledPluginSurfaceHostApi(
  diagnostics: readonly string[],
): PluginSurfaceHostApiV1 {
  const failClosed = (): PluginUiJsonValueV1 =>
    errorPayload('invalid_payload', diagnostics);
  return Object.freeze({
    platform: 'web',
    channel: 'store',
    handleRequest: failClosed,
  });
}

export function createPluginSurfaceHostApi(
  input: CreatePluginSurfaceHostApiInput,
): PluginSurfaceHostApiV1 {
  const parsedContext = PluginUiSurfaceContextV1Schema.safeParse(input.surfaceContext);
  if (!parsedContext.success) {
    return createDisabledPluginSurfaceHostApi([
      'host_api_surface_context_invalid',
      ...parsedContext.error.issues.map(
        (issue) => `surface_context:${issue.path.join('.') || '<root>'}:${issue.code}`,
      ),
    ]);
  }
  const surfaceContext = parsedContext.data;
  const handlers = input.handlers ?? {};

  return Object.freeze({
    platform: surfaceContext.platform,
    channel: surfaceContext.channel,
    handleRequest: (
      request: PluginUiHostApiRequestEnvelopeV1,
    ): PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1> => {
      // getSurfaceContext is owned by the factory (finding #10).
      if (request.method === 'getSurfaceContext') {
        return surfaceContext;
      }

      const handler = handlers[request.method];
      if (handler) {
        return handler(request);
      }
      if (input.fallback) {
        return input.fallback(request);
      }
      return errorPayload('unavailable', [`host_api_method_unavailable:${request.method}`]);
    },
  });
}
