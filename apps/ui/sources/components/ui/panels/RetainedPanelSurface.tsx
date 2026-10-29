import * as React from 'react';
import { Platform, View } from 'react-native';
import { Freeze } from 'react-freeze';
import { StyleSheet } from 'react-native-unistyles';

import { PluginSurfaceFocusEligibilityProvider, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/**
 * `flow` fills the height its host gives it (a pane). `content` takes its own content's height, for a surface that sits
 * in a page's scroll with other blocks after it (a page's tab body and the block that closes it).
 */
type RetainedPanelSurfaceMode = 'absolute-overlay' | 'flow' | 'content';

const WebInertView = View as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>
>;

const RETAINED_SCROLL_ROOT = 'data-retained-panel-surface';

/** Hidden DOM moves can reset native scroll offsets without a scroll event. Keep only presented view state. */
function useRetainedWebScroll(active: boolean, isWeb: boolean) {
    const presented = useLayoutPresentationActive() && active;
    const rootRef = React.useRef<HTMLElement | null>(null);
    const positions = React.useRef(new Map<HTMLElement, Readonly<{ top: number; left: number }>>());
    const attach = React.useCallback((node: React.ComponentRef<typeof View> | null) => {
        if (!isWeb || typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) {
            rootRef.current = null;
            return;
        }
        node.setAttribute(RETAINED_SCROLL_ROOT, '');
        rootRef.current = node;
    }, [isWeb]);

    React.useLayoutEffect(() => {
        const root = rootRef.current;
        if (!isWeb || !root) return;
        const owns = (node: HTMLElement) => root.contains(node) && node.closest(`[${RETAINED_SCROLL_ROOT}]`) === root;
        const prune = () => {
            for (const node of positions.current.keys()) {
                if (!owns(node)) positions.current.delete(node);
            }
        };
        prune();
        if (!presented) return;
        const pending = new Map(positions.current);
        let observer: ResizeObserver | undefined;
        const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
        const cancelPending = (event: Event) => {
            if (!(event.target instanceof Node)) return;
            for (const node of pending.keys()) {
                if (!node.contains(event.target)) continue;
                positions.current.set(node, { top: node.scrollTop, left: node.scrollLeft });
                pending.delete(node);
            }
            if (pending.size === 0) stopRestoring();
        };
        const stopRestoring = () => {
            observer?.disconnect();
            for (const type of inputEvents) root.removeEventListener(type, cancelPending, true);
        };
        const restore = () => {
            for (const [node, position] of pending) {
                if (!node.isConnected || !owns(node)) {
                    pending.delete(node);
                    positions.current.delete(node);
                    continue;
                }
                node.scrollTop = position.top;
                node.scrollLeft = position.left;
                if (node.scrollTop === position.top && node.scrollLeft === position.left) pending.delete(node);
            }
            if (pending.size === 0) stopRestoring();
        };
        restore();
        // Revealing a retained page can precede its final viewport/content measurement. A browser
        // clamp is not reader movement: retry only on geometry changes, until reachable or new input.
        if (pending.size > 0 && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(restore);
            for (const node of pending.keys()) {
                observer.observe(node);
                for (const child of Array.from(node.children)) observer.observe(child);
            }
            for (const type of inputEvents) root.addEventListener(type, cancelPending, { capture: true, passive: true });
        } else {
            pending.clear();
        }
        const capture = (event: Event) => {
            const node = event.target;
            if (!(node instanceof HTMLElement) || !owns(node) || pending.has(node)) return;
            // Established scrollers stay O(1); new admission also releases removed descendants.
            if (!positions.current.has(node)) prune();
            positions.current.set(node, { top: node.scrollTop, left: node.scrollLeft });
        };
        root.addEventListener('scroll', capture, true);
        return () => {
            root.removeEventListener('scroll', capture, true);
            stopRestoring();
        };
    }, [isWeb, presented]);

    return attach;
}

export const RetainedPanelSurface = React.memo((props: Readonly<{
    isActive: boolean;
    testID?: string;
    mode?: RetainedPanelSurfaceMode;
    /** Opt in only for bodies proven safe to suspend, including their layout-effect lifetimes. */
    suspendWhenHidden?: boolean;
    /** Activity withdraws effects while preserving previously presented local state. */
    hiddenMode?: 'activity';
    children: React.ReactNode;
}>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);
    const [frozen, setFrozen] = React.useState(!active);
    const mode = props.mode ?? 'flow';
    const isWeb = Platform.OS === 'web';
    const attachScrollRoot = useRetainedWebScroll(active, isWeb);

    React.useLayoutEffect(() => {
        if (active) {
            setHasMounted(true);
        }
    }, [active]);

    // Commit presentation=false once so demand/focus owners withdraw before suspending renders.
    // Freeze preserves passive effects but disconnects layout effects. Generic
    // retained content (including external plugin renderers) must stay connected.
    React.useEffect(() => {
        setFrozen(!active);
    }, [active]);

    if (!active && !hasMounted) {
        return null;
    }

    const content = (
        <PluginSurfaceFocusEligibilityProvider active={active}>
            <React.Activity mode={props.hiddenMode === 'activity' && !active ? 'hidden' : 'visible'}>
                <Freeze freeze={props.hiddenMode !== 'activity' && props.suspendWhenHidden === true && !active && frozen}>{props.children}</Freeze>
            </React.Activity>
        </PluginSurfaceFocusEligibilityProvider>
    );

    if (mode === 'absolute-overlay') {
        return (
            <WebInertView
                ref={attachScrollRoot}
                testID={props.testID}
                pointerEvents={active ? 'auto' : 'none'}
                inert={isWeb && !active ? true : undefined}
                aria-hidden={isWeb && !active ? true : undefined}
                accessibilityElementsHidden={isWeb ? undefined : !active}
                importantForAccessibility={isWeb ? undefined : active ? 'auto' : 'no-hide-descendants'}
                style={[
                    StyleSheet.absoluteFillObject,
                    {
                        opacity: active ? 1 : 0,
                        display: isWeb ? (active ? 'flex' : 'none') : 'flex',
                    },
                ]}
            >
                {content}
            </WebInertView>
        );
    }

    return (
        <WebInertView
            ref={attachScrollRoot}
            testID={props.testID}
            pointerEvents={active ? 'auto' : 'none'}
            inert={isWeb && !active ? true : undefined}
            aria-hidden={isWeb && !active ? true : undefined}
            accessibilityElementsHidden={isWeb ? undefined : !active}
            importantForAccessibility={isWeb ? undefined : active ? 'auto' : 'no-hide-descendants'}
            style={[
                mode === 'content' ? { minWidth: 0 } : { flex: 1, minHeight: 0, minWidth: 0 },
                !active ? { display: 'none' } : null,
            ]}
        >
            {content}
        </WebInertView>
    );
});
