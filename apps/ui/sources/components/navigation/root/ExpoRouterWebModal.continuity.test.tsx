/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { transform } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ModalDrawerProps = Readonly<{
    routeKey: string;
    options: Readonly<{ title: string; gestureEnabled: boolean }>;
    renderScreen: () => React.ReactNode;
    onDismiss: () => void;
    themeColors: Readonly<{ background: string }>;
}>;

async function loadInstalledModalDrawer(): Promise<React.ComponentType<ModalDrawerProps>> {
    const require = createRequire(import.meta.url);
    const path = require.resolve('expo-router/build/modal/web/ModalStackRouteDrawer.js');
    // Expo publishes JSX in CommonJS .js files; compile its actual installed owner,
    // retaining real Vaul, React and Expo's viewport hook rather than mocking them.
    const source = await readFile(path, 'utf8');
    const { code } = await transform(source, { loader: 'jsx', jsx: 'automatic', format: 'cjs' });
    const localRequire = createRequire(path);
    const module: { exports: { ModalStackRouteDrawer?: React.ComponentType<ModalDrawerProps> } } = { exports: {} };
    const requireWithCssBoundary = (id: string): unknown => id === './modalStyles'
        // Metro's CSS-module injection is outside this React state-retention contract.
        ? {} : localRequire(id);
    const evaluate = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    evaluate(module.exports, requireWithCssBoundary, module, path, dirname(path));
    if (!module.exports.ModalStackRouteDrawer) throw new Error('Missing installed Expo route modal');
    return module.exports.ModalStackRouteDrawer;
}

function installViewportBoundary(initialWidth: number) {
    let width = initialWidth;
    const queries = new Map<string, MediaQueryList>();
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
    const matches = (query: string) => {
        const minimum = /min-width:\s*(\d+)px/.exec(query);
        const maximum = /max-width:\s*(\d+)px/.exec(query);
        return (!minimum || width >= Number(minimum[1])) && (!maximum || width <= Number(maximum[1]));
    };
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
        const previous = queries.get(query);
        if (previous) return previous;
        const target = new EventTarget();
        const mql = Object.assign(target, {
            media: query,
            matches: matches(query),
            onchange: null,
            // The platform boundary dispatches MediaQueryList change events through EventTarget.
            addListener: (listener: Parameters<MediaQueryList['addListener']>[0]) => {
                if (listener) target.addEventListener('change', listener as EventListener);
            },
            removeListener: (listener: Parameters<MediaQueryList['removeListener']>[0]) => {
                if (listener) target.removeEventListener('change', listener as EventListener);
            },
        }) satisfies MediaQueryList;
        Object.defineProperty(mql, 'matches', { get: () => matches(query) });
        queries.set(query, mql);
        return mql;
    });
    return {
        resize(next: number) {
            const previous = new Map([...queries].map(([query, mql]) => [query, mql.matches]));
            width = next;
            for (const [query, mql] of queries) {
                if (previous.get(query) === mql.matches) continue;
                const event = new Event('change');
                Object.defineProperty(event, 'matches', { value: mql.matches });
                mql.dispatchEvent(event);
            }
            window.dispatchEvent(new Event('resize'));
        },
        restore() {
            if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
            else Reflect.deleteProperty(window, 'innerWidth');
        },
    };
}

function StatefulRouteScreen() {
    const [selected, select] = React.useState(false);
    const [draft, setDraft] = React.useState('');
    return <div data-testid="route-screen">
        <button onClick={() => { select(true); setDraft('QA continuity'); }}>Choose Plan</button>
        {selected ? <input aria-label="Selected workflow input" value={draft} onChange={event => setDraft(event.target.value)} /> : null}
    </div>;
}

describe('installed Expo web route-modal continuity', () => {
    let root: ReturnType<typeof createRoot>;
    let container: HTMLDivElement;
    let viewport: ReturnType<typeof installViewportBoundary>;

    beforeEach(() => {
        vi.stubEnv('EXPO_OS', 'web');
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        viewport = installViewportBoundary(1440);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        viewport.restore();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('keeps the same route screen and local selection across desktop/sheet changes, but resets for a new route', async () => {
        const ModalDrawer = await loadInstalledModalDrawer();
        const renderScreen = () => <StatefulRouteScreen />;
        const onDismiss = vi.fn();
        const render = (routeKey: string) => <ModalDrawer routeKey={routeKey}
            options={{ title: 'New Session', gestureEnabled: true }} renderScreen={renderScreen}
            onDismiss={onDismiss} themeColors={{ background: '#fff' }} />;
        await act(async () => { root.render(render('new-session-route')); });
        const screen = document.querySelector('[data-testid="route-screen"]');
        expect(screen).not.toBeNull();
        expect(document.querySelector('[data-presentation]')?.getAttribute('data-presentation')).toBe('modal');
        await act(async () => { screen?.querySelector('button')?.click(); });
        const input = screen?.querySelector('input');
        expect(input?.value).toBe('QA continuity');

        for (const width of [390, 430, 1440]) {
            await act(async () => { viewport.resize(width); });
            expect(document.querySelector('[data-testid="route-screen"]')).toBe(screen);
            expect(screen?.querySelector('input')).toBe(input);
            expect(input?.value).toBe('QA continuity');
            expect(document.querySelector('[data-presentation]')?.getAttribute('data-presentation'))
                .toBe(width < 768 ? 'formSheet' : 'modal');
            const dialog = document.querySelector('[role="dialog"]');
            const titleId = dialog?.getAttribute('aria-labelledby');
            expect(titleId ? document.getElementById(titleId)?.textContent : null).toBe('New Session');
        }
        expect(onDismiss).not.toHaveBeenCalled();
        await act(async () => { root.render(render('another-route')); });
        expect(document.querySelector('[data-testid="route-screen"]')).not.toBe(screen);
        expect(document.querySelector('[data-testid="route-screen"] input')).toBeNull();
    });
});
