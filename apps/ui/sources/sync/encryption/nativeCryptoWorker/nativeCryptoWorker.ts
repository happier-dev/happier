import { Platform } from 'react-native';

import { createNativeCryptoWorker as createNativeCryptoWorkerNative } from './nativeCryptoWorker.native';
import { createNativeCryptoWorker as createNativeCryptoWorkerWeb } from './nativeCryptoWorker.web';
import type { NativeCryptoWorker } from './types';

export function createNativeCryptoWorker(): NativeCryptoWorker {
    return Platform.OS === 'web'
        ? createNativeCryptoWorkerWeb()
        : createNativeCryptoWorkerNative();
}
