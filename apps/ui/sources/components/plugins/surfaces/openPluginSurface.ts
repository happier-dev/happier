import {
    PluginUiOpenSurfaceRequestV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiOpenSurfaceRequestV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

/**
 * The canonical `openSurface` host request (EU-5a).
 *
 * One Protocol-owned shape serves every producer: the declarative
 * `{ kind: 'openSurface' }` action descriptor and the public mounted-surface
 * host API. A destination is always exact qualified contribution identity;
 * caller-scoped strings are not a navigation contract.
 *
 * `input` is absent, never defaulted: a destination that was opened without
 * input must be able to tell that apart from one opened with `null` or `{}`.
 */
export type PluginSurfaceOpenRequest = PluginUiOpenSurfaceRequestV1;

/**
 * A placement that can select a destination answers with a typed outcome. A
 * destination it cannot resolve is a failure the caller observes, not a silent
 * no-op — the public method returns a promise, and resolving it after doing
 * nothing is indistinguishable from success.
 */
export type PluginSurfaceOpenOutcome =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; code: PluginUiHostApiErrorCodeV1; reason: string }>;

export type PluginSurfaceOpenHandler = (
    request: PluginSurfaceOpenRequest,
) => PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome>;

/**
 * The mounted `openSurface` handler parses the public envelope through the
 * single Protocol request owner, then defers destination resolution and
 * selection to the placement that supplied {@link handler}.
 */
export function createPluginSurfaceOpenSurfaceHandler(
    handler: PluginSurfaceOpenHandler,
    isCurrent?: () => boolean,
): PluginSurfaceHostApiMethodHandler {
    return async (request: PluginUiHostApiRequestEnvelopeV1): Promise<PluginUiJsonValueV1> => {
        // `openSurface` is a visible navigation request, but it is still a
        // mount-scoped host operation. A route/pane admission that settles after
        // the source mount retired must not report success to a replacement
        // Account, generation, or renderer.
        if (isCurrent?.() === false) {
            return { code: 'stale_surface', diagnostics: ['plugin_surface_retired'] };
        }
        const parsed = PluginUiOpenSurfaceRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) {
            return { code: 'invalid_payload', diagnostics: ['plugin_surface_open_payload_invalid'] };
        }

        const outcome = await handler(parsed.data);
        if (isCurrent?.() === false) {
            return { code: 'stale_surface', diagnostics: ['plugin_surface_retired'] };
        }
        return outcome.ok
            ? null
            : { code: outcome.code, diagnostics: [outcome.reason] };
    };
}
