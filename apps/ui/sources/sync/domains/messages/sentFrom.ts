import { Platform } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';

import type { SentFrom } from '@happier-dev/protocol';

export function resolveSentFromForEnvironment(params: { platformOs: string; runningOnMac: boolean }): SentFrom {
    const { platformOs, runningOnMac } = params;
    if (platformOs === 'web') return 'web';
    if (platformOs === 'android') return 'android';
    if (platformOs === 'ios') return runningOnMac ? 'mac' : 'ios';
    return 'web';
}

export function resolveSentFrom(): SentFrom {
    return resolveSentFromForEnvironment({ platformOs: Platform.OS, runningOnMac: isRunningOnMac() });
}
