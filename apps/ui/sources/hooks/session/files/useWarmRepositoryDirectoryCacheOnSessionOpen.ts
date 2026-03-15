import * as React from 'react';
import { Platform } from 'react-native';

import { warmRepositoryDirectoryCache } from '@/sync/domains/input/repositoryDirectory';
import { useSetting } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useWarmRepositoryDirectoryCacheOnSessionOpen(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    machineOnline: boolean;
}>) {
    const enabledSetting = useSetting('filesRepositoryTreeWarmCacheEnabled');
    const enabled = enabledSetting === true;

    const sessionKey = `${input.sessionId}:${input.sessionPath ?? ''}`;
    const didWarmRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!enabled) return;
        if (Platform.OS !== 'web') return;
        if (!input.sessionId) return;
        if (!input.sessionPath) return;
        if (!input.machineOnline) return;
        if (didWarmRef.current === sessionKey) return;
        didWarmRef.current = sessionKey;

        fireAndForget(
            warmRepositoryDirectoryCache({ sessionId: input.sessionId, directoryPath: '' }),
            { tag: 'useWarmRepositoryDirectoryCacheOnSessionOpen.warmRoot' }
        );
    }, [enabled, input.machineOnline, input.sessionId, input.sessionPath, sessionKey]);
}
