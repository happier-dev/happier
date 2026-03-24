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

function restoreGlobal(name: 'requestAnimationFrame' | 'window', previousValue: unknown, hadOwnValue: boolean) {
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
    const previousWindow = (globalThis as Record<string, unknown>).window;
    const previousRequestAnimationFrame = (globalThis as Record<string, unknown>).requestAnimationFrame;

    (globalThis as Record<string, unknown>).window = options.window ?? {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    (globalThis as Record<string, unknown>).requestAnimationFrame = options.frameScheduler
        ?? options.requestAnimationFrame
        ?? ((callback: FrameRequestCallback) => {
            callback(0);
            return 0;
        });

    return () => {
        restoreGlobal('window', previousWindow, hadWindow);
        restoreGlobal('requestAnimationFrame', previousRequestAnimationFrame, hadRequestAnimationFrame);
    };
}

export function flattenTestStyle(style: unknown): Record<string, unknown> {
    if (!style) {
        return {};
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
    return Promise.resolve(runOrOptions()).finally(() => {
        restore();
    });
}
