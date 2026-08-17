import {
    applyPluginUiThemeCssVariables,
    createPluginUiRenderContext,
} from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';

export async function connectHostedWebPanel(signal?: AbortSignal): Promise<PluginUiHostApi> {
    const context = await createPluginUiRenderContext(signal === undefined ? undefined : { signal });
    return context.hostApi;
}

function setStatus(root: HTMLElement, message: string, state: 'loading' | 'ready' | 'error'): void {
    root.dataset.status = state;
    const status = root.querySelector<HTMLElement>('[data-role="status"]');
    if (status) status.textContent = message;
}

function applyContext(root: HTMLElement, surface: SurfaceContext): void {
    applyPluginUiThemeCssVariables(surface.theme, document.documentElement);
    root.lang = surface.locale;
    root.dir = surface.direction;
    root.dataset.colorScheme = surface.colorScheme;
}

async function mountHostedWebPanel(): Promise<void> {
    const root = document.querySelector<HTMLElement>('#root');
    if (!root) return;
    setStatus(root, 'Connecting to Happier…', 'loading');

    const context = await createPluginUiRenderContext();
    applyContext(root, context.surface);
    setStatus(root, 'Ready', 'ready');
    if (context.hostApi.version().methods.includes('watchContext')) {
        await context.hostApi.watchContext((surface) => applyContext(root, surface), { signal: context.signal });
    }

    root.querySelector<HTMLButtonElement>('[data-role="save"]')?.addEventListener('click', () => {
        void context.hostApi.executeAction('save-note', { note: 'Hosted web example' }, { signal: context.signal })
            .then(() => setStatus(root, 'Saved', 'ready'))
            .catch((error: unknown) => {
                setStatus(root, error instanceof Error ? error.message : 'Action failed', 'error');
            });
    });
}

if (typeof document !== 'undefined') {
    void mountHostedWebPanel().catch((error: unknown) => {
        const root = document.querySelector<HTMLElement>('#root');
        if (root) setStatus(root, error instanceof Error ? error.message : 'Failed to start', 'error');
    });
}
