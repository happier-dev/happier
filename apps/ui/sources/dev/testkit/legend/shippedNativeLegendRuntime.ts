/**
 * Runtime selection + PROOF for the shipped-native Legend lane.
 *
 * Background - why this exists at all.
 *
 * `@legendapp/list` ships three separate builds. Under Node/Vite resolution the package specifier
 * `@legendapp/list/react-native` falls through to `react-native.web.mjs`, so every integration test
 * in this repository except the `*.native.real.integration.test.tsx` glob measures the DOM
 * implementation. `vitest.legend-native.config.ts` fixed the build for that one glob. It did not fix
 * the two remaining gaps between that lane and the app the user runs:
 *
 *   - `Platform.OS` was `'node'` unless a file mocked `react-native` itself, and
 *   - `global.nativeFabricUIManager` was never set, so `IsNewArchitecture === false` and the lane
 *     exercised old-architecture branches (`PositionViewAnimated` rows, `.measure()` layout
 *     fallback, `canRender` starting true, no layout-effect container measurement).
 *
 * Both are read ONCE, at module evaluation of the Legend build, so neither can be chosen from a test
 * body. `shippedNativeLegendSetup.ts` calls into this module from `setupFiles`, which is the last
 * point before the test file's import graph evaluates.
 *
 * Everything below is either a selector (runs in setup) or a PROOF (runs in a test). The proofs
 * exist because a harness that silently degrades to the web build, to `Platform.OS = 'node'`, or to
 * old architecture is worse than no harness: it certifies geometry the shipped app never executes.
 */
import type { ReactTestInstance } from 'react-test-renderer';

// The Legend native build only tests `global.nativeFabricUIManager != null` (react-native.mjs:366).
// It is given a recognizable identity rather than `{}` so a failure message can say what installed
// it, and frozen so a test cannot half-mutate it into something that reads as a real UIManager.
const SHIPPED_NATIVE_FABRIC_UI_MANAGER = Object.freeze({
    __happierShippedNativeLegendHarness: true as const,
});

/**
 * Installs a frame scheduler for the `node` test environment.
 *
 * The list schedules real work on `requestAnimationFrame` - `scheduleFullDrawDistancePrewarm`
 * (react-native.mjs:874) runs on the layout-effect measurement path that only NEW architecture
 * reaches, so this lane hits it on the very first commit where the old-architecture lane never did.
 * Backing it with `setTimeout` keeps frames on the timer queue, which means `vi.useFakeTimers()`
 * controls them like every other deferred list write instead of them escaping the test's control.
 *
 * Defined directly rather than through `vi.stubGlobal` so per-test stubbing still wins and
 * `vi.unstubAllGlobals()` restores back to this rather than to `undefined`.
 */
export function installShippedNativeFrameScheduler(): void {
    const target = globalThis as Record<string, unknown>;
    if (typeof target.requestAnimationFrame !== 'function') {
        target.requestAnimationFrame = (callback: (time: number) => void) => (
            setTimeout(() => callback(Date.now()), 16) as unknown as number
        );
    }
    if (typeof target.cancelAnimationFrame !== 'function') {
        target.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
    }
}

export type ShippedNativePlatformOS = 'ios' | 'android';

const SHIPPED_NATIVE_PLATFORM_ENV_VAR = 'HAPPIER_LEGEND_NATIVE_OS';
const DEFAULT_SHIPPED_NATIVE_PLATFORM: ShippedNativePlatformOS = 'ios';

/**
 * Installs the Fabric marker the Legend native build reads at import time.
 *
 * Must run before anything imports `@legendapp/list/react-native`.
 */
export function installShippedNativeArchitecture(): void {
    (globalThis as Record<string, unknown>).nativeFabricUIManager = SHIPPED_NATIVE_FABRIC_UI_MANAGER;
}

/**
 * Resolves which mobile OS this run pretends to be.
 *
 * Android is selected for a WHOLE RUN with `HAPPIER_LEGEND_NATIVE_OS=android`, never per test file:
 * the Legend build evaluates `PlatformAdjustBreaksScroll = Platform.OS === 'android'` at its own
 * module scope, so by the time a test body could ask for Android the answer is already frozen.
 */
export function resolveShippedNativeHarnessPlatform(): ShippedNativePlatformOS {
    const requested = process.env[SHIPPED_NATIVE_PLATFORM_ENV_VAR];
    if (requested !== undefined && requested !== 'ios' && requested !== 'android') {
        throw new Error(
            `${SHIPPED_NATIVE_PLATFORM_ENV_VAR} must be 'ios' or 'android' (received ${JSON.stringify(requested)}).`,
        );
    }
    return requested ?? DEFAULT_SHIPPED_NATIVE_PLATFORM;
}

export type ShippedNativeNodeGeometry = Readonly<{
    /** Height reported for the scroller itself - the viewport. */
    viewportHeight: number;
    /** Height reported for every other measured view - a row, unless `measureNode` overrides it. */
    rowHeight: number;
    width?: number;
}>;

export type ShippedNativeScrollerMock = Readonly<{
    flashScrollIndicators: () => void;
    getScrollableNode: () => unknown;
    getScrollResponder: () => unknown;
    measure: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    scrollTo: (options: Readonly<{ animated?: boolean; x?: number; y?: number }>) => void;
    setNativeProps: (props: unknown) => void;
    /** Every imperative scroll write the list made, oldest first. */
    scrollWrites: readonly Readonly<{ animated?: boolean; x?: number; y?: number }>[];
}>;

export type ShippedNativeNodeMock = Readonly<{
    scroller: ShippedNativeScrollerMock;
    createNodeMock: (element: Readonly<{ type: unknown }>) => unknown;
}>;

/**
 * Builds the `createNodeMock` a shipped-native mount needs.
 *
 * New architecture measures in layout effects that old architecture never runs
 * (react-native.mjs:5490 gates the whole hook, and both the `LayoutView` container at 5987 and the
 * SCROLLER at 7572 take the default `measureInLayoutEffect = true`). A node mock that omits
 * `measure` on the scroller therefore does not fail on old architecture and crashes on new - which
 * is precisely the trap that makes people conclude "the native lane does not work" and go back to
 * the web build. Handing tests a correct mock is the cheapest way to stop that happening again.
 */
export function createShippedNativeNodeMock(geometry: ShippedNativeNodeGeometry): ShippedNativeNodeMock {
    const width = geometry.width ?? 800;
    const scrollWrites: Readonly<{ animated?: boolean; x?: number; y?: number }>[] = [];

    const scroller: ShippedNativeScrollerMock = {
        flashScrollIndicators: () => {},
        getScrollableNode: () => scroller,
        getScrollResponder: () => scroller,
        measure: (callback) => callback(0, 0, width, geometry.viewportHeight),
        scrollTo: (options) => {
            scrollWrites.push(options);
        },
        scrollWrites,
        setNativeProps: () => {},
    };

    return {
        createNodeMock: (element) => {
            if (String(element.type) === 'ScrollView') return scroller;
            return {
                measure: (callback: (x: number, y: number, w: number, h: number) => void) => (
                    callback(0, 0, width, geometry.rowHeight)
                ),
                setNativeProps: () => {},
            };
        },
        scroller,
    };
}

export type ShippedNativeModuleFacts = Readonly<{
    isNewArchitecture: boolean;
    platformOS: string;
    fabricUIManagerInstalled: boolean;
}>;

/**
 * Reads the module-evaluation-time facts back out of the running lane.
 *
 * Pass the Legend module namespace (`import * as LegendNative from '@legendapp/list/react-native'`)
 * and the `react-native` `Platform`.
 *
 * `internal.IsNewArchitecture` is the library's OWN captured boolean rather than a recomputation, so
 * this reports what the build actually froze. It is a genuine runtime export that the package's
 * `.d.ts` does not declare, hence the narrow structural read - and hence the hard failure below: a
 * missing `internal` must not degrade into `undefined`, which would read as old architecture and
 * quietly invert every conclusion drawn from this harness.
 */
export function readShippedNativeModuleFacts(
    legendModule: object,
    platform: Readonly<{ OS: string }>,
): ShippedNativeModuleFacts {
    const internals = (legendModule as { internal?: { IsNewArchitecture?: unknown } }).internal;
    if (internals == null || typeof internals.IsNewArchitecture !== 'boolean') {
        throw new Error(
            '@legendapp/list/react-native no longer exposes `internal.IsNewArchitecture`. '
            + 'The shipped-native harness cannot verify which architecture it is running; '
            + 'find the new signal before trusting any test in this lane.',
        );
    }
    return {
        fabricUIManagerInstalled:
            (globalThis as Record<string, unknown>).nativeFabricUIManager === SHIPPED_NATIVE_FABRIC_UI_MANAGER,
        isNewArchitecture: internals.IsNewArchitecture,
        platformOS: platform.OS,
    };
}

/** The scroll-position bias the native `ScrollAdjust` view adds (react-native.mjs:5883). */
export const NATIVE_SCROLL_ADJUST_BIAS_PX = 1e7;

export type RenderedHostNode = Readonly<{
    type: unknown;
    props: Readonly<Record<string, unknown>>;
}>;

export type ShippedNativeTreeFacts = Readonly<{
    /** Host element names seen in the tree, deduplicated and sorted. */
    hostTypes: readonly string[];
    /** True when any DOM host element was rendered, which only the web build can produce. */
    renderedDomHosts: boolean;
    /** The open-loop MVCP offset carrier; `null` when the native ScrollAdjust view is absent. */
    scrollAdjustPx: number | null;
    /** Row-position carriers, classified by architecture. */
    positionViews: readonly PositionViewFacts[];
}>;

export type PositionViewFlavor =
    /** `PositionViewState` - new architecture. Plain RN `View`, numeric `top`. */
    | 'fabric-state'
    /** `PositionViewAnimated` - old architecture. `Animated.View`, `top` is an Animated value. */
    | 'legacy-animated'
    | 'unknown';

export type PositionViewFacts = Readonly<{
    flavor: PositionViewFlavor;
    top: number | null;
}>;

function readStyleEntries(style: unknown): readonly Record<string, unknown>[] {
    if (style == null) return [];
    if (Array.isArray(style)) return style.flatMap((entry) => readStyleEntries(entry));
    if (typeof style === 'object') return [style as Record<string, unknown>];
    return [];
}

function readStyleValue(style: unknown, key: string): unknown {
    let found: unknown;
    for (const entry of readStyleEntries(style)) {
        if (key in entry) found = entry[key];
    }
    return found;
}

/**
 * Classifies one candidate row-position node.
 *
 * This is the load-bearing architecture discriminator and it is deliberately a pure function over a
 * node shape rather than an inline assertion, so it can be fed a synthetic OLD-architecture tree and
 * shown to reject it. A discriminator that has never been shown to say "no" is not a discriminator.
 */
export function classifyPositionViewNode(node: RenderedHostNode): PositionViewFacts {
    const top = readStyleValue(node.props.style, 'top');
    if (node.type === 'Animated.View') {
        return { flavor: 'legacy-animated', top: null };
    }
    if (node.type === 'View' && typeof top === 'number') {
        return { flavor: 'fabric-state', top };
    }
    if (node.type === 'View' && top != null && typeof top === 'object') {
        // An Animated value that reached a plain View is still an old-architecture carrier.
        return { flavor: 'legacy-animated', top: null };
    }
    return { flavor: 'unknown', top: typeof top === 'number' ? top : null };
}

function isNativeScrollAdjustNode(node: RenderedHostNode): boolean {
    if (node.type !== 'View') return false;
    const style = node.props.style;
    if (style == null || Array.isArray(style) || typeof style !== 'object') return false;
    const entry = style as Record<string, unknown>;
    return (
        entry.position === 'absolute'
        && entry.height === 0
        && entry.width === 0
        && (typeof entry.top === 'number' || typeof entry.left === 'number')
    );
}

/**
 * Derives the harness-visible facts from an already-mounted tree.
 *
 * Takes host nodes rather than a renderer so it stays pure and testable; call it through
 * {@link readShippedNativeTreeFacts}.
 */
export function deriveShippedNativeTreeFacts(hostNodes: readonly RenderedHostNode[]): ShippedNativeTreeFacts {
    const hostTypes = new Set<string>();
    let scrollAdjustPx: number | null = null;
    const positionViews: PositionViewFacts[] = [];

    for (const node of hostNodes) {
        if (typeof node.type === 'string') hostTypes.add(node.type);

        if (isNativeScrollAdjustNode(node)) {
            const style = node.props.style as Record<string, unknown>;
            const axis = typeof style.top === 'number' && style.top !== 0 ? style.top : style.left;
            if (typeof axis === 'number') scrollAdjustPx = axis - NATIVE_SCROLL_ADJUST_BIAS_PX;
            continue;
        }

        // Row-position carriers are the nodes whose style array ends in a bare `top`/`left`
        // positioning entry. `PositionViewState` and `PositionViewAnimated` are the only producers
        // of that shape (react-native.mjs:5179-5201).
        if (node.type === 'Animated.View' || node.type === 'View') {
            const style = node.props.style;
            if (Array.isArray(style) && readStyleValue(style, 'top') != null) {
                positionViews.push(classifyPositionViewNode(node));
            }
        }
    }

    return {
        hostTypes: [...hostTypes].sort(),
        positionViews,
        renderedDomHosts: [...hostTypes].some((type) => DOM_HOST_TYPES.has(type)),
        scrollAdjustPx,
    };
}

// The web build's `View`/`Text`/`AnimatedView` are all `div`s and its `WebAnchoredEndSpace` renders
// a literal `div`. Any of these in the tree means the package specifier resolved to
// `react-native.web.mjs`.
const DOM_HOST_TYPES = new Set(['div', 'span', 'p']);

export type MountedTestTree = Readonly<{ root: ReactTestInstance }>;

/** Collects host nodes from a `react-test-renderer` tree and derives the harness facts. */
export function readShippedNativeTreeFacts(screen: MountedTestTree): ShippedNativeTreeFacts {
    const hostNodes = screen.root.findAll((node) => typeof node.type === 'string', { deep: true });
    return deriveShippedNativeTreeFacts(
        hostNodes.map((node) => ({ props: node.props as Record<string, unknown>, type: node.type })),
    );
}

export type ShippedNativeRuntimeViolation = Readonly<{ code: string; detail: string }>;

/**
 * Returns every reason the current lane is NOT the shipped native path.
 *
 * Split out from the assertion so a test can prove the check has teeth by feeding it degraded facts.
 */
export function findShippedNativeRuntimeViolations(
    moduleFacts: ShippedNativeModuleFacts,
    treeFacts: ShippedNativeTreeFacts,
): readonly ShippedNativeRuntimeViolation[] {
    const violations: ShippedNativeRuntimeViolation[] = [];

    if (treeFacts.renderedDomHosts) {
        violations.push({
            code: 'web_build_resolved',
            detail:
                `Rendered DOM host elements (${treeFacts.hostTypes.join(', ')}). `
                + '`@legendapp/list/react-native` resolved to react-native.web.mjs; the lane is measuring DOM geometry.',
        });
    }
    if (!moduleFacts.fabricUIManagerInstalled) {
        violations.push({
            code: 'fabric_marker_missing',
            detail:
                'global.nativeFabricUIManager was not installed by shippedNativeLegendSetup.ts. '
                + 'Run this file through vitest.legend-fabric.config.ts.',
        });
    }
    if (!moduleFacts.isNewArchitecture) {
        violations.push({
            code: 'old_architecture',
            detail:
                'internal.IsNewArchitecture is false: Legend evaluated before the Fabric marker existed. '
                + 'Rows render through PositionViewAnimated, not the PositionViewState the shipped app uses.',
        });
    }
    if (moduleFacts.platformOS !== 'ios' && moduleFacts.platformOS !== 'android') {
        violations.push({
            code: 'non_mobile_platform',
            detail: `Platform.OS is ${JSON.stringify(moduleFacts.platformOS)}; the library takes neither its iOS nor its Android branches.`,
        });
    }
    if (treeFacts.scrollAdjustPx === null) {
        violations.push({
            code: 'native_scroll_adjust_absent',
            detail:
                'The native open-loop ScrollAdjust view (a 0x0 absolute View biased by 1e7) is not in the tree. '
                + 'Either the list has not laid out yet, or this is not the native build.',
        });
    }
    const legacyRows = treeFacts.positionViews.filter((view) => view.flavor !== 'fabric-state');
    if (treeFacts.positionViews.length > 0 && legacyRows.length > 0) {
        violations.push({
            code: 'legacy_position_views',
            detail:
                `${legacyRows.length}/${treeFacts.positionViews.length} row-position carriers are not PositionViewState `
                + `(flavors: ${[...new Set(legacyRows.map((row) => row.flavor))].join(', ')}).`,
        });
    }

    return violations;
}

/**
 * Fails the test unless the mounted tree is the build, platform and architecture the user runs.
 *
 * Call this in every shipped-native test after the first layout. It is cheap (one tree walk) and it
 * is the only thing standing between this lane and quietly certifying the wrong renderer again.
 */
export function assertShippedNativeLegendRuntime(
    screen: MountedTestTree,
    moduleFacts: ShippedNativeModuleFacts,
): ShippedNativeTreeFacts {
    const treeFacts = readShippedNativeTreeFacts(screen);
    const violations = findShippedNativeRuntimeViolations(moduleFacts, treeFacts);
    if (violations.length > 0) {
        throw new Error(
            'This lane is not executing the shipped native Legend path:\n'
            + violations.map((violation) => `  - [${violation.code}] ${violation.detail}`).join('\n'),
        );
    }
    return treeFacts;
}
