import * as React from 'react';

import type { PetCompanionTrayItem } from '@/components/pets/activity';
import {
    showMainWindowFromDesktopPetOverlay,
} from '@/components/pets/desktop/bridge/desktopPetOverlayBridge';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';

import {
    openDesktopPetOverlayTrayItem,
    sendDesktopPetOverlayQuickReply,
    tuckDesktopPetOverlay,
} from './desktopPetOverlayActions';

export function useDesktopPetOverlayActions(): Readonly<{
    openTrayItem: (item: PetCompanionTrayItem) => Promise<void>;
    quickReply: (item: PetCompanionTrayItem, message: string) => Promise<void>;
    tuck: () => void;
}> {
    const applyLocalSettings = useApplyLocalSettings();
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);

    const openTrayItem = React.useCallback(async (item: PetCompanionTrayItem) => {
        await openDesktopPetOverlayTrayItem({
            item,
            executor,
            showMainWindow: showMainWindowFromDesktopPetOverlay,
        });
    }, [executor]);

    const quickReply = React.useCallback(async (item: PetCompanionTrayItem, message: string) => {
        await sendDesktopPetOverlayQuickReply({ item, message, executor });
    }, [executor]);

    const tuck = React.useCallback(() => {
        tuckDesktopPetOverlay({ applyLocalSettings });
    }, [applyLocalSettings]);

    return { openTrayItem, quickReply, tuck };
}
