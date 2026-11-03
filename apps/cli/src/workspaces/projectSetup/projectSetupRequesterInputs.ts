import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { readSavedSecretMaterializerForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';

/** Materializes only the admitted requester's selected refs through the existing secret owner. */
export async function resolveProjectRequesterSecretEnvironment(runtime: ProjectFiniteActionRuntime,
    environmentBindings?: SecretReferenceOverlayV1, signal?: AbortSignal): Promise<ProjectFiniteActionRuntime['secretEnvironment']> {
    const requester = readRequesterAccountActionContext(runtime.accountAuthorization);
    if (!requester) return runtime.resolveSecretEnvironment
        ? await runtime.resolveSecretEnvironment(environmentBindings, signal) : runtime.secretEnvironment;
    if (!await requester.refreshAccountSettings(signal)) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
    const captured = requester.savedSecretOperationContext.readSnapshot();
    if (!captured?.scopeKey) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
    const { snapshot, materializer } = await readSavedSecretMaterializerForOperation({ expectedScopeKey: captured.scopeKey,
        secretSources: runtime.plugins?.secretSources,
        operationContext: requester.savedSecretOperationContext, ...(environmentBindings ? { secretReferenceOverlay: environmentBindings } : {}),
        ...(signal ? { signal } : {}) });
    return { accountSettings: snapshot.rawSettings ?? snapshot.settings, settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
        savedSecretMaterializer: materializer,
        ...(snapshot.savedSecretResources ? { savedSecretResources: snapshot.savedSecretResources } : {}) };
}
