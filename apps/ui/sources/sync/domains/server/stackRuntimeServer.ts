import { readWebRuntimeConfigServerUrl } from '@/sync/runtime/webRuntimeConfig';

import { isStackContext } from './serverContext';
import { upsertAndActivateServer } from './serverRuntime';

export function readStackRuntimeServerUrl(): string | null {
    if (!isStackContext()) {
        return null;
    }
    const serverUrl = readWebRuntimeConfigServerUrl().trim();
    return serverUrl || null;
}

export function activateStackRuntimeServer(params?: Readonly<{ scope?: 'device' | 'tab' }>) {
    const serverUrl = readStackRuntimeServerUrl();
    if (!serverUrl) {
        return null;
    }
    return upsertAndActivateServer({
        serverUrl,
        source: 'stack-env',
        scope: params?.scope ?? 'device',
    });
}
