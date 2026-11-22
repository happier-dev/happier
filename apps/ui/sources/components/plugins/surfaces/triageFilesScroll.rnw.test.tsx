// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button, ScrollArea, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { TriageChangedFilesList, TriageDetailPageScrollProvider, TriageDetailPanel } from '@happier-dev/triage-sources/ui';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createScrollViewNearViewportTracker, resolveNearViewportWindow } from '@/components/widgets/nearViewport';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';
import { createDeferred } from '@/dev/testkit';
import { PluginUiPresentationHostProviderInternal } from '../../../../../../packages/plugin-ui/src/presentationHost/context';

vi.mock('react-native', () => import('react-native-web'));

const VIEWPORT_HEIGHT = 715;
const surfaceContext = createSurfaceContextFixture();
const { typography, spacing } = surfaceContext.theme;
const ROW_HEIGHT = typography.reading.lineHeight + 2 * spacing.small;
const DIFF_HEIGHT = Math.floor(VIEWPORT_HEIGHT / (2 * ROW_HEIGHT)) * ROW_HEIGHT;
const FIRST_PAGE = Array.from({ length: 101 }, (_, index) => ({
    path: `qa-large-pr/row-${String(index + 100).padStart(3, '0')}.txt`,
    diffAvailable: true,
}));
const MORE_FILES = Array.from({ length: 100 }, (_, index) => ({
    path: `qa-large-pr/row-${String(index + 201).padStart(3, '0')}.txt`,
    diffAvailable: true,
}));

const host = {
    // These host leaves sit outside the file list and scroller contract.
    renderIcon: () => null,
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    createScrollActivityTracker: (ref: React.RefObject<unknown>, horizontal: boolean) =>
        createScrollViewNearViewportTracker(ref, horizontal, { initialViewportHeight: VIEWPORT_HEIGHT }),
};

function FilesFixture({ nextPage }: Readonly<{ nextPage: () => Promise<typeof FIRST_PAGE> }>) {
    const [panel, setPanel] = React.useState('files');
    const [rows, setRows] = React.useState(FIRST_PAGE);
    const [focusPath, setFocusPath] = React.useState<string | null>(null);
    return (
        <PluginUiPresentationHostProviderInternal host={host}>
            <Button title="Checks tab" onPress={() => { setPanel('checks'); setFocusPath(null); }} />
            <Button title="Files tab" onPress={() => setPanel('files')} />
            <TriageDetailPageScrollProvider pageScroll>
                <ScrollArea testID="compact-detail" scrollEventThrottle={16}>
                    <TriageDetailPanel panel={panel} scrollOwner="list" ariaLabel="Pull request"
                        retention={{ files: 'retain' }}
                        panels={{
                            files: <TriageChangedFilesList accessibilityLabel="Changed files" accessibilityLabelKey="fixture.changedFiles"
                                sections={[{ key: 'source', title: '', data: rows }]} active={panel === 'files'}
                                focusPath={focusPath} onFocusPath={setFocusPath} viewed={null} header={null}
                                renderBody={() => <Text value="Settled expanded diff" />}
                                endContent={<Button title="Show more files" onPress={async () => {
                                    const next = await nextPage();
                                    setRows(current => [...current, ...next].sort((a, b) => a.path.localeCompare(b.path)));
                                }} />} />,
                            checks: <Text value="No checks" />,
                        }} />
                </ScrollArea>
            </TriageDetailPageScrollProvider>
        </PluginUiPresentationHostProviderInternal>
    );
}

const mounted: PluginUiTestkit[] = [];
beforeEach(() => {
    // Deliver each test scroll at a distinct RNW throttle tick.
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 50));
});
afterEach(async () => {
    await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });
    vi.restoreAllMocks();
});

async function mountFiles({ diffHeight = DIFF_HEIGHT } = {}) {
    const nextPage = createDeferred<typeof FIRST_PAGE>();
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'files-scroll', mountNonce: 'files-scroll-mount' },
            authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
            surfaceContext,
            surface: defineUiSurface(() => <FilesFixture nextPage={() => nextPage.promise} />),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            launchInput: {},
        });
    });
    mounted.push(fixture);
    const scroller = document.querySelector<HTMLElement>('[data-testid="compact-detail"]')!;
    // RNW calls the browser's scroll primitive. Keep its scroll responder and layout callbacks real.
    scroller.scroll = (...args: [ScrollToOptions?] | [number, number]) => {
        const top = typeof args[0] === 'number' ? args[1]! : (args[0]?.top ?? 0);
        if (top === scroller.scrollTop) return;
        scroller.scrollTop = top;
        queueMicrotask(() => { if (scroller.isConnected) scroller.dispatchEvent(new Event('scroll')); });
    };
    Object.defineProperties(scroller, {
        clientHeight: { value: VIEWPORT_HEIGHT },
        scrollHeight: { get: () => FIRST_PAGE.length * ROW_HEIGHT
            + (scroller.querySelector('[role="listitem"] [aria-expanded="true"]') ? diffHeight : 0) },
    });
    const measure = () => reportGeometry(scroller, diffHeight);
    await measure();
    const press = async (name: string) => {
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name })); });
    };
    return { nextPage, scroller, press, measure, diffHeight };
}

function fileButtons(): HTMLElement[] {
    const list = document.querySelector('[role="list"][aria-label="Changed files"]')!;
    return [...list.querySelectorAll('[role="listitem"]')]
        .flatMap(row => row.querySelector<HTMLElement>('[role="button"][aria-expanded]') ?? []);
}

function filePath(button: HTMLElement): string {
    return button.querySelector('[aria-label^="qa-large-pr/"]')?.getAttribute('aria-label')
        ?? button.textContent!.match(/qa-large-pr\/row-\d+\.txt/u)![0];
}

async function scroll(scroller: HTMLElement, offset: number) {
    await act(async () => {
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new Event('scroll'));
    });
}

async function reportGeometry(scroller: HTMLElement, diffHeight: number) {
    const list = scroller.querySelector<HTMLElement>('[role="list"][aria-label="Changed files"]')!;
    const content = scroller.firstElementChild as HTMLElement;
    const rect = () => new DOMRect(0, -scroller.scrollTop, 390, VIEWPORT_HEIGHT);
    list.getBoundingClientRect = rect;
    content.getBoundingClientRect = rect;
    const reportLayout = (node: HTMLElement, height: number) => {
        const handler: unknown = Reflect.get(node, '__reactLayoutHandler');
        if (typeof handler !== 'function') throw new Error('Expected a measured RNW view');
        handler({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } });
    };
    await act(async () => {
        reportLayout(scroller, VIEWPORT_HEIGHT);
        reportLayout(list, VIEWPORT_HEIGHT);
        for (const button of fileButtons()) {
            let cell = button;
            while (cell.parentElement && cell.parentElement !== list) cell = cell.parentElement;
            reportLayout(cell, fileHeight(button, diffHeight));
        }
    });
}

function fileHeight(button: HTMLElement, diffHeight: number) {
    return ROW_HEIGHT + (button.getAttribute('aria-expanded') === 'true' ? diffHeight : 0);
}

/** Supply row box geometry at the jsdom platform boundary. These cases stay in the first mounted window. */
function readAnchor(scroller: HTMLElement, diffHeight = DIFF_HEIGHT) {
    let top = 0;
    for (const button of fileButtons()) {
        const height = fileHeight(button, diffHeight);
        const offset = top - scroller.scrollTop;
        if (offset + height > 0) return { path: filePath(button), offset };
        top += height;
    }
    throw new Error('No file intersects the viewport');
}

async function scrollPastOpenDiff({ scroller, measure, diffHeight }: Awaited<ReturnType<typeof mountFiles>>) {
    await act(async () => { fileButtons()[0].click(); });
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('true');
    await measure();
    // Start just inside the anchor row, with the first row's diff above it.
    await scroll(scroller, diffHeight + 4 * ROW_HEIGHT + 3);
    const anchor = readAnchor(scroller, diffHeight);
    expect(anchor).toEqual({ path: FIRST_PAGE[4].path, offset: -3 });
    return anchor;
}

it('keeps compact Files mounted work in the page window through paging and scrolling', async () => {
    const { scroller, nextPage, press } = await mountFiles();
    const assertWindow = () => {
        const buttons = fileButtons();
        const window = resolveNearViewportWindow({
            viewportHeight: VIEWPORT_HEIGHT,
            quantum: PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
            windowTopOffset: scroller.scrollTop,
        })!;
        // Partially visible boundary rows can intersect the viewport plus existing host overscan.
        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.length).toBeLessThanOrEqual(Math.floor((window.bottom - window.top) / ROW_HEIGHT) + 2);
        const paths = buttons.map(filePath);
        // File activators participate in sequential focus in the same order as the list.
        expect(buttons.filter(button => button.tabIndex >= 0)).toEqual(buttons);
        expect(paths).toEqual([...paths].sort());
        return paths;
    };
    expect(assertWindow()).toContain(FIRST_PAGE[0].path);
    await press('Show more files');
    await act(async () => { nextPage.resolve(MORE_FILES); });
    expect(assertWindow()).toContain(FIRST_PAGE[0].path);
    await scroll(scroller, FIRST_PAGE.length * ROW_HEIGHT);
    const later = assertWindow();
    expect(later).toContain(MORE_FILES[0].path);
    // The shared List can keep its keyboard tab stop mounted even after the viewport moves.
    expect(later).not.toContain(FIRST_PAGE[1].path);
});

it('holds the same visible file and pixel offset through a trailing append with a diff open', async () => {
    const files = await mountFiles();
    const { scroller, nextPage, press } = files;
    const anchor = await scrollPastOpenDiff(files);
    await press('Show more files');
    await act(async () => { nextPage.resolve(MORE_FILES); });
    expect(readAnchor(scroller)).toEqual(anchor);
    expect(fileButtons().filter(button => button.getAttribute('aria-expanded') === 'true')).toHaveLength(1);
});

it.each([
    { name: 'after closing the diff above it', diffHeight: DIFF_HEIGHT },
    { name: 'when the browser clamps the old position before the closed diff is remeasured', diffHeight: 31_200, clamp: true },
])('restores the same visible file and pixel offset $name', async ({ diffHeight, clamp }) => {
    const files = await mountFiles({ diffHeight });
    const { scroller, press, measure } = files;
    const anchor = await scrollPastOpenDiff(files);
    await press('Checks tab');
    // jsdom does not clamp the shared scroller when the Checks content becomes shorter.
    await scroll(scroller, 0);
    await press('Files tab');
    expect(fileButtons().filter(button => button.getAttribute('aria-expanded') === 'true')).toHaveLength(0);
    // In a browser the restored offset fits for a frame, then the closed content clamps it before onLayout.
    if (clamp) await scroll(scroller, scroller.scrollHeight - scroller.clientHeight);
    await measure();
    expect(readAnchor(scroller)).toEqual(anchor);
});

it('holds the same visible file and pixel offset when the next page sorts earlier files above it', async () => {
    const files = await mountFiles();
    const { scroller, nextPage, press } = files;
    const anchor = await scrollPastOpenDiff(files);
    await press('Show more files');
    const earlierFiles = MORE_FILES.slice(0, 2).map((file, index) => ({
        ...file,
        path: `qa-large-pr/row-00${index}.txt`,
    }));
    await act(async () => { nextPage.resolve([...earlierFiles, ...MORE_FILES.slice(2)]); });
    expect(fileButtons().map(filePath)).toContain(earlierFiles[0].path);
    expect(readAnchor(scroller)).toEqual(anchor);
});
