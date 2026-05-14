import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { createOpenCodeDirectClient } from './createOpenCodeDirectClient';

export async function getOpenCodeExternalSessionWorkingDirectory(params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
}>): Promise<string | null> {
    const verified = await getOpenCodeExternalSessionVerifiedWorkingDirectory(params);
    if (verified) return verified;

    if (params.source.kind === 'opencodeServer') {
        const fromSource = typeof params.source.directory === 'string' ? params.source.directory.trim() : '';
        if (fromSource.length > 0) return fromSource;
    }

    return null;
}

export async function getOpenCodeExternalSessionVerifiedWorkingDirectory(params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
}>): Promise<string | null> {
    const client = await createOpenCodeDirectClient(params.source);
    try {
        const session = await client.sessionGet({ sessionId: params.remoteSessionId });
        const directory =
            session && typeof session === 'object' && !Array.isArray(session) && typeof (session as any).directory === 'string'
                ? String((session as any).directory).trim()
                : '';
        return directory.length > 0 ? directory : null;
    } catch {
        return null;
    } finally {
        await client.dispose().catch(() => {});
    }
}
