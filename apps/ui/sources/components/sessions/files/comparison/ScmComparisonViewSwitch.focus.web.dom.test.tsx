/**
 * @vitest-environment jsdom
 *
 * Real react-native-web and react-dom: Files and Walkthrough each draw their own comparison bar, so an
 * Arrow-key view change remounts the switch. Keyboard focus must land on the newly active tab, not BODY.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    const actual: Record<string, unknown> = await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(actual);
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));

const { ScmComparisonBar, ScmComparisonViewSwitch } = await import('./ScmComparisonBar');

const VIEWS: readonly SessionScmReviewView[] = ['files', 'walkthrough'];

/** The review destination's shape: each view renders its own bar inside its own subtree. */
function Destination() {
    const [view, setView] = React.useState<SessionScmReviewView>('files');
    const bar = <ScmComparisonBar leading={<ScmComparisonViewSwitch view={view} views={VIEWS} onSelect={setView} />} />;
    return view === 'files' ? <section key="files">{bar}</section> : <article key="walkthrough">{bar}</article>;
}

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

function tab(view: SessionScmReviewView): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-testid="scm-comparison-view:${view}"]`);
    if (!element) throw new Error(`missing ${view} tab`);
    return element;
}

async function press(key: string) {
    await act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
}

describe('ScmComparisonViewSwitch keyboard focus', () => {
    it('keeps focus on the active tab when an Arrow key switches to a view that draws its own bar', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Destination />); });
        act(() => { tab('files').focus(); });
        expect(document.activeElement).toBe(tab('files'));

        await press('ArrowRight');
        expect(tab('walkthrough').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tab('walkthrough'));

        await press('ArrowLeft');
        expect(tab('files').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tab('files'));
    });

    it('does not pull focus into the switch when the view changes from elsewhere', async () => {
        const host = document.createElement('div');
        const outside = document.createElement('button');
        document.body.append(host, outside);
        root = createRoot(host);
        await act(async () => { root!.render(<Destination />); });
        act(() => { outside.focus(); });
        await act(async () => { tab('walkthrough').click(); });
        expect(tab('walkthrough').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(outside);
    });
});
