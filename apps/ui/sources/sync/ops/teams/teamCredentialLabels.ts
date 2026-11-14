/**
 * The persisted credential resource owns the human-readable label identity.
 * Every catalog, preview, editor and audit reader binds to this resource, never
 * to a transient presentation or audit event.
 */
export function teamCredentialDisplayNameBinding(resourceId: string) {
    return {
        entity: 'team_credential_resource' as const,
        field: 'displayName' as const,
        id: resourceId,
    };
}

/** External API-key labels are separate persisted resources from their parent credential. */
export function teamCredentialExternalApiKeyLabelBinding(keyId: string) {
    return {
        entity: 'team_credential_external_api_key' as const,
        field: 'label' as const,
        id: keyId,
    };
}
