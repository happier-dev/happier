import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionAppearance as setSessionAppearanceApi } from '@/sync/api/session/sessionOrganizationApi';
import { parseSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import { openSessionOrganizationSessionAppearanceDisplay, prepareSessionOrganizationDisplayEnvelopeForWrite } from './sessionOrganizationDisplayEnvelope';

/** Personal display overrides share the organization optimistic owner and captured Account transport. */
export async function setSessionAppearance(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    sessionId: string;
    color: SessionAppearanceColor | null;
}>): Promise<void> {
    params.assertCurrent?.();
    const color = parseSessionAppearanceColor(params.color);
    if (params.color !== null && !color) throw new Error('invalid-session-appearance');
    const appearance = color ? {
        sessionId: params.sessionId,
        display: { t: 'plain' as const, v: { color } },
        displayState: { status: 'available' as const, value: { color } },
        updatedAt: Date.now(),
    } : null;
    const recordId = sessionOrganizationStoreFor(params).setSessionAppearanceOptimistic(params.serverId, params.sessionId, appearance);
    try {
        const display = await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            request: params.requestAtEndpoint,
            envelope: appearance?.display,
        });
        params.assertCurrent?.();
        const response = await setSessionAppearanceApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            sessionId: params.sessionId,
            request: { display },
        });
        const confirmedAppearance = response.appearance
            ? await openSessionOrganizationSessionAppearanceDisplay({ credentials: params.credentials, appearance: response.appearance })
            : null;
        params.assertCurrent?.();
        sessionOrganizationStoreFor(params).confirmSessionOrganizationOptimistic(recordId,
            'sessionOrganizationAppearancesBySessionKey',
            buildSessionOrganizationSessionKey(params.serverId, params.sessionId), confirmedAppearance);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
