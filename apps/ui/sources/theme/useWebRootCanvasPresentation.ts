import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { isDesktopOverlayWindowContext } from '@/desktop/window/isDesktopOverlayWindowContext';

/** One mounted owner paints the web canvas and restores its pre-mount inline presentation. */
export function applyWebRootCanvasPresentation(document: Document, background: string): () => void {
    const previous: Array<Readonly<{ node: HTMLElement; background: string; priority: string }>> = [];
    for (const node of [document.documentElement, document.body, document.getElementById('root')]) {
        if (!node) continue;
        previous.push({ node, background: node.style.getPropertyValue('background-color'), priority: node.style.getPropertyPriority('background-color') });
        node.style.setProperty('background-color', background);
    }
    return () => {
        for (const { node, background, priority } of previous) {
            if (background) node.style.setProperty('background-color', background, priority);
            else node.style.removeProperty('background-color');
        }
    };
}

/** Material owners resolve transparency; this subscriber follows only the resulting canvas paint. */
export function useWebRootCanvasPresentation(transparent: boolean): void {
    const { theme } = useUnistyles();
    const background = transparent ? 'transparent' : theme.colors.background.canvas;
    const overlay = isDesktopOverlayWindowContext();
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || overlay || typeof document === 'undefined') return;
        return applyWebRootCanvasPresentation(document, background);
    }, [background, overlay]);
}
