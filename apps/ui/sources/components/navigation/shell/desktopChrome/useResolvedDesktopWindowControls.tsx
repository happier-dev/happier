import * as React from 'react';
import {
    closeDesktopWindow,
    getDesktopWindowState,
    listenDesktopWindowState,
    minimizeDesktopWindow,
    toggleDesktopWindowMaximize,
} from '@/utils/platform/desktopWindowBridge';
import { useDesktopWindowChromePolicy } from '@/hooks/ui/useDesktopWindowChromePolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { DesktopWindowControlsButtons } from './DesktopWindowControlsButtons';
import { DesktopWindowControlsSlot } from './DesktopWindowControlsSlot';

type DesktopWindowControlsVariant = 'expanded' | 'collapsed';

type UseResolvedDesktopWindowControlsParams = Readonly<{
    variant: DesktopWindowControlsVariant;
    desktopWindowControls?: React.ReactNode;
    hasDesktopWindowControlsOverride?: boolean;
}>;

export function useResolvedDesktopWindowControls(
    params: UseResolvedDesktopWindowControlsParams,
): React.ReactNode {
    const hasDesktopWindowControlsOverride = params.hasDesktopWindowControlsOverride === true;
    const { strategy: chromeStrategy } = useDesktopWindowChromePolicy(!hasDesktopWindowControlsOverride);
    const [isMaximized, setIsMaximized] = React.useState(false);

    React.useEffect(() => {
        if (hasDesktopWindowControlsOverride) {
            setIsMaximized(false);
            return;
        }

        let isActive = true;
        let disposeWindowStateListener: (() => Promise<void>) | null = null;

        const loadWindowChrome = async () => {
            if (!isActive) {
                return;
            }

            if (chromeStrategy !== 'custom-controls') {
                setIsMaximized(false);
                return;
            }

            const state = await getDesktopWindowState();
            if (!isActive) {
                return;
            }

            setIsMaximized(state.isMaximized);
            const dispose = await listenDesktopWindowState((nextState) => {
                if (isActive) {
                    setIsMaximized(nextState.isMaximized);
                }
            });
            if (isActive) disposeWindowStateListener = dispose;
            else void dispose();
        };

        void loadWindowChrome();

        return () => {
            isActive = false;
            if (disposeWindowStateListener) {
                void disposeWindowStateListener();
            }
        };
    }, [chromeStrategy, hasDesktopWindowControlsOverride]);

    const handleMinimize = React.useCallback(() => {
        fireAndForget(minimizeDesktopWindow(), { tag: 'DesktopWindowControlsSlot.minimize' });
    }, []);

    const handleToggleMaximize = React.useCallback(() => {
        fireAndForget(toggleDesktopWindowMaximize(), { tag: 'DesktopWindowControlsSlot.toggleMaximize' });
    }, []);

    const handleClose = React.useCallback(() => {
        fireAndForget(closeDesktopWindow(), { tag: 'DesktopWindowControlsSlot.close' });
    }, []);

    if (hasDesktopWindowControlsOverride) {
        return params.desktopWindowControls ?? null;
    }

    if (chromeStrategy === 'none' || chromeStrategy === 'native-windows-frame') {
        return null;
    }

    return (
        <DesktopWindowControlsSlot enableDragging>
            {chromeStrategy === 'custom-controls' ? (
                <DesktopWindowControlsButtons
                    layout={params.variant === 'collapsed' ? 'column' : 'row'}
                    isMaximized={isMaximized}
                    onMinimize={handleMinimize}
                    onToggleMaximize={handleToggleMaximize}
                    onClose={handleClose}
                />
            ) : null}
        </DesktopWindowControlsSlot>
    );
}
