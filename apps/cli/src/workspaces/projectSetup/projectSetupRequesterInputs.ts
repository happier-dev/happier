import { readSecretReferenceOverlayV1Reference, type SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import type { EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { readSavedSecretMaterializerForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import { projectRuntimeAccountRowsInput, readProjectAccountRows, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';
import type { ProjectSetupAcceptedAssociation } from './projectSetupAcceptedWorkspace';
import { mergeProjectLaunchLayers } from './projectLaunchEnvironment';

export function selectProjectRequesterSecretBindings(saved: SecretReferenceOverlayV1 | undefined,
    requirements: readonly EnvVarRequirement[], invocation?: SecretReferenceOverlayV1): SecretReferenceOverlayV1 | undefined {
    const projectBindings = saved ? Object.fromEntries(requirements.flatMap(requirement => {
        const ref = requirement.kind === 'secret' ? readSecretReferenceOverlayV1Reference(saved, requirement.name) : null;
        return ref ? [[requirement.name, ref]] : [];
    })) : {};
    const bindings = mergeProjectLaunchLayers(projectBindings, undefined, invocation?.bindings);
    return Object.keys(bindings).length ? { v: 1, bindings } : undefined;
}

/** Project defaults are references in the existing Account row; invocation refs override selected defaults. */
export async function resolveProjectRequesterSecretBindings(account: ProjectAccountRowsInput, input: Readonly<{
    project: ProjectSetupAcceptedAssociation['project'];
    requirements: readonly EnvVarRequirement[];
    environmentBindings?: SecretReferenceOverlayV1;
}>, signal?: AbortSignal): Promise<SecretReferenceOverlayV1 | undefined> {
    let saved: SecretReferenceOverlayV1 | undefined;
    if (input.requirements.some(requirement => requirement.kind === 'secret')) {
        const rows = await readProjectAccountRows({ ...account,
            serverId: input.project.serverId,
            selection: { key: { kind: 'project-organization', serverId: input.project.serverId, projectKey: input.project.projectId } },
            ...(signal ? { signal } : {}) });
        saved = rows.organizations[0]?.value.environmentBindings;
    }
    return selectProjectRequesterSecretBindings(saved, input.requirements, input.environmentBindings);
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
