import * as React from 'react';

import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { accountStorageViewRoute } from '@/components/storage/account/storageViewRoute';
import { useModalContentId } from '@/modal/ModalProvider';

const STORAGE_ARTIFACTS_OPEN_COMMAND = 'storage.artifacts.open';

/** The figure and quota links open the same filtered view, including the notice inside a dialog. */
export function useOpenArtifactStorage(enabled: boolean, title: string, beforeOpen?: () => void): () => void {
    const router = useRouter();
    const modalId = useModalContentId();
    const openStorage = React.useCallback(() => {
        beforeOpen?.();
        router.push(accountStorageViewRoute('artifacts') as Href);
    }, [beforeOpen, router]);
    useCurrentUiContextLocalCommands(React.useMemo(() => enabled ? [{
        key: STORAGE_ARTIFACTS_OPEN_COMMAND,
        title,
        description: 'Open Account Storage filtered to Artifacts, largest first.',
        invoke: openStorage,
    }] : [], [enabled, openStorage, title]), { foregroundOverlay: modalId !== null });
    return openStorage;
}
