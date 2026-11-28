// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutProvider, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CodeLinesViewCore } from '@/components/ui/code/view/CodeLinesViewCore';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { storage } from '@/sync/domains/state/storage';
import { ChangedFilesReviewFindButton, ChangedFilesReviewFindCount, ChangedFilesReviewFindSurface } from './ChangedFilesReviewFind';
import { createChangedFilesReviewFind, type ReviewFindTarget } from './useChangedFilesReviewFind';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { ChangedFilesReviewDiffBlock } from './ChangedFilesReviewDiffBlock';
import { useUnistyles } from 'react-native-unistyles';
import { executeFindAction } from '@/keyboard/findActionRuntime';
import { UiFindOutputSchema } from '@happier-dev/protocol/actions/findActionSpecs';

// Focus, keyboard propagation and toolbar activation require the actual RNW DOM boundary.
vi.mock('react-native', async () => await import('react-native-web'));

const patch = '@@ -1 +1 @@\n-needle needle\n+needle';
const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true });

describe('mounted review Find', () => {
    it.each([false, true])('refolds omitted revision context through the Action and button (comments=%s)', async (reviewCommentsEnabled) => {
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, filesDiffFoldingEnabled: true,
            filesDiffFoldingContextThreshold: 4, filesDiffFoldingContextRadius: 1, filesDiffRendererMode: 'pierre' } });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        const source = createChangedFilesReviewDiffStateSource();
        const baseText = Array.from({ length: 160 }, (_, i) => i === 47 ? 'hidden cedar one' : i === 111 ? 'hidden cedar two' : `coast ${i}`).join('\n') + '\n';
        const diff = '@@ -5,3 +5,3 @@\n coast 4\n-coast 5\n+changed 5\n coast 6\n@@ -154,3 +154,3 @@\n coast 153\n-coast 154\n+changed 154\n coast 155\n';
        source.setDiffState('a.ts', { status: 'loaded', diff, error: null, context: { status: 'loaded', baseText } });
        const model = createChangedFilesReviewFind();
        function Review() {
            const { theme } = useUnistyles();
            const surfaceRef = React.useRef<View | null>(null);
            const [target, reveal] = React.useState<ReviewFindTarget | null>(null);
            const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot);
            React.useEffect(() => model.connect({ paths: ['a.ts'], diffStateSource: source, reveal }), []);
            return <View ref={surfaceRef}>
                <ChangedFilesReviewDiffBlock theme={theme} sessionId="s1" snapshotSignature={null} filePath="a.ts"
                    diffStateSource={source} reviewCommentsEnabled={reviewCommentsEnabled} reviewCommentDrafts={[]}
                    findModel={model} findActive={snapshot.open} scrollToLineId={target?.lineId} />
                <ChangedFilesReviewFindSurface model={model} surfaceId="review:refold" surfaceRef={surfaceRef} presented />
            </View>;
        }
        const execute = (op: 'read' | 'refold' | 'step') => executeFindAction({ actionId: 'ui.find',
            input: { op, target: 'review:refold', ...(op === 'step' ? { direction: 1 } : {}) }, context: { surface: 'agent' } });
        try {
            await act(async () => { root.render(<KeyboardShortcutProvider handlers={{}}>
                <PluginSurfaceFocusEligibilityProvider active><Review /></PluginSurfaceFocusEligibilityProvider>
            </KeyboardShortcutProvider>); });
            await act(async () => { model.open(); model.setOptions({ regex: true, matchCase: false }); model.setQuery('hidden cedar (one|two)'); });
            const mark = () => container.querySelector('[data-testid="find-match-current"]');
            const markedText = () => Array.from(container.querySelectorAll('[data-testid="find-match-current"]')).map(node => node.textContent).join('');
            expect(markedText()).toBe('hidden cedar one');
            const before = await execute('read');
            let result: Awaited<ReturnType<typeof execute>> | undefined;
            await act(async () => { result = await execute('refold'); });
            expect(UiFindOutputSchema.safeParse(result?.ok ? result.result : null).success).toBe(true);
            expect(result).toEqual(before);
            expect(mark()).toBeNull();
            expect(container.querySelector('[data-testid="diff-find-fold-again"]')).toBeNull();
            expect(model.query).toBe('hidden cedar (one|two)');
            expect(model.getSnapshot().open).toBe(true);
            expect(model.getFileSnapshot('a.ts').ranges.size).toBe(2);
            await act(async () => { await execute('step'); });
            expect(markedText()).toBe('hidden cedar two');
            const afterStep = await execute('read');
            await act(async () => { container.querySelector<HTMLElement>('[data-testid="diff-find-fold-again"]')!.click(); });
            expect(mark()).toBeNull();
            expect(await execute('read')).toEqual(afterStep);
            expect(await execute('refold')).toEqual({ ok: true, result: { status: 'unavailable', reason: 'noRevealedFold' } });
            expect(storage.getState().settings.filesDiffFoldingEnabled).toBe(true);
            expect(storage.getState().settings.filesDiffFoldingContextThreshold).toBe(4);
            expect(storage.getState().settings.filesDiffFoldingContextRadius).toBe(1);
            expect(storage.getState().settings.filesDiffRendererMode).toBe('pierre');
        } finally { await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings }); }
    });
    it.each(['binary', 'unreadable'] as const)('explains incomplete zero-hit results from a %s file', async (kind) => {
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('a.ts', kind === 'binary'
            ? { status: 'loaded', diff: 'Binary files a/a.ts and b/a.ts differ', error: null }
            : { status: 'error', diff: '', error: 'unreadable' });
        const model = createChangedFilesReviewFind();
        const disconnect = model.connect({ paths: ['a.ts'], diffStateSource: source, reveal() {} });
        model.open(); model.setQuery('needle');
        function Review() {
            const surfaceRef = React.useRef<View | null>(null);
            return <View ref={surfaceRef}><ChangedFilesReviewFindSurface model={model}
                surfaceId="review:partial" surfaceRef={surfaceRef} presented /></View>;
        }
        try {
            await act(async () => { root.render(<KeyboardShortcutProvider handlers={{}}>
                <PluginSurfaceFocusEligibilityProvider active><Review /></PluginSurfaceFocusEligibilityProvider>
            </KeyboardShortcutProvider>); });
            expect(model.status).toMatchObject({ kind: 'results', total: 0, coverage: 'partialErrors' });
            expect(container.querySelector('[data-testid="scm-review-find-field.note"]')).not.toBeNull();
            await act(async () => { source.setDiffState('a.ts', { status: 'loaded', diff: patch, error: null }); });
            expect(model.status).toMatchObject({ coverage: 'complete' });
            expect(container.querySelector('[data-testid="scm-review-find-field.note"]')).toBeNull();
        } finally { await act(async () => { root.unmount(); }); disconnect(); container.remove(); }
    });

    it('focuses from its toolbar, decorates character ranges, restores focus and ignores parked surfaces', async () => {
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings,
            keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('a.ts', { status: 'loaded', diff: patch, error: null });
        const model = createChangedFilesReviewFind();
        function Review({ presented }: { presented: boolean }) {
            const surfaceRef = React.useRef<View | null>(null);
            const [target, reveal] = React.useState<ReviewFindTarget | null>(null);
            const runtime = useFindSurfaceRuntime();
            React.useEffect(() => model.connect({ paths: ['a.ts'], diffStateSource: source, reveal }), []);
            const ranges = React.useSyncExternalStore(
                React.useCallback((listener) => model.subscribeFile('a.ts', listener), []),
                () => model.getFileSnapshot('a.ts').ranges,
            );
            return <View ref={surfaceRef}>
                <button data-testid="open-addressed-find" onClick={() => runtime.open('review:test')}>Open</button>
                <ChangedFilesReviewFindButton surfaceId="review:test" />
                <ChangedFilesReviewFindCount model={model} path="a.ts" />
                <CodeLinesViewCore lines={lines} virtualized={false} findRangesByLineId={ranges} scrollToLineId={target?.lineId} />
                <ChangedFilesReviewFindSurface model={model} surfaceId="review:test" surfaceRef={surfaceRef} presented={presented} />
            </View>;
        }
        const render = (presented: boolean) => <KeyboardShortcutProvider handlers={{}}>
            <PluginSurfaceFocusEligibilityProvider active={presented}><Review presented={presented} /></PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutProvider>;
        const key = async (target: Element, key: string, code: string) => {
            const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
            await act(async () => { target.dispatchEvent(event); }); return event;
        };
        try {
            await act(async () => { root.render(render(true)); });
            const toolbar = container.querySelector<HTMLElement>('[data-testid="scm-review-find"]')!;
            await act(async () => { toolbar.focus(); });
            await act(async () => { toolbar.click(); });
            const input = container.querySelector<HTMLInputElement>('input');
            expect(input).not.toBeNull();
            expect(document.activeElement).toBe(input);
            const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            await act(async () => { inputSetter.call(input, 'needle'); input!.dispatchEvent(new Event('input', { bubbles: true })); });
            expect(container.querySelector('[data-testid="find-match-current"]')?.textContent).toBe('needle');
            expect(container.querySelector('[data-testid="scm-review-find-count:a.ts"]')?.textContent).toBe('3');
            await act(async () => { model.setOptions({ matchCase: true, regex: true }); model.step(1); });
            for (const refreshed of [patch, patch.replace('+needle', '+needle refreshed')]) {
                await act(async () => { source.setDiffState('a.ts', { status: 'loaded', diff: refreshed, error: null }); });
                expect(container.querySelector('input')).toBe(input);
                expect(input!.value).toBe('needle');
                expect(document.activeElement).toBe(input);
                expect(model.getSnapshot()).toMatchObject({ open: true, options: { matchCase: true, regex: true },
                    status: { current: 2, total: 3 } });
            }
            // A closing bar may still be settling out, but inert: hidden from assistive tech and never focused.
            const liveInput = () => Array.from(container.querySelectorAll('input')).find((element) => !element.closest('[aria-hidden="true"]')) ?? null;
            await key(input!, 'Escape', 'Escape');
            expect(liveInput()).toBeNull();
            expect(document.activeElement).toBe(toolbar);
            await act(async () => { toolbar.click(); });
            await act(async () => { root.render(render(false)); });
            expect(liveInput()).toBeNull();
            await act(async () => { model.close(); });
            await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="open-addressed-find"]')!.click(); });
            expect(model.getSnapshot().open).toBe(false);
        } finally { await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings }); }
    });
});
