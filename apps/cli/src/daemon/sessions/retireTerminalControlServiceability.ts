import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';

import { clearTerminalControlServiceabilityProjection } from '../startup/terminalControlServiceabilityProjection';

export async function retireExactTerminalControlServiceability(params: Readonly<{
    credentials: Credentials;
    sessionId: string;
    attachmentId: string;
    terminalMode: TerminalMode;
}>): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId: params.sessionId,
    });
    if (!rawSession) {
        throw new Error('terminal_control_serviceability_retirement_session_not_found');
    }
    await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession,
        updater: (metadata) => clearTerminalControlServiceabilityProjection({
            metadata,
            retiredAttachmentId: params.attachmentId,
            retiredAt: Date.now(),
            terminalMode: params.terminalMode,
        }),
    });
}
