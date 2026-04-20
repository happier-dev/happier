import * as React from 'react';
import { Platform } from 'react-native';

export type SplitCanvasInputModality = 'pointer' | 'keyboard';

export function useSplitCanvasInputModality(enabled: boolean): SplitCanvasInputModality {
    const [modality, setModality] = React.useState<SplitCanvasInputModality>('pointer');

    React.useEffect(() => {
        if (!enabled || Platform.OS !== 'web') {
            return;
        }

        const maybeWindow: Window | undefined = (globalThis as { window?: Window }).window;
        if (!maybeWindow?.addEventListener) {
            return;
        }

        const onKeyDown = () => {
            setModality('keyboard');
        };

        const onPointerDown = () => {
            setModality('pointer');
        };

        maybeWindow.addEventListener('keydown', onKeyDown);
        maybeWindow.addEventListener('pointerdown', onPointerDown);
        maybeWindow.addEventListener('mousedown', onPointerDown);
        maybeWindow.addEventListener('touchstart', onPointerDown);

        return () => {
            maybeWindow.removeEventListener('keydown', onKeyDown);
            maybeWindow.removeEventListener('pointerdown', onPointerDown);
            maybeWindow.removeEventListener('mousedown', onPointerDown);
            maybeWindow.removeEventListener('touchstart', onPointerDown);
        };
    }, [enabled]);

    return modality;
}
