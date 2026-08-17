import {
    applyPluginUiThemeCssVariables,
    createPluginUiRenderContext,
} from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi, RenderContext, SurfaceContext } from '@happier-dev/plugin-sdk/ui';

type SurfaceStatus = 'loading' | 'ready' | 'offline' | 'error';
type ContextWatch = Awaited<ReturnType<PluginUiHostApi['watchContext']>>;

/**
 * A small public entry point for package-local consumers. The host owns
 * bootstrap, exact mount identity, and retirement; author code receives only
 * the negotiated public API.
 */
export async function connectHostedWebPanel(signal?: AbortSignal): Promise<PluginUiHostApi> {
    const context = await createPluginUiRenderContext(signal === undefined ? undefined : { signal });
    return context.hostApi;
}

export async function readReviewGuide(
    host: PluginUiHostApi,
    signal?: AbortSignal,
): Promise<string> {
    const resource = await host.readResource('review-guide', signal === undefined ? undefined : { signal });
    if (resource.contentType !== 'text/markdown') {
        throw new Error('review_guide_content_type_invalid');
    }
    return new TextDecoder().decode(resource.bytes).trim();
}

export async function refreshReviewStatus(
    host: PluginUiHostApi,
    signal?: AbortSignal,
): Promise<unknown> {
    return await host.executeAction(
        'refresh-review',
        {},
        signal === undefined ? undefined : { signal },
    );
}

/**
 * The host gives a full-page surface only its canonical local location and a
 * bounded launch fact. This reference acknowledges both without parsing URLs
 * or displaying arbitrary launch payloads.
 */
export function describeReviewMount(context: Pick<RenderContext, 'launchInput' | 'subPath'>): string {
    const location = context.subPath ?? 'overview';
    return context.launchInput === undefined
        ? `Review location: ${location}.`
        : `Review location: ${location}. Host launch input is available.`;
}

/** The host owns route construction, history, and destination admission. */
export async function openReviewHistory(
    host: PluginUiHostApi,
    signal?: AbortSignal,
): Promise<void> {
    await host.openSurface(
        'review-dashboard',
        undefined,
        signal === undefined ? { subPath: 'history' } : { subPath: 'history', signal },
    );
}

function setStatus(root: HTMLElement, message: string, state: SurfaceStatus): void {
    root.dataset.status = state;
    const status = root.querySelector<HTMLElement>('[data-role="status"]');
    if (status) status.textContent = message;
}

function setError(root: HTMLElement, error: unknown): void {
    const message = error instanceof Error ? error.message : 'The review request failed.';
    setStatus(root, message, 'error');
}

function applyContext(root: HTMLElement, surface: SurfaceContext): void {
    applyPluginUiThemeCssVariables(surface.theme, document.documentElement);
    root.lang = surface.locale;
    root.dir = surface.direction;
    root.dataset.colorScheme = surface.colorScheme;
}

async function mountReviewPanel(): Promise<void> {
    const root = document.querySelector<HTMLElement>('#root');
    if (!root) return;
    setStatus(root, 'Connecting to Happier…', 'loading');

    const context = await createPluginUiRenderContext();
    let contextWatch: ContextWatch | undefined;
    const retireSurface = () => {
        // The host owns the subscription lifecycle; this surface only releases
        // its admitted handle and never retries against a retired identity.
        void contextWatch?.dispose();
        setStatus(root, 'Happier is offline. Reconnect before retrying this review.', 'offline');
    };
    // AbortSignal does not replay events to listeners added after retirement.
    // Make an already-retired context sticky before touching its snapshot or API.
    if (context.signal.aborted) {
        retireSurface();
        return;
    }
    context.signal.addEventListener('abort', retireSurface, { once: true });
    applyContext(root, context.surface);

    const mountOutput = root.querySelector<HTMLElement>('[data-role="mount"]');
    if (mountOutput) mountOutput.textContent = describeReviewMount(context);

    const guideOutput = root.querySelector<HTMLElement>('[data-role="guide"]');
    const loadGuide = async () => {
        try {
            const guide = await readReviewGuide(context.hostApi, context.signal);
            if (context.signal.aborted) return;
            if (guideOutput) guideOutput.textContent = guide;
            setStatus(root, 'Review guide is ready.', 'ready');
        } catch (error: unknown) {
            if (!context.signal.aborted) setError(root, error);
        }
    };

    if (context.hostApi.version().methods.includes('watchContext')) {
        try {
            const admittedWatch = await context.hostApi.watchContext(
                (surface) => applyContext(root, surface),
                { signal: context.signal },
            );
            contextWatch = admittedWatch;
            if (context.signal.aborted) {
                void admittedWatch.dispose();
                return;
            }
        } catch (error: unknown) {
            // The abort handler has already rendered the offline state; a
            // canceled subscription must not overwrite it with an error.
            if (context.signal.aborted) return;
            throw error;
        }
    }

    if (context.signal.aborted) return;

    root.querySelector<HTMLButtonElement>('[data-role="retry"]')?.addEventListener('click', () => {
        void loadGuide();
    });
    root.querySelector<HTMLButtonElement>('[data-role="refresh-review"]')?.addEventListener('click', () => {
        void refreshReviewStatus(context.hostApi, context.signal)
            .then((result) => {
                if (context.signal.aborted) return;
                const output = root.querySelector<HTMLElement>('[data-role="result"]');
                if (output) output.textContent = JSON.stringify(result);
                setStatus(root, 'Review status is current.', 'ready');
            })
            .catch((error: unknown) => {
                if (!context.signal.aborted) setError(root, error);
            });
    });
    root.querySelector<HTMLButtonElement>('[data-role="open-history"]')?.addEventListener('click', () => {
        void openReviewHistory(context.hostApi, context.signal).catch((error: unknown) => {
            if (!context.signal.aborted) setError(root, error);
        });
    });

    await loadGuide();
}

if (typeof document !== 'undefined') {
    void mountReviewPanel().catch((error: unknown) => {
        const root = document.querySelector<HTMLElement>('#root');
        if (root) setError(root, error);
    });
}
