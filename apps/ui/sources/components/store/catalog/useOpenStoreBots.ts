import * as React from 'react';
import { useOpenAppSection } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';

/** The popover and Agent invoke the same mounted, opaque current-context command. */
export function useOpenStoreBots(onOpened: () => void): () => Promise<boolean> {
    // Store › Bots is a Store page: it opens as that section (the Store's sidebar), wherever it is opened from.
    const openSection = useOpenAppSection();
    const commands = useCurrentUiContextLocalCommands([{ key: 'store.bots', title: t('botTemplates.fromTemplate'),
        invoke: () => { openSection('/plugins/bots'); onOpened(); } }], { foregroundOverlay: true });
    return React.useCallback(() => commands.invoke('store.bots'), [commands.invoke]);
}
