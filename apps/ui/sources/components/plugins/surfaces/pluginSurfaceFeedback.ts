import type {
    InteractionTransientRequesterV1,
    PluginActionCurrentIntentRequest,
    PluginActionCurrentIntentResult,
    PluginProjectedActionV2,
} from '@happier-dev/protocol';
import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { createAppShellTransientInteractions } from '@/components/appShell/plugins/appShellQuestionInteractions';
import {
    publishPresentationNotice,
    retirePresentationNotice,
    type PresentationNoticeSeverity,
} from '@/components/sessions/presentation/presentationNotices';

import type {
    PluginSurfaceHostApiMethodHandler,
    PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';
import { createPluginSurfaceHostApiError } from './createPluginSurfaceHostApi';

/**
 * The mounted `notify` / `confirm` handlers (§3.4).
 *
 * Both delegate to Happier's existing owners rather than introducing a
 * plugin-only feedback, confirmation or approval concept (UI-T21):
 *
 * - `notify` publishes to the app's single presentation notice owner, the same
 *   one the daemon `PresentationService.notify` command stream drives;
 * - `confirm` presents through the app-scope transient Interaction owner; the
 *   host adapter only maps its typed settlement back to the public UI method.
 *
 * `confirm` deliberately does NOT call `Modal.confirm` directly. That was a
 * second confirmation lifecycle for one concept, and because it could only check
 * currentness before opening the dialog, a surface that retired while the user
 * was still deciding still received a boolean settlement (§3.5, r0.9).
 *
 * Neither bypasses ActionSpec present-user policy: an action's intrinsic
 * confirmation stays with the Action executor, and these methods carry no
 * approval semantics.
 */
const NOTIFY_SEVERITIES: readonly PresentationNoticeSeverity[] = Object.freeze([
    'info',
    'warning',
    'error',
]);

function readRecord(value: PluginUiJsonValueV1 | undefined): Readonly<Record<string, PluginUiJsonValueV1>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, PluginUiJsonValueV1>>
        : null;
}

function readMessage(payload: Readonly<Record<string, PluginUiJsonValueV1>> | null): string | null {
    const message = payload?.message;
    return typeof message === 'string' && message.trim().length > 0 ? message : null;
}

function readSeverity(payload: Readonly<Record<string, PluginUiJsonValueV1>> | null): PresentationNoticeSeverity {
    const severity = payload?.severity;
    return typeof severity === 'string' && NOTIFY_SEVERITIES.includes(severity as PresentationNoticeSeverity)
        ? severity as PresentationNoticeSeverity
        : 'info';
}

function readTitle(payload: Readonly<Record<string, PluginUiJsonValueV1>> | null): string | null {
    const title = payload?.title;
    return typeof title === 'string' && title.trim().length > 0 ? title : null;
}

function readConfirmationText(
    value: string | Readonly<{ key: string; fallback: string }>,
): string {
    return typeof value === 'string' ? value : value.fallback;
}

function invalidPayload(reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('invalid_payload', [reason]);
}

function staleSurface(): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('stale_surface', ['plugin_ui_generation_retired']);
}

export type CreatePluginSurfaceFeedbackHandlersInput = Readonly<{
    /** The surface whose retirement retires this plugin's pending feedback. */
    surfaceId: string;
    /** Exact mounted provenance; without it confirmation fails closed. */
    interactionRequester?: InteractionTransientRequesterV1;
    /** Host-owned currentness: a retired mount must not reach the user. */
    isCurrent?: () => boolean;
}>;

export type PluginSurfaceFeedbackHandlers = Readonly<{
    notify: PluginSurfaceHostApiMethodHandler;
    confirm: PluginSurfaceHostApiMethodHandler;
    /**
     * The Action present-user gate consumes this exact incumbent interaction
     * owner; it is not a second confirmation lifecycle for client Actions.
     */
    requestCurrentIntent?: (
        request: PluginActionCurrentIntentRequest<PluginProjectedActionV2>,
    ) => Promise<PluginActionCurrentIntentResult>;
    /** Retire anything this surface put on screen. Idempotent. */
    dispose: () => void;
}>;

export function createPluginActionCurrentIntentHandler(input: Readonly<{
    requester: InteractionTransientRequesterV1;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>): (
    request: PluginActionCurrentIntentRequest<PluginProjectedActionV2>,
) => Promise<PluginActionCurrentIntentResult> {
    const interactions = createAppShellTransientInteractions({
        requester: input.requester,
        signal: input.signal ?? new AbortController().signal,
        isCurrent: input.isCurrent,
    });
    return async (request) => {
        if (!input.isCurrent()) {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_action_generation_retired',
            });
        }
        const confirmation = request.action.confirmation;
        if (!confirmation) {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_action_current_intent_unavailable',
            });
        }
        const title = readConfirmationText(confirmation.title);
        const confirmLabel = confirmation.confirmLabel
            ? readConfirmationText(confirmation.confirmLabel)
            : undefined;
        const outcome = await interactions.confirm({
            kind: 'confirmation',
            title,
            message: confirmation.body
                ? readConfirmationText(confirmation.body)
                : title,
        }, {
            ...(request.signal ? { signal: request.signal } : {}),
            presentationContext: {
                title,
                ...(confirmLabel === undefined ? {} : { confirmLabel }),
            },
        });
        if (!input.isCurrent()) {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_action_generation_retired',
            });
        }
        if (outcome.status === 'approved') {
            return Object.freeze({
                status: 'approved' as const,
                fingerprint: request.fingerprint,
            });
        }
        if (outcome.status === 'declined' || outcome.status === 'userCancelled') {
            return Object.freeze({
                status: 'rejected' as const,
                code: 'plugin_action_current_intent_rejected',
            });
        }
        return Object.freeze({
            status: 'unavailable' as const,
            code: 'plugin_action_current_intent_unavailable',
        });
    };
}

export function createPluginSurfaceFeedbackHandlers(
    input: CreatePluginSurfaceFeedbackHandlersInput,
): PluginSurfaceFeedbackHandlers {
    let sequence = 0;
    let disposed = false;
    const publishedKeys = new Set<string>();
    const isCurrent = (): boolean => !disposed && input.isCurrent?.() !== false;
    /**
     * Retirement of this surface. Disposal aborts it, which is how a confirmation
     * that is still on screen gets dismissed rather than left waiting for an
     * answer nobody can act on.
     */
    const retirement = new AbortController();
    const interactions = input.interactionRequester
        ? createAppShellTransientInteractions({
            requester: input.interactionRequester,
            signal: retirement.signal,
            isCurrent,
        })
        : null;

    const notify: PluginSurfaceHostApiMethodHandler = (
        request: PluginUiHostApiRequestEnvelopeV1,
    ): PluginUiJsonValueV1 => {
        const payload = readRecord(request.payload);
        const message = readMessage(payload);
        if (!message) return invalidPayload('plugin_surface_notify_message_invalid');
        if (!isCurrent()) return staleSurface();
        sequence += 1;
        const key = `plugin-surface:${input.surfaceId}:${sequence}`;
        publishedKeys.add(key);
        publishPresentationNotice({ key, message, severity: readSeverity(payload) });
        return null;
    };

    const confirm: PluginSurfaceHostApiMethodHandler = async (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const payload = readRecord(request.payload);
        const message = readMessage(payload);
        if (!message) return invalidPayload('plugin_surface_confirm_message_invalid');
        if (!isCurrent()) return staleSurface();
        const title = readTitle(payload);
        if (!interactions) {
            return createPluginSurfaceHostApiError(
                'unavailable',
                ['plugin_surface_confirm_requester_unavailable'],
            );
        }
        const outcome = await interactions.confirm({
            kind: 'confirmation',
            message,
            ...(title ? { title } : {}),
        }, {
            // The author's own cancellation is requester cancellation for the
            // whole in-flight window, including a dialog already on screen.
            ...(options?.signal ? { signal: options.signal } : {}),
            presentationContext: { title },
        });
        // `unavailable` is not a decline. The author must be able to tell "the
        // user said no" from "the UI could never deliver an answer", which a bare
        // boolean destroys — so the second becomes a typed host error, stale when
        // this surface retired and plainly unavailable when the app could not
        // present the dialog at all.
        if (outcome.status !== 'approved' && outcome.status !== 'declined' && outcome.status !== 'userCancelled') {
            return isCurrent()
                ? createPluginSurfaceHostApiError(
                    'unavailable',
                    ['plugin_surface_confirm_unavailable'],
                )
                : staleSurface();
        }
        return { confirmed: outcome.status === 'approved' };
    };

    const requestCurrentIntent = interactions && input.interactionRequester
        ? createPluginActionCurrentIntentHandler({
            requester: input.interactionRequester,
            signal: retirement.signal,
            isCurrent,
        })
        : undefined;

    return Object.freeze({
        notify,
        confirm,
        ...(requestCurrentIntent === undefined ? {} : { requestCurrentIntent }),
        dispose: () => {
            if (disposed) return;
            // Ordered deliberately: `disposed` first, so the confirmation owner
            // already reads this surface as non-current when the abort reaches
            // it and settles `unavailable` rather than a decline the user never
            // made. Then abort, which dismisses a dialog still on screen.
            disposed = true;
            retirement.abort();
            for (const key of publishedKeys) retirePresentationNotice(key);
            publishedKeys.clear();
        },
    });
}
