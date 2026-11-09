/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildWalkthroughReading, type WalkthroughStop } from './walkthroughReading';
import { createWalkthroughReviewedSource } from './walkthroughReviewedProjection';
import { applyScmReviewedMarkIntent, type ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Native code/Markdown rendering is outside the keyboard composition under test.
vi.mock('@/components/ui/code/diff/DiffViewer', () => ({ DiffViewer: () => null }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: () => null }));

const { WalkthroughView } = await import('./WalkthroughView');
const reading = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
    walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH }, analysis: SPECIMEN_ANALYSIS_COMPLETE, reviewed: null });

const initialSettings = storage.getState().settings;
beforeEach(() => { storage.setState({ settings: { ...initialSettings,
    keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: true,
    keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [],
} }); });
afterEach(() => { standardCleanup(); storage.setState({ settings: initialSettings }); document.body.replaceChildren(); });

async function composition(currentReading = reading, onMark?: (stop: WalkthroughStop) => void) {
    const root = document.createElement('section');
    root.tabIndex = -1;
    const stop = document.createElement('p');
    stop.textContent = 'Change explanation';
    root.append(stop);
    const chat = document.createElement('section');
    const composer = document.createElement('textarea');
    chat.append(composer);
    const other = document.createElement('button');
    other.textContent = 'Chat action';
    document.body.append(root, chat, other);
    const asked: string[] = [];
    const marked: string[] = [];
    const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><WalkthroughView reading={currentReading} scopeLabel="Pending changes" layout="wide"
        onAsk={stop => asked.push(stop.id)} onToggleReviewed={stop => { marked.push(stop.id); onMark?.(stop); }} /></KeyboardShortcutProvider>, {
        createNodeMock: element => element.props.testID === 'walkthrough-view' ? root
            : element.type === 'ScrollView' ? { scrollTo() {} } : null,
    });
    const key = async (target: HTMLElement, value: string, options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key: value,
            code: /^[a-z]$/i.test(value) ? `Key${value.toUpperCase()}` : value === '/' ? 'Slash' : '',
            bubbles: true, cancelable: true, ...options });
        await act(async () => { target.dispatchEvent(event); });
        return event;
    };
    const point = async (target: HTMLElement) => {
        await act(async () => { screen.findByTestId('walkthrough-view')?.props.onPointerDown({ target }); });
    };
    return { root, stop, chat, composer, other, asked, marked, screen, key, point };
}

describe('walkthrough keyboard beside chat', () => {
    it('marks and unmarks the current keyed stop and keeps next/previous navigation current', async () => {
        const source = createWalkthroughReviewedSource(reading, SPECIMEN_COMPARISON);
        let record: ScmReviewedMarksRecord | null = null;
        const c = await composition(source.base, stop => {
            record = applyScmReviewedMarkIntent(SPECIMEN_COMPARISON, record, stop.changeRefs, !stop.reviewed);
            source.apply(record);
        });
        c.root.focus();
        await c.key(c.root, 'r');
        expect(source.getReviewedCount()).toBe(1);
        await c.key(c.root, 'r');
        expect(source.getReviewedCount()).toBe(0);
        await c.key(c.root, 'j');
        await c.key(c.root, 'r');
        expect(source.getStop(reading.stops[1]!.id)?.reviewed).toBe(true);
        await c.key(c.root, 'k');
        await c.key(c.root, 'r');
        expect(source.getReviewedCount()).toBe(2);
        expect(document.activeElement).toBe(c.root);
    });
    it('keeps typing in chat, then hands reading keys to the engaged walkthrough without moving scroll on focus', async () => {
        const c = await composition();
        c.composer.focus();
        expect((await c.key(c.composer, 'j')).defaultPrevented).toBe(false);
        expect(c.asked).toEqual([]);
        await c.point(c.stop);
        expect(document.activeElement).toBe(c.root);
        expect((await c.key(c.root, 'j')).defaultPrevented).toBe(true);
        await c.key(c.root, '/');
        expect(c.asked).toEqual([reading.stops[1]!.id]);
        await c.key(c.root, 'r');
        expect(c.marked).toEqual([reading.stops[1]!.id]);
        expect(document.activeElement).toBe(c.root);
    });

    it('does not navigate the walkthrough when a neighboring chat control has focus', async () => {
        const c = await composition();
        c.other.focus();
        expect((await c.key(c.other, 'j')).defaultPrevented).toBe(false);
        c.root.focus();
        await c.key(c.root, '/');
        expect(c.asked).toEqual([reading.stops[0]!.id]);
    });

    it('recovers reading keys from a hidden focused composer in a maximized panel before chat capture', async () => {
        const c = await composition();
        c.composer.focus();
        c.chat.style.display = 'none';
        expect(document.activeElement).toBe(c.composer);
        const captured: string[] = [];
        const chatCapture = (event: KeyboardEvent) => { captured.push(event.key); event.preventDefault(); };
        c.composer.addEventListener('keydown', chatCapture, true);
        expect((await c.key(c.composer, 'j')).defaultPrevented).toBe(true);
        expect(captured).toEqual([]);
        expect(document.activeElement).toBe(c.root);
        await c.key(c.root, '/');
        expect(c.asked).toEqual([reading.stops[1]!.id]);
    });

    it('releases keys for composition, modifiers, nested editors and an inactive or hidden walkthrough', async () => {
        const c = await composition();
        const editor = document.createElement('textarea');
        c.root.append(editor);
        editor.focus();
        expect((await c.key(editor, 'j')).defaultPrevented).toBe(false);
        c.root.focus();
        expect((await c.key(c.root, 'j', { isComposing: true })).defaultPrevented).toBe(false);
        expect((await c.key(c.root, 'j', { ctrlKey: true })).defaultPrevented).toBe(false);
        c.root.hidden = true;
        expect((await c.key(c.root, 'r')).defaultPrevented).toBe(false);
        c.root.hidden = false;
        await c.screen.update(<KeyboardShortcutProvider handlers={{}}><WalkthroughView reading={reading} scopeLabel="Pending changes" layout="wide" active={false}
            onAsk={stop => c.asked.push(stop.id)} onToggleReviewed={stop => c.marked.push(stop.id)} /></KeyboardShortcutProvider>);
        expect((await c.key(c.root, 'j')).defaultPrevented).toBe(false);
        expect(c.marked).toEqual([]);
    });
});

describe('walkthrough key hints (lab WT1-A rail footer)', () => {
    // The pointer is the browser boundary that says whether a hardware keyboard is at hand.
    const pointer = (fine: boolean) => Object.defineProperty(window, 'matchMedia', { configurable: true,
        value: (query: string) => ({ matches: fine && query === '(pointer: fine)' }) });
    const markKeys = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root.findAll(node =>
        typeof node.type === 'string' && /^walkthrough-mark-key-[^:]+$/.test(String(node.props.testID ?? '')));
    const railText = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findHostByTestId('walkthrough-contents-keys')
        ?.findAll(node => typeof node.type === 'string').flatMap(node => node.children.filter((child): child is string => typeof child === 'string'))
        .join(' ') ?? null;
    afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

    it('shows the rail keys and the Mark reviewed key where the reading keys run, and drops both when they do not', async () => {
        pointer(true);
        const c = await composition();
        expect(railText(c.screen)).toMatch(/^J K .+ R .+ \/ .+$/);
        expect(markKeys(c.screen)).toHaveLength(1);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, keyboardSingleKeyShortcutsEnabled: false } }); });
        expect(railText(c.screen)).toBeNull();
        expect(markKeys(c.screen)).toHaveLength(0);
    });

    it('draws no keys on a touch screen', async () => {
        pointer(false);
        const c = await composition();
        expect(railText(c.screen)).toBeNull();
        expect(markKeys(c.screen)).toHaveLength(0);
    });
});
