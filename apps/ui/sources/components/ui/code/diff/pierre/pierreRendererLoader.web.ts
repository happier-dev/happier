import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useSetting } from '@/sync/store/settingsReadHooks';
import { useEffectiveDiffPresentation } from '../diffPresentationStyle';
import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierreRuntimeSupport.web';

type PierreRendererModule = typeof import('./PierreDiffViewer.web');

let loadedPierreRenderer: PierreRendererModule | null = null;

/** The one loader of the Pierre renderer chunk: `DiffViewer`'s lazy body and the list preload share it. */
export function loadPierreRenderer(): Promise<PierreRendererModule> {
    return import('./PierreDiffViewer.web').then((renderer) => {
        loadedPierreRenderer = renderer;
        return renderer;
    });
}

export function getLoadedPierreRenderer(): PierreRendererModule | null {
    return loadedPierreRenderer;
}

/**
 * A list that will draw inline diffs prepares the Pierre renderer (its chunk and worker pool) while its
 * rows and their diffs load. Without it, the first bodies draw every line through the Happier renderer
 * twice (chunk loading, then worker initializing) before Pierre replaces them.
 */
export function usePierreDiffRendererPreload(enabled: boolean): void {
    const rendererMode = useSetting('filesDiffRendererMode');
    const style = useEffectiveDiffPresentation().style;
    const { theme } = useUnistyles();
    const active = enabled && rendererMode === 'pierre' && isPierreDiffKillSwitchEnabled() && supportsPierreRuntime();
    React.useEffect(() => {
        if (!active) return;
        let current = true;
        // A failed load is the body's to report: RetryableLazy surfaces it where a body loads the renderer.
        loadPierreRenderer().then((renderer) => {
            if (current) renderer.preparePierreDiffRenderer({ style, isDark: theme.dark === true, colors: theme.colors });
        }, () => {});
        return () => { current = false; };
    }, [active, style, theme]);
}
