import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

import { t } from '@/text';

/** Present a confirmed source fact; absence or upstream prose is not authentication evidence. */
export function teamCredentialReconnectPresentation(code: unknown, sourceOwnerDisplayName?: string | null) {
    if (code !== CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired) return null;
    const title = t('connectedServices.diagnostics.title.connected_service_credential_reconnect_required');
    return { title, message: [title, teamCredentialOwnerHandoffLabel(sourceOwnerDisplayName)].join('. ') };
}

/** "Ask <owner> …" when the projection names the source owner, otherwise the person who shared it. */
export function teamCredentialOwnerHandoffLabel(sourceOwnerDisplayName?: string | null): string {
    const name = sourceOwnerDisplayName?.trim();
    return name
        ? t('teams.credentials.recovery.ownerHandoffNamed', { name })
        : t('teams.credentials.recovery.ownerHandoff');
}
