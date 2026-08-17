import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginUiHostApi, RenderContext, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
    createPluginUiTestkit,
    createSurfaceContextFixture,
    type PluginUiSemanticSurfaceAdapter,
} from '@happier-dev/plugin-sdk/testing';

type SemanticSurface = Readonly<{ kind: 'review-panel-test' }>;
type WatchHandle = Awaited<ReturnType<PluginUiHostApi['watchContext']>>;

const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const surface: SurfaceContext = createSurfaceContextFixture({
    mount: {
        kind: 'destination',
        destination: {
            pluginId: 'examples.production-hosted-reference',
            localId: 'review-dashboard',
        },
        container: 'appPage',
    },
    target: { kind: 'app' },
    locale: 'en',
    colorScheme: 'light',
    targetedContributions: {
        target: {
            pluginId: 'examples.production-hosted-reference',
            immutableGenerationId: 'review-panel-test',
        },
        points: [],
    },
});

const semanticAdapter: PluginUiSemanticSurfaceAdapter<SemanticSurface> = {
    async mount() {
        return {
            async snapshot() {
                return { revision: 1, nodes: [] };
            },
            async update() {},
            async invoke() {},
            async dispose() {},
        };
    },
};

function installDocument() {
    const status = { textContent: '', dataset: {}, lang: '', dir: '' };
    const root = {
        dataset: {} as Record<string, string>,
        lang: '',
        dir: '',
        querySelector(selector: string) {
            return selector === '[data-role="status"]' ? status : null;
        },
    };
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            querySelector(selector: string) {
                return selector === '#root' ? root : null;
            },
            documentElement: { style: { setProperty() {} } },
        },
    });
    return { root, status };
}

async function importMountedReviewPanel(context: RenderContext): Promise<void> {
    vi.resetModules();
    vi.doMock('@happier-dev/plugin-sdk/ui/client', async () => ({
        ...await vi.importActual<typeof import('@happier-dev/plugin-sdk/ui/client')>(
            '@happier-dev/plugin-sdk/ui/client',
        ),
        createPluginUiRenderContext: async () => context,
    }));
    const moduleUrl = new URL(
        '../../examples/production-hosted-reference/ui/reviewPanel.web.ts',
        import.meta.url,
    ).href;
    await import(/* @vite-ignore */ moduleUrl);
}

async function settleMount(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function createFixture() {
    return await createPluginUiTestkit({
        identity: {
            pluginId: 'examples.production-hosted-reference',
            pluginVersion: '0.1.0',
            viewId: 'review-dashboard',
            generation: 'review-panel-test',
        },
        surface: { kind: 'review-panel-test' },
        surfaceContext: surface,
        adapter: semanticAdapter,
    });
}

describe('production hosted review panel lifecycle', () => {
    afterEach(() => {
        vi.doUnmock('@happier-dev/plugin-sdk/ui/client');
        vi.resetModules();
        if (originalDocumentDescriptor) {
            Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, 'document');
        }
    });

    it('renders an already-retired context offline before applying or watching it', async () => {
        const fixture = await createFixture();
        try {
            await fixture.retire('host_retired_before_mount');
            const { root, status } = installDocument();

            await importMountedReviewPanel(fixture.context);
            await settleMount();

            expect(root.dataset.status).toBe('offline');
            expect(status.textContent).toBe('Happier is offline. Reconnect before retrying this review.');
            expect(root.lang).toBe('');
            expect(root.dataset.colorScheme).toBeUndefined();
        } finally {
            await fixture.dispose();
        }
    });

    it('keeps the offline status when retirement rejects watch admission', async () => {
        const fixture = await createFixture();
        try {
            const retirement = new AbortController();
            const hostApi = Object.create(fixture.context.hostApi) as PluginUiHostApi;
            let rejectWatch!: (reason?: unknown) => void;
            let watchStarted!: () => void;
            const watchStartedPromise = new Promise<void>((resolve) => { watchStarted = resolve; });
            const watch = new Promise<WatchHandle>((_resolve, reject) => { rejectWatch = reject; });
            Object.defineProperty(hostApi, 'watchContext', {
                configurable: true,
                value: () => {
                    watchStarted();
                    return watch;
                },
            });
            const context: RenderContext = Object.freeze({
                ...fixture.context,
                hostApi,
                signal: retirement.signal,
            });
            const { root, status } = installDocument();

            await importMountedReviewPanel(context);
            await watchStartedPromise;
            retirement.abort('host_retired_during_watch');
            rejectWatch(new Error('host_retired_during_watch'));
            await settleMount();

            expect(root.dataset.status).toBe('offline');
            expect(status.textContent).toBe('Happier is offline. Reconnect before retrying this review.');
        } finally {
            await fixture.dispose();
        }
    });
});
