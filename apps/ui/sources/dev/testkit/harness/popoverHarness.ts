import type { ReactTestInstance } from 'react-test-renderer';
import { vi } from 'vitest';

type TreeLike = Readonly<{
    root: ReactTestInstance;
}> | ReactTestInstance;

type PopoverWebGlobalsOptions = Readonly<{
    frameScheduler?: typeof globalThis.requestAnimationFrame;
    requestAnimationFrame?: typeof globalThis.requestAnimationFrame;
    window?: Record<string, unknown>;
}>;

function resolveRoot(tree: TreeLike): ReactTestInstance {
    return 'root' in tree ? tree.root : tree;
}

function restoreGlobal(name: 'requestAnimationFrame' | 'cancelAnimationFrame' | 'window', previousValue: unknown, hadOwnValue: boolean) {
    if (hadOwnValue) {
        (globalThis as Record<string, unknown>)[name] = previousValue;
        return;
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as Record<string, unknown>)[name];
}

function installPopoverWebGlobals(options: PopoverWebGlobalsOptions = {}): () => void {
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const hadRequestAnimationFrame = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
    const hadCancelAnimationFrame = Object.prototype.hasOwnProperty.call(globalThis, 'cancelAnimationFrame');
    const previousWindow = (globalThis as Record<string, unknown>).window;
    const previousRequestAnimationFrame = (globalThis as Record<string, unknown>).requestAnimationFrame;
    const previousCancelAnimationFrame = (globalThis as Record<string, unknown>).cancelAnimationFrame;
    const pendingFrames = new Set<ReturnType<typeof setTimeout>>();

    (globalThis as Record<string, unknown>).window = options.window ?? {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        // Every browser window has a document address; web route owners read it (plugin page ingress).
        location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '' },
    };
    const customFrameScheduler = options.frameScheduler ?? options.requestAnimationFrame;
    (globalThis as Record<string, unknown>).requestAnimationFrame = customFrameScheduler
        ?? ((callback: FrameRequestCallback) => {
            // A browser frame is deferred. Synchronous callbacks recurse when
            // the real transcript owner schedules its next layout-settle frame.
            const timer = setTimeout(() => {
                pendingFrames.delete(timer);
                callback(performance.now());
            }, 0);
            pendingFrames.add(timer);
            // Node timers are opaque handles; the browser port uses numeric ids.
            return timer as unknown as number;
        });
    if (!customFrameScheduler) {
        (globalThis as Record<string, unknown>).cancelAnimationFrame = (frame: number) => {
            const timer = frame as unknown as ReturnType<typeof setTimeout>;
            if (pendingFrames.delete(timer)) clearTimeout(timer);
        };
    }

    return () => {
        for (const timer of pendingFrames) clearTimeout(timer);
        pendingFrames.clear();
        restoreGlobal('window', previousWindow, hadWindow);
        restoreGlobal('requestAnimationFrame', previousRequestAnimationFrame, hadRequestAnimationFrame);
        restoreGlobal('cancelAnimationFrame', previousCancelAnimationFrame, hadCancelAnimationFrame);
    };
}

export function flattenTestStyle(style: unknown): Record<string, unknown> {
    if (!style) {
        return {};
    }
    // `Pressable` accepts a style callback, and the react-native stub forwards it
    // to the host node unresolved. Resolve it in the rest state so a control that
    // styles itself through the press state is still measurable here instead of
    // needing a second flattener per test file.
    if (typeof style === 'function') {
        return flattenTestStyle((style as (state: { pressed: boolean }) => unknown)({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => ({ ...accumulator, ...flattenTestStyle(entry) }),
            {},
        );
    }
    return style as Record<string, unknown>;
}

export function findNearestHostParent(
    instance: ReactTestInstance | null | undefined,
    hostType: string = 'View',
): ReactTestInstance | null {
    let node = instance?.parent;
    while (node && node.type !== hostType) {
        node = node.parent;
    }
    return node ?? null;
}

export function findAllByType(tree: TreeLike, type: string): ReactTestInstance[] {
    return resolveRoot(tree).findAll((node) => String(node.type) === type);
}

export function findFirstByType(tree: TreeLike, type: string): ReactTestInstance | null {
    return findAllByType(tree, type)[0] ?? null;
}

export function findPopoverContentView(
    tree: TreeLike,
    childType: string = 'PopoverChild',
): ReactTestInstance | null {
    const child = findFirstByType(tree, childType);
    return child ? findNearestHostParent(child) : null;
}

export function findHostNodesByTestId(tree: TreeLike, testID: string): ReactTestInstance[] {
    return resolveRoot(tree).findAll((node) => node.props?.testID === testID && typeof node.type === 'string');
}

export function findFirstHostNodeByTestId(tree: TreeLike, testID: string): ReactTestInstance | null {
    return findHostNodesByTestId(tree, testID)[0] ?? null;
}

/** Report the native layout event that Test Renderer cannot produce for portal content. */
export function reportPopoverContentLayout(tree: TreeLike, size: Readonly<{ width: number; height: number }>): void {
    const portals = resolveRoot(tree).findAll(node => typeof node.type === 'string'
        && typeof node.props.nativeID === 'string' && node.props.nativeID.startsWith('popover-')
        && typeof node.props.onLayout === 'function');
    for (const portal of portals) portal.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...size } } });
}

export function withPopoverWebGlobals(options?: PopoverWebGlobalsOptions): () => void;
export function withPopoverWebGlobals<TResult>(
    run: () => TResult | Promise<TResult>,
    options?: PopoverWebGlobalsOptions,
): Promise<TResult>;
export function withPopoverWebGlobals<TResult>(
    runOrOptions?: (() => TResult | Promise<TResult>) | PopoverWebGlobalsOptions,
    maybeOptions?: PopoverWebGlobalsOptions,
): Promise<TResult> | (() => void) {
    if (typeof runOrOptions !== 'function') {
        return installPopoverWebGlobals(runOrOptions);
    }

    const restore = installPopoverWebGlobals(maybeOptions);
    return (async () => {
        try {
            return await runOrOptions();
        } finally {
            restore();
        }
    })();
}
