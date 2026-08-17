import type { InteractionTransientRequesterV1 } from '@happier-dev/protocol';
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

function invalidPayload(reason: string): PluginUiJsonValueV1 {
    return { code: 'invalid_payload', diagnostics: [reason] };
}

function staleSurface(): PluginUiJsonValueV1 {
    return { code: 'stale_surface', diagnostics: ['plugin_ui_generation_retired'] };
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
    /** Retire anything this surface put on screen. Idempotent. */
    dispose: () => void;
}>;

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
            return { code: 'unavailable', diagnostics: ['plugin_surface_confirm_requester_unavailable'] };
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
                ? { code: 'unavailable', diagnostics: ['plugin_surface_confirm_unavailable'] }
                : staleSurface();
        }
        return { confirmed: outcome.status === 'approved' };
    };

    return Object.freeze({
        notify,
        confirm,
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
