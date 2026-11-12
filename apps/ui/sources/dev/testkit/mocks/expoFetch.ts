import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

/** Expo's native HTTP adapter delegates to the same external HTTP boundary as the client. */
export function createExpoFetchModuleMock(fetch: RuntimeFetch) {
    return { fetch };
}
