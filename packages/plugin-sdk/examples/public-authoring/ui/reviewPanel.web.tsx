import {
    applyPluginUiThemeCssVariables,
    createPluginUiRenderContext,
} from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';

import {
    REVIEW_OPENABLE_CONTENT_VIEW_ID,
    readReviewOpenableContent,
    readReviewOpenableContentReference,
    type ReviewOpenableContentResult,
} from './reviewOpenableContent.js';

const REVIEW_SESSION_STATUS_VIEW_ID = 'review-session-status-details';
const PROJECT_COMPANION_ACTIVITY_VIEW_ID = 'project-companion-activity-log';
const PROJECT_COMPANION_PROJECT_ACTIVITY_VIEW_ID = 'project-companion-project-activity-log';
const PUBLIC_AUTHORING_PLUGIN_ID = 'examples.public-sdk-review-assistant';

/**
 * Hosted-web fallback for the declared review views. The host injects the
 * transport; this isolated application negotiates only the public bridge and
 * never reaches into a parent window, daemon, file path, or private protocol.
 */
export async function connectHostedWebPanel(signal?: AbortSignal): Promise<PluginUiHostApi> {
    const context = await createPluginUiRenderContext(signal === undefined ? undefined : { signal });
    return context.hostApi;
}

/** Runs the declared `review-summary` action through the negotiated host API. */
export async function summarizeReview(
    host: PluginUiHostApi,
    transcript: string,
    signal?: AbortSignal,
): Promise<unknown> {
    return await host.executeAction(
        { pluginId: 'examples.public-sdk-review-assistant', localId: 'review-summary' },
        { transcript, maxBullets: 3 },
        signal === undefined ? undefined : { signal },
    );
}

/** Reads immutable review guidance through the mounted Resource boundary. */
export async function readReviewGuide(
    host: PluginUiHostApi,
    signal?: AbortSignal,
): Promise<string> {
    const resource = await host.readResource(
        'review-guide',
        signal === undefined ? undefined : { signal },
    );
    if (resource.contentType !== 'text/markdown') {
        throw new Error('review_guide_content_type_invalid');
    }
    return new TextDecoder().decode(resource.bytes).trim();
}

/** Open the existing Session details destination through the mounted host owner. */
export async function openProjectCompanionReviewDetails(
    host: PluginUiHostApi,
    signal?: AbortSignal,
): Promise<void> {
    await host.openSurface(
        REVIEW_SESSION_STATUS_VIEW_ID,
        undefined,
        signal === undefined ? undefined : { signal },
    );
}

function setStatus(root: HTMLElement, message: string, state: 'loading' | 'ready' | 'error'): void {
    root.dataset.status = state;
    const status = root.querySelector<HTMLElement>('[data-role="status"]');
    if (status) {
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = message;
    }
}

function setHeading(root: HTMLElement, message: string): void {
    root.querySelector<HTMLElement>('h1')?.replaceChildren(message);
}

function setGuide(root: HTMLElement, message: string): void {
    root.querySelector<HTMLElement>('[data-role="guide"]')?.replaceChildren(message);
}

function setResult(root: HTMLElement, message: string): void {
    root.querySelector<HTMLElement>('[data-role="result"]')?.replaceChildren(message);
}

function setAction(
    root: HTMLElement,
    label: string | undefined,
    onClick?: () => Promise<void>,
): void {
    const action = root.querySelector<HTMLButtonElement>('[data-role="summarize"]');
    if (!action) return;
    action.hidden = label === undefined || onClick === undefined;
    action.textContent = label ?? '';
    action.onclick = onClick === undefined ? null : () => { void onClick(); };
}

function applyContext(root: HTMLElement, surface: SurfaceContext): void {
    applyPluginUiThemeCssVariables(surface.theme, document.documentElement);
    root.lang = surface.locale;
    root.dir = surface.direction;
    root.dataset.colorScheme = surface.colorScheme;
}

function describeOpenableContentResult(
    result: Exclude<ReviewOpenableContentResult, Readonly<{ status: 'ready' }>>,
): string {
    switch (result.status) {
        case 'tooLarge':
            return 'The selected file exceeds this viewer’s bounded 64 KB read limit.';
        case 'changed':
            return 'The file changed before a consistent snapshot could be read. Reload it to try again.';
        case 'unsupported':
            return 'The current host cannot provide this selected file to the review viewer.';
        case 'cancelled':
            return 'The selected file read was cancelled. Reload it if the review is still needed.';
        case 'unavailable':
            return 'The selected file is no longer available to this review viewer.';
    }
}

async function mountOverview(root: HTMLElement, context: Awaited<ReturnType<typeof createPluginUiRenderContext>>): Promise<void> {
    setHeading(root, 'Review assistant');
    setGuide(root, '');
    setResult(root, '');
    setAction(root, 'Summarize review', async () => {
        setStatus(root, 'Summarizing review…', 'loading');
        try {
            const result = await summarizeReview(
                context.hostApi,
                'The review is ready. Follow-up is needed.',
                context.signal,
            );
            if (context.signal.aborted) return;
            setResult(root, JSON.stringify(result));
            setStatus(root, 'Summary ready', 'ready');
        } catch {
            if (!context.signal.aborted) setStatus(root, 'Review action failed', 'error');
        }
    });

    setStatus(root, 'Loading review guidance…', 'loading');
    const guide = await readReviewGuide(context.hostApi, context.signal);
    if (context.signal.aborted) return;
    setGuide(root, guide);
    setStatus(root, 'Ready to summarize', 'ready');
}

export function mountSessionStatus(
    root: HTMLElement,
    context: Awaited<ReturnType<typeof createPluginUiRenderContext>>,
    activity = false,
): void {
    if (context.surface.target.kind !== 'session') {
        throw new Error('review_session_status_requires_session_context');
    }
    setHeading(root, activity ? 'Project Companion activity' : 'Review status');
    setResult(
        root,
        activity
            ? 'This activity follows the current Session review status through the host Resource API.'
            : 'Session-scoped status updates are watched through the host Resource API.',
    );

    const resourceStore = createPluginUiResourceStore({
        client: {
            readResource: context.hostApi.readResource.bind(context.hostApi),
            ...(context.hostApi.version().methods.includes('watchResource')
                ? { watchResource: context.hostApi.watchResource.bind(context.hostApi) }
                : {}),
        },
        pluginId: PUBLIC_AUTHORING_PLUGIN_ID,
    });
    const resource = resourceStore.getEntry('review-session-status');
    let unsubscribe = () => {};
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        resourceStore.dispose();
        context.signal.removeEventListener('abort', dispose);
    };
    const render = () => {
        if (context.signal.aborted || disposed) return;
        const snapshot = resource.getSnapshot();
        const value = snapshot.value;
        if (value === undefined) {
            setGuide(root, '');
            if (snapshot.error) {
                setStatus(root, 'Review status is unavailable', 'error');
            } else {
                setStatus(root, 'Loading review status…', 'loading');
            }
            return;
        }
        if (value.contentType !== 'text/plain') {
            setGuide(root, '');
            setStatus(root, 'Review status is unavailable', 'error');
            return;
        }
        const summary = new TextDecoder().decode(value.bytes).trim();
        if (summary.length === 0) {
            setGuide(root, 'No review status has been declared for this Session.');
            setStatus(root, 'No review status', 'ready');
            return;
        }
        setGuide(root, summary);
        if (snapshot.pending !== 'idle') {
            setStatus(root, 'Refreshing review status…', 'loading');
        } else if (snapshot.error || snapshot.freshness === 'stale') {
            setStatus(root, 'Showing last known review status', 'error');
        } else {
            setStatus(root, 'Current review status', 'ready');
        }
    };

    setAction(
        root,
        activity ? 'Open review details' : 'Refresh status',
        activity
            ? async () => {
                setStatus(root, 'Opening review details…', 'loading');
                try {
                    await openProjectCompanionReviewDetails(context.hostApi, context.signal);
                    if (!context.signal.aborted) setStatus(root, 'Review details opened', 'ready');
                } catch {
                    if (!context.signal.aborted) setStatus(root, 'Review details are unavailable', 'error');
                }
            }
            : async () => { resource.refresh(); },
    );
    render();
    unsubscribe = resource.subscribe(render, true);
    if (context.signal.aborted) {
        dispose();
        return;
    }
    context.signal.addEventListener('abort', dispose, { once: true });
}

function mountProjectCompanionProjectActivity(root: HTMLElement): void {
    setHeading(root, 'Project Companion activity');
    setGuide(root, 'Open the Session activity from its header to review the current Session status.');
    setResult(root, 'This Project target does not carry a Session-scoped review status.');
    setAction(root, undefined);
    setStatus(root, 'Project Companion activity needs a Session', 'error');
}

async function mountOpenableContent(
    root: HTMLElement,
    context: Awaited<ReturnType<typeof createPluginUiRenderContext>>,
): Promise<void> {
    const reference = readReviewOpenableContentReference(context.launchInput);
    if (!reference) {
        throw new Error('review_openable_content_reference_unavailable');
    }
    setHeading(root, 'Selected review file');
    setResult(root, '');

    const reload = async () => {
        setStatus(root, 'Reading selected review file…', 'loading');
        try {
            const result = await readReviewOpenableContent(context.hostApi, reference, context.signal);
            if (context.signal.aborted) return;
            if (result.status !== 'ready') {
                setGuide(root, '');
                setResult(root, describeOpenableContentResult(result));
                setStatus(root, 'Review file is unavailable', 'error');
                return;
            }
            if (result.content.kind !== 'utf8') {
                setGuide(root, '');
                setResult(root, 'The selected content is not text that this review viewer can present.');
                setStatus(root, 'Review file is unavailable', 'error');
                return;
            }
            setGuide(root, result.content.text);
            setResult(root, `${result.mimeType} · ${result.sizeBytes} bytes`);
            setStatus(root, 'Bounded review snapshot', 'ready');
        } catch {
            if (!context.signal.aborted) {
                setGuide(root, '');
                setResult(root, 'The selected file could not be read through the host viewer API.');
                setStatus(root, 'Review file is unavailable', 'error');
            }
        }
    };

    setAction(root, 'Reload file', reload);
    await reload();
}

async function mountReviewPanel(): Promise<void> {
    const root = document.querySelector<HTMLElement>('#root');
    if (!root) return;
    setStatus(root, 'Connecting to Happier…', 'loading');

    const context = await createPluginUiRenderContext();
    applyContext(root, context.surface);
    if (context.hostApi.version().methods.includes('watchContext')) {
        await context.hostApi.watchContext((surface) => applyContext(root, surface), { signal: context.signal });
    }
    const destinationLocalId = context.surface.mount.kind === 'destination'
        ? context.surface.mount.destination.localId
        : null;
    if (destinationLocalId === REVIEW_SESSION_STATUS_VIEW_ID) {
        await mountSessionStatus(root, context);
        return;
    }
    if (destinationLocalId === PROJECT_COMPANION_ACTIVITY_VIEW_ID) {
        await mountSessionStatus(root, context, true);
        return;
    }
    if (destinationLocalId === PROJECT_COMPANION_PROJECT_ACTIVITY_VIEW_ID) {
        mountProjectCompanionProjectActivity(root);
        return;
    }
    if (destinationLocalId === REVIEW_OPENABLE_CONTENT_VIEW_ID) {
        await mountOpenableContent(root, context);
        return;
    }
    await mountOverview(root, context);
}

if (typeof document !== 'undefined') {
    void mountReviewPanel().catch((error: unknown) => {
        const root = document.querySelector<HTMLElement>('#root');
        if (root) setStatus(root, error instanceof Error ? error.message : 'Failed to start', 'error');
    });
}
