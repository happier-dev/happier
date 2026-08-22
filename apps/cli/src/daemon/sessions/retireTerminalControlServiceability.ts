import type { StoredCredentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';

import { clearTerminalControlServiceabilityProjection } from '../startup/terminalControlServiceabilityProjection';

export type ExactTerminalControlServiceabilityRetirement = 'retired' | 'superseded';

export function requireExactTerminalControlServiceabilityRetirement(
    result: ExactTerminalControlServiceabilityRetirement | void,
): void {
    if (result === 'superseded') {
        throw new Error('terminal_control_serviceability_retirement_superseded');
    }
}

export async function retireExactTerminalControlServiceability(params: Readonly<{
    credentials: StoredCredentials;
    sessionId: string;
    attachmentId: string;
    terminalMode: TerminalMode;
}>): Promise<ExactTerminalControlServiceabilityRetirement> {
    const rawSession = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId: params.sessionId,
    });
    if (!rawSession) {
        throw new Error('terminal_control_serviceability_retirement_session_not_found');
    }
    const updated = await updateSessionMetadataWithRetry({
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
    const terminal = updated.metadata.terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return 'superseded';
    const serviceability = (terminal as Record<string, unknown>).controlServiceabilityV1;
    if (!serviceability || typeof serviceability !== 'object' || Array.isArray(serviceability)) return 'superseded';
    const projection = serviceability as Record<string, unknown>;
    return projection.attachmentId === params.attachmentId && projection.retired === true
        ? 'retired'
        : 'superseded';
}
