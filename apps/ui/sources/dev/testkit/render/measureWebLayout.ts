import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { relativeLineHeight } from '@/components/ui/text/webUnistylesFontOverrides';

/**
 * Real browser geometry for a react-native-web tree rendered in jsdom.
 *
 * jsdom has no layout engine, and a host renderer has no layout at all, so a test that reads styles
 * can pass while the page lays out wrong (the DESIGN-6/7 rhythm and clamp regressions). This hands
 * the exact DOM react-native-web produced — its injected style sheets plus the rendered markup — to
 * headless Chromium at a given viewport and returns each `data-testid` element's border box, so a
 * test asserts measured distances instead of style values.
 *
 * Components that size themselves from `onLayout` (a name sized to its words, a clamp's line probe)
 * need the browser's answer fed back: with {@link installWebLayoutBridge} installed before the first
 * render, `settle` replays Chromium's boxes into jsdom's layout reads and react-native-web's
 * `ResizeObserver`, re-renders, and measures again until the markup stops changing.
 *
 * The browser is a genuine platform boundary: the test supplies one through
 * `HAPPIER_TEST_CHROMIUM_CDP_URL` to reuse a kept-open browser, or `HAPPIER_TEST_CHROMIUM_PATH`, the
 * agent-browser install, or Playwright's own cache. A supplied CDP endpoint never falls back to a
 * browser launch; measurements own only their new page, not the connected browser's existing pages.
 *
 * `minimumFontSize` is the browser's own "Minimum font size" setting, a profile preference that
 * enlarges text past every CSS size (the large-text reports); it launches a fresh profile, so it
 * cannot reuse a supplied CDP browser, and it fails when the browser ignores the preference.
 *
 * Diagnosing a failure: `HAPPIER_TEST_WEB_LAYOUT_DEBUG=<css selector>` prints each match's box and
 * computed flex chain up five ancestors.
 */
export type WebLayoutRect = Readonly<{
    top: number; bottom: number; left: number; right: number; width: number; height: number;
    /** Content wider or taller than the box it is clipped by (a hard cut, not an ellipsis). */
    clipped?: boolean;
    /** The element's rendered text, as a reader sees it. */
    text?: string;
    /**
     * Whether a pointer at the box's centre reaches this element (or a descendant): false when another
     * element, even an invisible one, sits on top of it and takes the click.
     */
    receivesPointer?: boolean;
    /**
     * For ids named in `edgeProbeTestIds`: whether a pointer one pixel inside each side of the box reaches
     * this element. A clipping ancestor or a cover on that side answers false (a resize target cut at a pane edge).
     */
    receivesPointerAtEdges?: Readonly<{ left: boolean; right: boolean; top: boolean; bottom: boolean }>;
    outlineWidth?: number;
    outlineStyle?: string;
    /**
     * The font family the browser resolved. Happier encodes a weight in its face (`Inter-SemiBold`),
     * so a weight is asserted through the family, not `font-weight`.
     */
    fontFamily?: string;
    /** The computed font size and line height in pixels, after any minimum font size. */
    fontSize?: number;
    lineHeight?: number;
    /** Scroll extent and offset after browser focus, for scroll-owner regressions. */
    clientWidth?: number;
    scrollWidth?: number;
    scrollLeft?: number;
}>;

export type WebLayoutMeasurement = Readonly<{
    /** Every `data-testid` element's box, in document order (a test id can repeat). */
    rects: ReadonlyMap<string, readonly WebLayoutRect[]>;
    /** The one box for a test id; throws when it is missing, so a renamed id never measures nothing. */
    rect: (testId: string) => WebLayoutRect;
    /** Boxes of every element whose own text is exactly `text`. */
    textRects: (text: string) => readonly WebLayoutRect[];
}>;

type ElementGeometry = Readonly<{ rect: WebLayoutRect; scrollHeight: number; scrollWidth: number }>;
type LayoutObserver = { callback: (entries: Array<{ target: Element }>) => void; targets: Set<Element> };

const geometry = new WeakMap<Element, ElementGeometry>();
// RNW retains its observer across test-module reloads. Its observed DOM, not this module,
// owns the recording, so the next harness can replay that same platform observer.
const observerRecords = Symbol.for('happier.test.webLayout.observers');
type ObservedElement = Element & { [observerRecords]?: Set<LayoutObserver> };

/**
 * Lets react-native-web's `onLayout` and a field's content measurement read the browser's boxes:
 * a recording `ResizeObserver` and layout getters backed by the last {@link measureWebLayout} pass.
 * Install it before the first render (react-native-web creates its observer lazily).
 */
export function installWebLayoutBridge(): void {
    class RecordingResizeObserver {
        private readonly record: LayoutObserver;
        constructor(callback: (entries: Array<{ target: Element }>) => void) {
            this.record = { callback, targets: new Set() };
        }
        observe(target: ObservedElement) {
            this.record.targets.add(target);
            (target[observerRecords] ??= new Set()).add(this.record);
        }
        unobserve(target: ObservedElement) {
            this.record.targets.delete(target);
            target[observerRecords]?.delete(this.record);
            if (target[observerRecords]?.size === 0) delete target[observerRecords];
        }
        disconnect() { for (const target of this.record.targets) this.unobserve(target); }
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const read = (element: Element) => geometry.get(element);
    const define = (name: string, get: (this: Element) => unknown) => {
        Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
    };
    define('offsetWidth', function () { return read(this)?.rect.width ?? 0; });
    define('offsetHeight', function () { return read(this)?.rect.height ?? 0; });
    define('offsetLeft', function () { return read(this)?.rect.left ?? 0; });
    define('offsetTop', function () { return read(this)?.rect.top ?? 0; });
    // Boxes are page coordinates, so no element reports an offset parent.
    define('offsetParent', () => null);
    define('scrollHeight', function () { return read(this)?.scrollHeight ?? 0; });
    define('scrollWidth', function () { return read(this)?.scrollWidth ?? 0; });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
        const rect = read(this)?.rect ?? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
        return { ...rect, x: rect.left, y: rect.top, toJSON: () => rect } as DOMRect;
    };
}

export function resolveChromiumExecutable(): string | undefined {
    const explicit = process.env.HAPPIER_TEST_CHROMIUM_PATH;
    if (explicit !== undefined && explicit.length > 0) return explicit;
    const agentBrowserRoot = path.join(homedir(), '.agent-browser', 'browsers');
    if (existsSync(agentBrowserRoot)) {
        for (const entry of readdirSync(agentBrowserRoot).sort().reverse()) {
            const candidate = path.join(agentBrowserRoot, entry, 'chrome');
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * The shipped web app renders each element's styles as one Unistyles class, and the font override
 * owner rewrites a pixel line height beside a pixel font size into a multiple of that font size.
 * Under the test runtime the same styles arrive as react-native-web inline styles, so the browser
 * receives the owner's rewrite here; without it, enlarged text would lay out unlike the app.
 */
function shippedLineHeights(container: HTMLElement): HTMLElement {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const element of Array.from(clone.querySelectorAll<HTMLElement>('[style]'))) {
        const ratio = relativeLineHeight({ fontSize: element.style.fontSize, lineHeight: element.style.lineHeight });
        if (ratio !== null) element.style.lineHeight = ratio;
    }
    return clone;
}

function serialize(container: HTMLElement, width: number): string {
    // react-native-web inserts its rules through the CSSOM (`insertRule`), so a style element's text
    // can be empty while its sheet holds every rule.
    const styles = Array.from(container.ownerDocument.querySelectorAll('style')).map((element) => {
        const rules = element.sheet?.cssRules;
        return rules !== undefined && rules.length > 0
            ? Array.from(rules).map((rule) => rule.cssText).join('\n')
            : element.textContent ?? '';
    }).join('\n');
    // The live document owns theme variables and input modality. Preserve its
    // root attributes through the browser boundary, using the DOM's serializer.
    const html = container.ownerDocument.documentElement.cloneNode(false) as HTMLElement;
    const openingHtml = html.outerHTML.replace(/<\/html>$/u, '');
    return `<!doctype html>${openingHtml}<head><meta charset="utf-8"><style>${styles}</style>`
        + '<style>html,body{margin:0;font-family:Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased}</style>'
        + `</head><body><div id="root" style="display:flex;flex-direction:column;width:${width}px">${shippedLineHeights(container).innerHTML}</div></body></html>`;
}

export async function measureWebLayout(container: HTMLElement, options: Readonly<{
    viewport: Readonly<{ width: number; height: number }>;
    /** Text whose boxes the test needs (headings without a test id). */
    texts?: readonly string[];
    /** Apply real browser focus to the already-rendered control when measuring its visible ring. */
    focusedTestId?: string;
    /** Test ids whose box sides are hit-tested too (`receivesPointerAtEdges`). */
    edgeProbeTestIds?: readonly string[];
    /** Optional visual evidence of the same settled layout measured below. */
    screenshotPath?: string;
    /** The browser's minimum font size preference in pixels (Chrome settings → Appearance → Customize fonts). */
    minimumFontSize?: number;
    /**
     * Replays the browser's boxes into `onLayout` and re-renders until the markup is stable; `flush`
     * is the test's `act` around the replay. Needs {@link installWebLayoutBridge}.
     */
    settle?: (replay: () => Promise<void>) => Promise<void>;
}>): Promise<WebLayoutMeasurement> {
    const { chromium } = await import('playwright');
    const cdpUrl = process.env.HAPPIER_TEST_CHROMIUM_CDP_URL;
    const { minimumFontSize } = options;
    if (minimumFontSize !== undefined && cdpUrl) {
        throw new Error('measureWebLayout: minimumFontSize needs its own browser profile, not HAPPIER_TEST_CHROMIUM_CDP_URL');
    }
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let profile: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    let profileDir: string | undefined;
    try {
        if (minimumFontSize !== undefined) {
            profileDir = mkdtempSync(path.join(tmpdir(), 'happier-web-layout-'));
            mkdirSync(path.join(profileDir, 'Default'));
            writeFileSync(path.join(profileDir, 'Default', 'Preferences'),
                JSON.stringify({ webkit: { webprefs: { minimum_font_size: minimumFontSize } } }));
            const executablePath = resolveChromiumExecutable();
            profile = await chromium.launchPersistentContext(profileDir, executablePath === undefined ? {} : { executablePath });
        } else if (cdpUrl) {
            browser = await chromium.connectOverCDP(cdpUrl);
        } else {
            const executablePath = resolveChromiumExecutable();
            browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
        }
    } catch (error) {
        if (profileDir !== undefined) rmSync(profileDir, { recursive: true, force: true });
        throw new Error(cdpUrl
            ? `measureWebLayout could not connect to HAPPIER_TEST_CHROMIUM_CDP_URL (${String(error)})`
            : `measureWebLayout needs a Chromium: set HAPPIER_TEST_CHROMIUM_PATH (${String(error)})`);
    }
    let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
    try {
        const viewport = { width: options.viewport.width, height: options.viewport.height };
        if (profile !== undefined) {
            page = await profile.newPage();
            await page.setViewportSize(viewport);
            await page.setContent('<p style="font-size:1px">probe</p>');
            const applied = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('p')!).fontSize));
            if (applied < minimumFontSize!) {
                throw new Error(`measureWebLayout: this browser ignored minimumFontSize (${applied}px); use a full Chrome via HAPPIER_TEST_CHROMIUM_PATH`);
            }
        } else {
            page = await browser!.newPage({ viewport });
        }
        const { settle } = options;
        if (settle !== undefined) {
            // Owners measure in chains (a probe sizes a field, the field then measures its content), so
            // replay until two passes in a row leave the markup unchanged.
            let unchanged = 0;
            for (let pass = 0; pass < 8 && unchanged < 2; pass += 1) {
                const before = container.innerHTML;
                await page.setContent(serialize(container, options.viewport.width));
                const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('#root *')).map((element) => {
                    const r = element.getBoundingClientRect();
                    return { rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
                        scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth };
                }));
                const elements = Array.from(container.querySelectorAll('*'));
                if (elements.length !== boxes.length) {
                    throw new Error(`measureWebLayout: the browser parsed ${boxes.length} elements, jsdom holds ${elements.length}`);
                }
                elements.forEach((element, index) => geometry.set(element, boxes[index]!));
                await settle(async () => {
                    const entriesByObserver = new Map<LayoutObserver, Array<{ target: Element }>>();
                    for (const target of elements) {
                        for (const observer of (target as ObservedElement)[observerRecords] ?? []) {
                            const entries = entriesByObserver.get(observer) ?? [];
                            entries.push({ target });
                            entriesByObserver.set(observer, entries);
                        }
                    }
                    for (const [observer, entries] of entriesByObserver) observer.callback(entries);
                    // react-native-web measures on a timer, then the owners commit their state.
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                });
                unchanged = container.innerHTML === before ? unchanged + 1 : 0;
            }
            if (unchanged < 2) {
                throw new Error('measureWebLayout: layout did not settle after 8 passes (two unchanged passes required)');
            }
        }
        await page.setContent(serialize(container, options.viewport.width));
        if (options.focusedTestId) await page.getByTestId(options.focusedTestId).focus();
        if (process.env.HAPPIER_TEST_WEB_LAYOUT_DEBUG) {
            console.log('DEBUG', await page.evaluate((selector: string) => Array.from(document.querySelectorAll(selector)).map((element) => {
                const chain: string[] = [];
                let node: Element | null = element;
                for (let i = 0; i < 5 && node !== null; i += 1, node = node.parentElement) {
                    const r = node.getBoundingClientRect(); const cs = getComputedStyle(node);
                    chain.push(`${node.tagName} x=${r.left} w=${r.width} y=${r.top} h=${r.height} jc=${cs.justifyContent} ai=${cs.alignItems} fg=${cs.flexGrow} fb=${cs.flexBasis} wrap=${cs.flexWrap} dir=${cs.flexDirection} lh=${cs.lineHeight} style=${node.getAttribute('style') ?? ''}`);
                }
                return chain.join('\n  ');
            }).join('\n'), process.env.HAPPIER_TEST_WEB_LAYOUT_DEBUG));
        }
        const measured = await page.evaluate(({ texts, edgeProbeTestIds }: { texts: readonly string[]; edgeProbeTestIds: readonly string[] }) => {
            const reaches = (element: Element, x: number, y: number) => {
                const topmost = document.elementFromPoint(x, y);
                return topmost !== null && element.contains(topmost);
            };
            const box = (element: Element) => {
                const r = element.getBoundingClientRect();
                const clipped = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
                const computed = getComputedStyle(element);
                const topmost = r.width > 0 && r.height > 0
                    ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height,
                    clipped, text: (element as HTMLElement).innerText ?? '',
                    receivesPointer: topmost !== null && element.contains(topmost),
                    ...(edgeProbeTestIds.includes(element.getAttribute('data-testid') ?? '') && r.width > 2 && r.height > 2 ? {
                        receivesPointerAtEdges: {
                            left: reaches(element, r.left + 1, r.top + r.height / 2),
                            right: reaches(element, r.right - 1, r.top + r.height / 2),
                            top: reaches(element, r.left + r.width / 2, r.top + 1),
                            bottom: reaches(element, r.left + r.width / 2, r.bottom - 1),
                        },
                    } : null),
                    outlineWidth: parseFloat(computed.outlineWidth), outlineStyle: computed.outlineStyle,
                    fontFamily: computed.fontFamily,
                    fontSize: parseFloat(computed.fontSize), lineHeight: parseFloat(computed.lineHeight),
                    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft };
            };
            const byTestId: Array<[string, ReturnType<typeof box>]> = [];
            for (const element of Array.from(document.querySelectorAll('[data-testid]'))) {
                byTestId.push([element.getAttribute('data-testid') ?? '', box(element)]);
            }
            const byText: Array<[string, ReturnType<typeof box>]> = [];
            for (const element of Array.from(document.querySelectorAll('body *'))) {
                const own = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => node.textContent ?? '').join('');
                if (texts.includes(own)) {
                    // An opacity-hidden separator still owns layout space, but
                    // has no visible glyph. Return text boxes a reader can see.
                    let visible = true;
                    for (let node: Element | null = element; node !== null; node = node.parentElement) {
                        const computed = getComputedStyle(node);
                        if (computed.opacity === '0' || computed.visibility === 'hidden' || computed.display === 'none') { visible = false; break; }
                    }
                    if (visible) byText.push([own, box(element)]);
                }
            }
            return { byTestId, byText };
        }, { texts: options.texts ?? [], edgeProbeTestIds: options.edgeProbeTestIds ?? [] });
        if (options.screenshotPath) await page.screenshot({ path: options.screenshotPath });
        const rects = new Map<string, WebLayoutRect[]>();
        for (const [id, rect] of measured.byTestId) rects.set(id, [...(rects.get(id) ?? []), rect]);
        return {
            rects,
            rect: (testId) => {
                const found = rects.get(testId)?.[0];
                if (found === undefined) throw new Error(`measureWebLayout: no element with data-testid "${testId}"`);
                return found;
            },
            textRects: (text) => measured.byText.filter(([own]) => own === text).map(([, rect]) => rect),
        };
    } finally {
        // newPage owns its isolated context; close it before disconnecting a CDP connection.
        try {
            await page?.close();
        } finally {
            // For connectOverCDP, Playwright closes only its transport, not the remote browser.
            await browser?.close();
            await profile?.close();
            if (profileDir !== undefined) rmSync(profileDir, { recursive: true, force: true });
        }
    }
}
