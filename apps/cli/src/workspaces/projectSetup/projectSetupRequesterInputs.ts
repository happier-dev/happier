import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import type { EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { readSavedSecretMaterializerForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import { projectRuntimeAccountRowsInput, readProjectAccountRows, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';
import type { ProjectSetupAcceptedAssociation } from './projectSetupAcceptedWorkspace';
import { mergeProjectLaunchLayers } from './projectLaunchEnvironment';

/** Project defaults are references in the existing Account row; invocation refs override selected defaults. */
export async function resolveProjectRequesterSecretBindings(account: ProjectAccountRowsInput, input: Readonly<{
    project: ProjectSetupAcceptedAssociation['project'];
    requirements: readonly EnvVarRequirement[];
    environmentBindings?: SecretReferenceOverlayV1;
}>, signal?: AbortSignal): Promise<SecretReferenceOverlayV1 | undefined> {
    const secretNames = input.requirements.filter(requirement => requirement.kind === 'secret').map(requirement => requirement.name);
    let projectBindings: SecretReferenceOverlayV1['bindings'] = {};
    if (secretNames.length) {
        const rows = await readProjectAccountRows({ ...account,
            serverId: input.project.serverId,
            selection: { key: { kind: 'project-organization', serverId: input.project.serverId, projectKey: input.project.projectId } },
            ...(signal ? { signal } : {}) });
        const saved = rows.organizations[0]?.value.environmentBindings?.bindings;
        // Removed or renamed requirements do not acquire stale Project references.
        projectBindings = Object.fromEntries(secretNames.flatMap(name => saved?.[name] ? [[name, saved[name]]] : []));
    }
    const bindings = mergeProjectLaunchLayers(projectBindings, undefined, input.environmentBindings?.bindings);
    return Object.keys(bindings).length ? { v: 1, bindings } : undefined;
}

export async function resolveProjectRequesterSecretInputs(runtime: ProjectFiniteActionRuntime,
    input: Parameters<typeof resolveProjectRequesterSecretBindings>[1], signal?: AbortSignal): Promise<Readonly<{
    environmentBindings?: SecretReferenceOverlayV1;
    secretEnvironment: ProjectFiniteActionRuntime['secretEnvironment'];
}>> {
    const environmentBindings = await resolveProjectRequesterSecretBindings(projectRuntimeAccountRowsInput(runtime), input, signal);
    const secretEnvironment = await resolveProjectRequesterSecretEnvironment(runtime, environmentBindings, signal);
    return { ...(environmentBindings ? { environmentBindings } : {}), secretEnvironment };
}

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
