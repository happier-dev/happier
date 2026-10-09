import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';

/** Materializes only the admitted requester's selected refs through the existing secret owner. */
export async function resolveProjectRequesterSecretEnvironment(runtime: ProjectFiniteActionRuntime,
    environmentBindings?: SecretReferenceOverlayV1, signal?: AbortSignal): Promise<ProjectFiniteActionRuntime['secretEnvironment']> {
    const requester = readRequesterAccountActionContext(runtime.accountAuthorization);
    if (!requester) return runtime.secretEnvironment;
    if (!await requester.refreshAccountSettings(signal)) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
    const captured = requester.savedSecretOperationContext.readSnapshot();
    if (!captured?.scopeKey) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
    const snapshot = await readSavedSecretCatalogForOperation({ expectedScopeKey: captured.scopeKey,
        operationContext: requester.savedSecretOperationContext, ...(environmentBindings ? { secretReferenceOverlay: environmentBindings } : {}),
        ...(signal ? { signal } : {}) });
    return { accountSettings: snapshot.rawSettings ?? snapshot.settings, settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
        ...(snapshot.savedSecretResources ? { savedSecretResources: snapshot.savedSecretResources } : {}) };
}
