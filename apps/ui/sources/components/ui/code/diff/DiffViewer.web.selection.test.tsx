import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { storage } from '@/sync/domains/state/storageStore';
import { BrowserWorker } from './pierre/pierreWorkerTestHelpers';

let fileDiffMounts = 0;


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Only the third-party renderer's DOM paint port is replaced. Happier parses
// the patch, chooses the renderer and mounts its real virtualized owner.
vi.mock('@pierre/diffs/react', async importOriginal => {
    const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
    return { ...actual,
        FileDiff: (props: React.ComponentProps<typeof actual.FileDiff>) => {
            React.useEffect(() => { fileDiffMounts += 1; }, []);
            return React.createElement('pierre-file-diff', props);
        },
        Virtualizer: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
    };
});
const { PierreDiffViewer } = await import('./pierre/PierreDiffViewer.web');
const { HappierUnifiedDiffViewer } = await import('./happier/HappierUnifiedDiffViewer');
const { LazyMountOnScreen } = await import('@/components/ui/performance/LazyMountOnScreen');
const pierreViewerType = Reflect.get(PierreDiffViewer, 'type') ?? PierreDiffViewer;
const unifiedViewerType = Reflect.get(HappierUnifiedDiffViewer, 'type') ?? HappierUnifiedDiffViewer;
const initialState = storage.getState();

describe('DiffViewer (web renderer selection)', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED;
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;

    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = previousEnv;

        browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        BrowserWorker.reset();
        vi.stubGlobal('Worker', BrowserWorker);
        fileDiffMounts = 0;
        storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'pierre' } });
    });

    afterEach(() => {
        if (previousEnv === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED;
        else process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = previousEnv;

        standardCleanup();
        storage.setState(initialState, true);
        browser?.restore();
    });

    it('uses Pierre when enabled by setting + env and runtime supports it', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeTruthy();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeNull();
        expect(screen.findAllByType(LazyMountOnScreen)[0] ?? null).toBeNull();
    });

    it('serves a leading lane (File page blame) through the canonical line renderer while Pierre is selected', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');
        const unifiedDiff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,2 @@', ' const a = 1;', '+const b = 2;'].join('\n');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={unifiedDiff} filePath="a.ts"
            renderLeadingLane={(line) => <span data-testid={`lane-${line.newLine ?? 'removed'}`} />} />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeNull();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeTruthy();
    });

    it('reveals a Find match in omitted text inside Pierre and refolds it, without handing the page to another renderer', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');
        const { buildCodeLinesFromUnifiedDiff } = await import('../model/buildCodeLinesFromUnifiedDiff');
        const { expandUnifiedDiffContext } = await import('../model/expandUnifiedDiffContext');
        const baseText = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        const unifiedDiff = ['--- a/a.ts', '+++ b/a.ts', '@@ -10,3 +10,3 @@', ' line 10', ' line 11', '-line 12', '+line twelve'].join('\n') + '\n';
        const patchLines = buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true });
        const lines = expandUnifiedDiffContext({ unifiedDiff, baseText, lines: patchLines })!;
        const target = lines.find(line => line.renderCodeText === 'line 3')!;
        let refold: (() => string) | undefined;
        const props = {
            mode: 'unified', unifiedDiff, filePath: 'a.ts', findActive: true, virtualized: false, precomputedLines: lines,
            contextBaseText: baseText, scrollToLineId: target.id,
            findRangesByLineId: new Map([[target.id, [{ start: 0, end: 6, current: true }]]]),
            registerFindRefold: (next: () => string) => { refold = next; return () => { refold = undefined; }; },
        } as const;
        const screen = await renderScreen(<DiffViewer {...props} />);

        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeNull();
        const revealed = screen.findAllByType('pierre-file-diff')[0]!.props.fileDiff;
        expect(revealed.isPartial).toBe(false);
        expect(revealed.additionLines[2]).toBe('line 3\n');

        await renderer.act(async () => { expect(refold?.()).toBe('refolded'); });
        expect(screen.findAllByType('pierre-file-diff')[0]!.props.fileDiff.isPartial).toBe(true);
        expect(storage.getState().settings.filesDiffRendererMode).toBe('pierre');
    });

    it('offers "Fold again" above the region Find opened in Pierre, reaching the same refold as the Find Action', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');
        const { buildCodeLinesFromUnifiedDiff } = await import('../model/buildCodeLinesFromUnifiedDiff');
        const { expandUnifiedDiffContext } = await import('../model/expandUnifiedDiffContext');
        const baseText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        const unifiedDiff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', ' line 1', '-line 2', '+line two', ' line 3',
            '@@ -20,3 +20,3 @@', ' line 20', '-line 21', '+line twenty-one', ' line 22'].join('\n') + '\n';
        const patchLines = buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true });
        const lines = expandUnifiedDiffContext({ unifiedDiff, baseText, lines: patchLines })!;
        const target = lines.find(line => line.renderCodeText === 'line 10')!;
        let refold: (() => string) | undefined;
        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={unifiedDiff} filePath="a.ts" findActive virtualized={false}
            precomputedLines={lines} contextBaseText={baseText} scrollToLineId={target.id}
            findRangesByLineId={new Map([[target.id, [{ start: 0, end: 7, current: true }]]])}
            registerFindRefold={(next) => { refold = next; return () => { refold = undefined; }; }} />);
        const diff = () => screen.findAllByType('pierre-file-diff')[0]!.props;
        expect(diff().fileDiff.isPartial).toBe(false);
        // The band sits after the last patch row before the opened region (new line 3), not on the match.
        const opened = diff().lineAnnotations.find((annotation: { side: string; lineNumber: number }) => annotation.side === 'additions' && annotation.lineNumber === 3);
        expect(opened).toBeTruthy();
        const band = await renderScreen(<>{diff().renderAnnotation(opened)}</>);
        expect(band.findByTestId('diff-find-opened-fold')).not.toBeNull();
        // Lines 4 to 19 sit between the two hunks: sixteen hidden lines, all opened by the completed patch.
        const bandText = (node: unknown): string => typeof node === 'string' ? node
            : ((node as { children?: unknown[] } | null)?.children ?? []).map(bandText).join('');
        expect(bandText(band.findByTestId('diff-find-opened-fold'))).toMatch(/\b16\b/);

        await renderer.act(async () => { await band.pressByTestId('diff-find-fold-again'); });
        expect(diff().fileDiff.isPartial).toBe(true);
        expect(diff().lineAnnotations.some((annotation: { lineNumber: number }) => annotation.lineNumber === 3)).toBe(false);
        // The Action reaches the same operation: nothing is left for it to refold.
        expect(refold?.()).toBe('noRevealedFold');
        expect(storage.getState().settings.filesDiffRendererMode).toBe('pierre');
    });

    it('keeps the patch-only Pierre diff for a Find match the patch already shows', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');
        const { buildCodeLinesFromUnifiedDiff } = await import('../model/buildCodeLinesFromUnifiedDiff');
        const unifiedDiff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n') + '\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true });
        const target = lines.find(line => line.renderCodeText === 'new')!;
        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={unifiedDiff} filePath="a.ts" findActive virtualized={false}
            precomputedLines={lines} contextBaseText={'keep\nold\n'} scrollToLineId={target.id}
            findRangesByLineId={new Map([[target.id, [{ start: 0, end: 3, current: true }]]])} />);
        expect(screen.findAllByType('pierre-file-diff')[0]!.props.fileDiff.isPartial).toBe(true);
    });

    it('wraps virtualized Pierre diffs in LazyMountOnScreen for lazy mounting', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" virtualized={true} />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeTruthy();
        expect(screen.findAllByType(LazyMountOnScreen)[0] ?? null).toBeTruthy();
    });

    it('eagerly mounts only already-rendered virtualized Pierre rows while initial presentation is pending', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer: () => ({ complete: () => {}, dispose: () => {} }),
            }}>
                <DiffViewer
                    mode="unified"
                    unifiedDiff={'diff --git a/a.ts b/a.ts'}
                    filePath="a.ts"
                    virtualized
                />
            </InitialPresentationReadinessProvider>,
        );

        expect(
            screen.findAllByType(LazyMountOnScreen)[0]?.props.initiallyVisible,
        ).toBe(true);
    });

    it('falls back to Happier renderer when the env kill-switch disables pierre', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = '0';
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeNull();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeTruthy();
    });

    it('keeps Pierre renderer for click-only interactivity', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(
            <DiffViewer
                mode="unified"
                unifiedDiff={'diff --git a/a.ts b/a.ts'}
                filePath="a.ts"
                onPressLine={() => {}}
            />,
        );

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeTruthy();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeNull();
    });

    it('retains the Pierre host while Find and range selection open and close', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');
        const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n';
        const onPressLineRange = () => {};
        const screen = await renderScreen(
            <DiffViewer
                mode="unified"
                unifiedDiff={patch}
                filePath="a.ts"
                interactionMode="read"
                onPressLineRange={onPressLineRange}
            />,
        );

        const host = screen.findAllByType('pierre-file-diff')[0];
        expect(host).toBeTruthy();
        for (const [findActive, interactionMode] of [[true, 'read'], [false, 'commitSelection'], [false, 'read']] as const) {
            await screen.update(<DiffViewer mode="unified" unifiedDiff={patch} filePath="a.ts"
                findActive={findActive} interactionMode={interactionMode} onPressLineRange={onPressLineRange} />);
            expect(screen.findAllByType('pierre-file-diff')[0]).toBe(host);
        }
        expect(fileDiffMounts).toBe(1);
    });
});
