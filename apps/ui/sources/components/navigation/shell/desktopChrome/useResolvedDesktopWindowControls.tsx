import * as React from 'react';
import {
    closeDesktopWindow,
    getDesktopWindowChromePolicy,
    getDesktopWindowState,
    listenDesktopWindowState,
    minimizeDesktopWindow,
    startDesktopWindowDragging,
    toggleDesktopWindowMaximize,
    type DesktopWindowChromeStrategy,
} from '@/utils/platform/desktopWindowBridge';
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
    const [chromeStrategy, setChromeStrategy] = React.useState<DesktopWindowChromeStrategy>('none');
    const [isMaximized, setIsMaximized] = React.useState(false);

    React.useEffect(() => {
        if (hasDesktopWindowControlsOverride) {
            setChromeStrategy('none');
            setIsMaximized(false);
            return;
        }

        let isActive = true;
        let disposeWindowStateListener: (() => Promise<void>) | null = null;

        const loadWindowChrome = async () => {
            const policy = await getDesktopWindowChromePolicy();
            if (!isActive) {
                return;
            }

            setChromeStrategy(policy.strategy);

            if (policy.strategy !== 'custom-controls') {
                setIsMaximized(false);
                return;
            }

            const state = await getDesktopWindowState();
            if (!isActive) {
                return;
            }

            setIsMaximized(state.isMaximized);
            disposeWindowStateListener = await listenDesktopWindowState((nextState) => {
                if (isActive) {
                    setIsMaximized(nextState.isMaximized);
                }
            });
        };

        void loadWindowChrome();

        return () => {
            isActive = false;
            if (disposeWindowStateListener) {
                void disposeWindowStateListener();
            }
        };
    }, [hasDesktopWindowControlsOverride]);

    const handleStartDragging = React.useCallback(() => {
        fireAndForget(startDesktopWindowDragging(), { tag: 'DesktopWindowControlsSlot.startDragging' });
    }, []);

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

    if (chromeStrategy === 'none') {
        return null;
    }

    return (
        <DesktopWindowControlsSlot enableDragging onStartDragging={handleStartDragging}>
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
