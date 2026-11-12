import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { SavedSecretOperationAdmissionFailureReasonV1Schema } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginSecretSourceFailureV1Schema } from '@happier-dev/protocol/plugins/contributions/public-types';
import { createConnectedAccountHttpPurposeHost } from '@happier-dev/cli-common/plugins/http';
import { savedSecretOperationAdmissionStatus } from '@/settings/secrets/savedSecretCatalog';
import { logger } from '@/ui/logger';
import { createStablePluginConnectedAccountsHost, type StablePluginConnectedAccountsOwner,
    type StablePluginConnectedAccountsHostOptions } from '../invocation/services/connectedAccounts';
import type { StablePluginHttpPurposeHost } from './service';
import type { PluginInvocationServicesSeed, PluginInvocationServiceBinding } from '../invocation/services/types';

function refused(): never {
    throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope',
        message: 'The request does not match the admitted credential purpose' });
}

/** Only the closed material-repair envelope may cross this error-redaction boundary. */
function readMaterialSourceFailureDetails(details: unknown) {
    if (!details || typeof details !== 'object' || !('materialStatus' in details) || !('sourceFailure' in details)
        || !details.sourceFailure || typeof details.sourceFailure !== 'object') return undefined;
    const materialStatus = SavedSecretOperationAdmissionFailureReasonV1Schema.options
        .map(savedSecretOperationAdmissionStatus).find(status => status === details.materialStatus);
    const source = PluginSecretSourceFailureV1Schema.safeParse({ ...details.sourceFailure, ok: false });
    if (!materialStatus || !source.success) return undefined;
    return { materialStatus, sourceFailure: { code: source.data.code, ...(source.data.repair ? { repair: source.data.repair } : {}) } };
}

/** Host-kept headers spend the invocation's existing exact purpose selection. */
export function createConnectedAccountPluginHttpPurposeHost(owner: StablePluginConnectedAccountsOwner,
    redaction: Pick<StablePluginConnectedAccountsHostOptions, 'registerRawForRedaction'>): StablePluginHttpPurposeHost {
    const createHost = (selectedOwner: StablePluginConnectedAccountsOwner) => createStablePluginConnectedAccountsHost(selectedOwner, {
        registerRawForRedaction: redaction.registerRawForRedaction,
        // This adapter requests only httpHeaders; file-byte registration is unreachable.
        registerExactForRedaction: redaction.registerRawForRedaction,
    });
    const host = createHost(owner);
    const sanitizeFailure = (error: unknown, entered: boolean,
        _containsSensitiveValue: (value: string) => boolean, publicFailure: PluginError): never => {
        const code = publicFailure.code;
        const failureCause = publicFailure.data.failureCause
            ?? projectActionFailureCauseV1(error, entered ? 'connected_account.http.execute' : 'connected_account.http.materialize');
        if (code === 'outcome_unknown' || !isPluginError(error)) {
            // Native fetch errors keep their transport code on cause. Record only
            // the existing closed diagnostic vocabulary, never messages or URLs.
            try {
                logger.warnLocalFile('[connected-account-http-failure]', failureCause);
            } catch { /* Diagnostics cannot change the redacted failure. */ }
        }
        const details = entered ? publicFailure.details
            : isPluginError(error) ? readMaterialSourceFailureDetails(error.details) : undefined;
        throw new PluginError({ code, message: publicFailure.data.message
            ?? (code === 'credential_unavailable' ? 'Sign in again, then retry.' : code),
            ...(publicFailure.data.retryable === undefined ? {} : { retryable: publicFailure.data.retryable }),
            ...(publicFailure.remediation === undefined ? {} : { remediation: publicFailure.remediation }),
            failureCause,
            ...(details === undefined ? {} : { details }) });
    };
    return createConnectedAccountHttpPurposeHost<PluginInvocationServicesSeed, PluginInvocationServiceBinding>({
        captureSubject: binding => binding.exactPurposeBindingSubjectId,
        bind({ seed, serviceBinding, purpose }) {
            if (!serviceBinding.connectedAccountScopes?.some(scope => scope.purpose === purpose)) return refused();
            const selectedHost = serviceBinding.connectedAccountsOwner ? createHost(serviceBinding.connectedAccountsOwner) : host;
            return selectedHost.bind(seed, serviceBinding.connectedAccountScopes, {
                exactPurposeBindingSubjectId: serviceBinding.exactPurposeBindingSubjectId,
            });
        },
        sanitizeFailure,
    });
}
