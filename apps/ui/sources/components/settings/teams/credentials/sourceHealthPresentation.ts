import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

import { t } from '@/text';

/** Present a confirmed source fact; absence or upstream prose is not authentication evidence. */
export function teamCredentialReconnectPresentation(code: unknown, sourceOwnerDisplayName?: string | null) {
    if (code !== CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired) return null;
    const title = t('connectedServices.diagnostics.title.connected_service_credential_reconnect_required');
    const handoff = [t('teams.credentials.recovery.ownerHandoff'), sourceOwnerDisplayName?.trim()]
        .filter(Boolean).join(' · ');
    return { title, message: [title, handoff].join('. ') };
}
