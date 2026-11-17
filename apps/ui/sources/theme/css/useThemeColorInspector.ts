import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { SurfaceAddress, ThemeSurfacePaintDescriptor } from '@happier-dev/plugin-sdk/ui';
import { beginThemeSurfaceInspection } from '@happier-dev/plugin-ui/presentation';
import { measureWindowBounds } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';

export type ThemeInspectionTarget = ThemeSurfacePaintDescriptor & Readonly<{
    rect: Readonly<{ x: number; y: number; width: number; height: number }>;
    host: unknown;
}>;
export type ThemeInspectionContext = Readonly<{
    paintMap: readonly ThemeSurfacePaintDescriptor[] | (() => readonly ThemeSurfacePaintDescriptor[]);
    onPick: (target: ThemeInspectionTarget) => void;
    onCancel?: () => void;
    excludeElement?: (element: Element) => boolean;
}>;
export type ThemeInspectorPresentation = Readonly<{
    available: boolean;
    active: boolean;
    target: ThemeInspectionTarget | null;
    activate: () => void;
    cancel: () => void;
    pick: () => void;
}>;

/** Active interaction only; the paint map remains the sole semantic authority. */
export function useThemeColorInspector(input: ThemeInspectionContext): ThemeInspectorPresentation {
    const latest = useRef(input);
    latest.current = input;
    const [active, setActive] = useState(false);
    const [target, setTarget] = useState<ThemeInspectionTarget | null>(null);
    const targetRef = useRef<ThemeInspectionTarget | null>(null);
    const captureActive = useRef(false);
    const paintMapCache = useRef<Readonly<{ source: ThemeInspectionContext['paintMap']; value: readonly ThemeSurfacePaintDescriptor[] }> | null>(null);
    const readPaintMap = useCallback(() => {
        const source = latest.current.paintMap;
        if (paintMapCache.current?.source !== source) {
            paintMapCache.current = { source, value: typeof source === 'function' ? source() : source };
        }
        return paintMapCache.current.value;
    }, []);
    const publish = useCallback((next: ThemeInspectionTarget | null) => {
        const previous = targetRef.current;
        if (previous === next || (previous && next && previous.host === next.host
            && previous.address === next.address && previous.label === next.label
            && previous.paintRoles === next.paintRoles && previous.rect.x === next.rect.x
            && previous.rect.y === next.rect.y && previous.rect.width === next.rect.width
            && previous.rect.height === next.rect.height)) return;
        targetRef.current = next;
        setTarget(next);
    }, []);
    const activate = useCallback(() => { captureActive.current = true; setActive(true); }, []);
    const cancel = useCallback(() => {
        captureActive.current = false;
        setActive(false);
        publish(null);
        latest.current.onCancel?.();
    }, [publish]);
    const pick = useCallback(() => {
        if (captureActive.current && targetRef.current) latest.current.onPick(targetRef.current);
    }, []);
    useEffect(() => {
        if (!active) return;
        let mounted = true;
        const descriptorFor = (address: SurfaceAddress) => readPaintMap().find(entry =>
            entry.address.surface === address.surface && entry.address.part === address.part
            && (entry.address.state ?? 'default') === (address.state ?? 'default'));
        if (Platform.OS !== 'web') {
            const release = beginThemeSurfaceInspection((address, host) => {
                const descriptor = descriptorFor(address);
                if (!descriptor) { publish(null); return; }
                void measureWindowBounds(host).then(rect => {
                    if (!mounted || !captureActive.current || !rect) return;
                    const next = { ...descriptor, rect, host };
                    publish(next);
                    latest.current.onPick(next);
                });
            });
            return () => { mounted = false; captureActive.current = false; release(); };
        }
        const resolve = (event: MouseEvent): ThemeInspectionTarget | null => {
            const atPoint = document.elementFromPoint?.(event.clientX, event.clientY);
            const element = atPoint ?? (event.target instanceof Element ? event.target : null);
            if (!element) return null;
            // Each painted part emits all three fields. Never borrow a part or
            // state from an ancestor, or fall through unknown literal paint.
            const host = element.closest<HTMLElement>('[data-surface][data-part][data-state]');
            if (!host) return null;
            const descriptor = readPaintMap().find(entry =>
                entry.address.surface === host.dataset.surface && entry.address.part === host.dataset.part
                && (entry.address.state ?? 'default') === host.dataset.state);
            if (!descriptor) return null;
            const { x, y, width, height } = host.getBoundingClientRect();
            return { ...descriptor, host, rect: { x, y, width, height } };
        };
        const excluded = (event: Event) => event.target instanceof Element
            && latest.current.excludeElement?.(event.target) === true;
        const move = (event: PointerEvent) => {
            if (captureActive.current && !excluded(event)) publish(resolve(event));
        };
        const capture = (event: MouseEvent) => {
            if (!captureActive.current || excluded(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const next = resolve(event);
            publish(next);
            if (event.type === 'click' && next) latest.current.onPick(next);
        };
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation(); cancel();
        };
        document.addEventListener('pointermove', move, true);
        const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'] as const;
        for (const event of events) document.addEventListener(event, capture, true);
        document.addEventListener('keydown', key, true);
        return () => {
            mounted = false;
            captureActive.current = false;
            document.removeEventListener('pointermove', move, true);
            for (const event of events) document.removeEventListener(event, capture, true);
            document.removeEventListener('keydown', key, true);
        };
    }, [active, cancel, publish, readPaintMap]);
    return { available: Platform.OS !== 'web' || typeof document !== 'undefined', active, target, activate, cancel, pick };
}
