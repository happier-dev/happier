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

// Focus, keyboard propagation and toolbar activation require the actual RNW DOM boundary.
vi.mock('react-native', async () => await import('react-native-web'));

const patch = '@@ -1 +1 @@\n-needle needle\n+needle';
const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true });

describe('mounted review Find', () => {
    it('focuses from its toolbar, decorates character ranges, restores focus and ignores parked surfaces', async () => {
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, keyboardShortcutsV2Enabled: true,
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
            await key(input!, 'Escape', 'Escape');
            expect(container.querySelector('input')).toBeNull();
            expect(document.activeElement).toBe(toolbar);
            await act(async () => { toolbar.click(); });
            await act(async () => { root.render(render(false)); });
            expect(container.querySelector('input')).toBeNull();
            await act(async () => { model.close(); });
            await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="open-addressed-find"]')!.click(); });
            expect(model.getSnapshot().open).toBe(false);
        } finally { await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings }); }
    });
});
