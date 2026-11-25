import { isPluginError } from '@happier-dev/plugin-sdk/errors';

const credentialRefusalCodes = new Set([
    'plugin_connected_account_binding_out_of_scope',
    'plugin_connected_account_purpose_undeclared',
    'plugin_host_access_operation_denied',
    'plugin_host_access_resource_not_selected',
    'credential_unavailable',
    'plugin_fetch_credential_binding_unavailable',
]);

/** Credential refusals retain the host error. Other HTTP errors can follow a write. */
export function isDeploymentCredentialRefusalV1(error: unknown): boolean {
    return isPluginError(error) && credentialRefusalCodes.has(error.code);
}
