import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

// Closed, host-authored sites: never derive diagnostics from exception messages.
const refusalMessages = {
    gateway_execution_identity: "Managed gateway execution identity is unavailable",
    gateway_shared_custody: "Managed gateway shared custody is unavailable",
    retained_invocation_services: "Retained managed Provider invocation services are unavailable",
    retained_remote_authority: "Retained remote managed gateway authority changed",
    retained_hard_revocation: "Retained managed Provider authority was hard-revoked",
    retained_reauthorization: "Retained managed Provider authority could not be reauthorized",
    retained_public_outcome: "Retained managed Provider public outcome is unavailable",
    authorization_deployment: "Runner Provider authorization is not a managed-local binding",
    authorization_binding: "Runner managed Provider authorization is not current for this Session binding",
    runtime_invocation_services: "Managed Provider runtime invocation services are unavailable",
    initial_authority: "Managed Provider initial authority is unavailable",
    runtime_invocation_preparation: "Managed Provider runtime invocation authority could not be prepared",
    runtime_authority_changed: "Managed Provider runtime authority changed while preparing the Runner invocation",
    public_runtime_declaration: "Managed Provider public runtime declaration is unavailable",
    host_initial_currentness: "Runner managed Provider PluginServices authority is unavailable",
    host_invocation_currentness: "Runner managed Provider PluginServices authority is unavailable",
    host_started_currentness: "Runner managed Provider authority changed during start",
    host_before_materialization: "Runner managed Provider authority changed before Agent materialization",
    host_after_materialization: "Runner managed Provider authority changed during Agent materialization",
    host_shared_access_custody: "Shared Provider access is unavailable",
    host_shared_access_currentness: "Shared Provider authority changed during access",
} as const;

type RefusalSite = keyof typeof refusalMessages;

export function createManagedProviderAuthorityError(
    refusalSite: RefusalSite,
    options: Pick<ConstructorParameters<typeof PluginError>[0], 'failureCause'> = {},
): PluginError {
    return new PluginError({
        code: 'plugin_services_managed_provider_authority_unavailable',
        message: refusalMessages[refusalSite],
        ...options,
        details: { refusalSite },
    });
}

/** Private file diagnostic only; no source messages or caller-owned detail fields. */
export function readManagedProviderAuthorityRefusalSite(error: unknown): { refusalSite?: RefusalSite } {
    if (!isPluginError(error) || !error.details || typeof error.details !== 'object') return {};
    const site: unknown = Reflect.get(error.details, 'refusalSite');
    if (typeof site !== 'string' || !Object.hasOwn(refusalMessages, site)) return {};
    return { refusalSite: site as RefusalSite };
}
