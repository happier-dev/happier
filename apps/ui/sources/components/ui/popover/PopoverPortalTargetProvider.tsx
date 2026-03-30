import * as React from 'react';
import { Platform, View } from 'react-native';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import { OverlayPortalHost, OverlayPortalProvider } from './OverlayPortal';
import { PopoverPortalTargetContextProvider } from './PopoverPortalTarget';

/**
 * Creates a screen-local portal host for native popovers/dropdowns.
 *
 * Why this exists:
 * - On iOS, screens presented as `containedModal` / sheet-like presentations can live in a
 *   different native coordinate space than the app root.
 * - If popovers portal to an app-root host, anchor measurements and overlay positioning can
 *   mismatch (menus appear vertically offset).
 *
 * By scoping an `OverlayPortalProvider` + `OverlayPortalHost` to the current screen subtree,
 * popovers render in the same coordinate space as their anchors.
 */
export function PopoverPortalTargetProvider(props: { children: React.ReactNode }) {
    if (Platform.OS === 'web') {
        const [webPortalTarget, setWebPortalTarget] = React.useState<HTMLElement | null>(null);
        const anchorRef = React.useRef<HTMLElement | null>(null);

        React.useLayoutEffect(() => {
            if (typeof document === 'undefined') return;

            const resolveDialogContentTarget = (): HTMLElement | null => {
                const anchor = anchorRef.current;
                if (anchor && typeof (anchor as any).closest === 'function') {
                    const dialogContent = anchor.closest('[data-radix-dialog-content]') as HTMLElement | null;
                    if (dialogContent) return dialogContent;
                }

                // Fallback: if we are inside a Radix dialog, prefer the most recently-mounted dialog content.
                // This keeps popovers within the active modal focus/pointer scope (instead of `document.body`).
                const all = Array.from(document.querySelectorAll('[data-radix-dialog-content]')) as HTMLElement[];
                return all.length > 0 ? all[all.length - 1] : null;
            };

            const resolveHostContainer = (): HTMLElement | null => {
                const anchor = anchorRef.current;
                const dialogContent = resolveDialogContentTarget();

                if (!anchor || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
                    return dialogContent ?? document.body;
                }

                // Find the closest ancestor that clips overflow (common in sheet-like modal cards),
                // then mount the portal host just outside the *outermost* clipping ancestor while
                // staying within the dialog subtree. (Many modal cards have multiple nested
                // overflow:auto/hidden wrappers.)
                let node: HTMLElement | null = anchor;
                const stopAt = dialogContent ?? document.body;
                let outermostClip: HTMLElement | null = null;
                while (node && node !== stopAt && node !== document.body) {
                    try {
                        const style = window.getComputedStyle(node);
                        const overflow = style.overflow;
                        const overflowX = style.overflowX;
                        const overflowY = style.overflowY;
                        const clips =
                            (overflow && overflow !== 'visible')
                            || (overflowX && overflowX !== 'visible')
                            || (overflowY && overflowY !== 'visible');
                        if (clips) {
                            outermostClip = node;
                        }
                    } catch {
                        // Ignore style access failures and keep walking.
                    }
                    node = node.parentElement;
                }

                if (outermostClip) {
                    const parent = outermostClip.parentElement;
                    if (parent) {
                        if (dialogContent && dialogContent.contains(parent)) return parent;
                        return dialogContent ?? parent;
                    }
                }

                return dialogContent ?? document.body;
            };

            const container = resolveHostContainer();
            const host = document.createElement('div');
            host.setAttribute('data-happy-popover-portal-host', '');
            Object.assign(host.style, {
                position: 'absolute',
                top: '0px',
                left: '0px',
                width: '0px',
                height: '0px',
                overflow: 'visible',
                pointerEvents: 'none',
            } satisfies Partial<CSSStyleDeclaration>);

            try {
                (container ?? document.body).appendChild(host);
            } catch {
                // If we can't append (should be extremely rare), fall back to body.
                try {
                    document.body.appendChild(host);
                } catch {
                    // give up
                }
            }

            setWebPortalTarget(host);
            return () => {
                setWebPortalTarget(null);
                try {
                    host.remove();
                } catch {
                    // ignore
                }
            };
        }, []);

        return (
            <ModalPortalTargetProvider target={webPortalTarget}>
                <View style={{ flex: 1 }} pointerEvents="box-none">
                    {props.children}
                    <div
                        data-happy-popover-portal-anchor=""
                        ref={(node) => {
                            anchorRef.current = node;
                        }}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: 0,
                            height: 0,
                            overflow: 'hidden',
                            pointerEvents: 'none',
                        }}
                    />
                </View>
            </ModalPortalTargetProvider>
        );
    }

    const rootRef = React.useRef<any>(null);
    const [layout, setLayout] = React.useState(() => ({ width: 0, height: 0 }));
    const portalTarget = React.useMemo(() => ({ rootRef, layout }), [layout]);

    return (
        <PopoverPortalTargetContextProvider value={portalTarget}>
            <OverlayPortalProvider>
                <View
                    ref={rootRef}
                    // Required on native: Popover measures the portal root to derive anchor-relative coordinates.
                    // Collapsable views can be optimized away, producing invalid measurements (e.g. y=0 in contained modals).
                    collapsable={false}
                    style={{ flex: 1 }}
                    pointerEvents="box-none"
                    onLayout={(e) => {
                        const next = e?.nativeEvent?.layout;
                        if (!next) return;
                        setLayout((prev) => {
                            if (prev.width === next.width && prev.height === next.height) return prev;
                            return { width: next.width, height: next.height };
                        });
                    }}
                >
                    {props.children}
                    <OverlayPortalHost />
                </View>
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>
    );
}
