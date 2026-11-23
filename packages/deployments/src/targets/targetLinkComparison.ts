import { createActionExecuteFailureError, type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { readProjectSourceRepositoryIdentityV1, type ProjectSourceV1, type ProjectSourcesReadOutputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { DeploymentTargetV1 } from '@happier-dev/deployments/contracts/v1';
import { readPluginActionCredentialPurposeV1 } from './deploymentTargetCatalog.js';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { type DeploymentTargetCheckInputV1, type DeploymentTargetCheckResultV1, type DeploymentEnvironmentGetResultV1, type DeploymentTargetLinkAlreadyLinkedResultV1, type DeploymentTargetLinkProviderIntentInputV1, type DeploymentTargetLinkHeaderV1, type DeploymentTargetLinksListInputV1, type DeploymentTargetLinksListResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/protocol/deployments/deploymentTargetLinkContentV1';
import type { DeploymentArtifactDocumentV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import type { DeploymentNativeComposeOriginV1 } from '@happier-dev/deployments/contracts/v1';

type TargetLinkSelection = NonNullable<DeploymentTargetLinksListInputV1['selection']>;
type TargetLinkReads = Readonly<{
    list(selection: TargetLinkSelection, cursor?: string): Promise<DeploymentTargetLinksListResultV1>;
    artifact(link: DeploymentTargetLinkHeaderV1): Promise<DeploymentArtifactDocumentV1 | null>;
}>;

async function* readableTargetLinks(selection: TargetLinkSelection, reads: TargetLinkReads) {
    let cursor: string | undefined;
    do {
        const page = await reads.list(selection, cursor);
        if (!page.ok || page.coverage !== 'complete') {
            const code = page.ok ? 'deployment_content_unavailable' : page.error;
            throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code, ...(page.ok ? {} : { details: page }) });
        }
        yield* page.items;
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
}

type ProviderLinkCandidate = Pick<DeploymentTargetLinkProviderIntentInputV1, 'serverId' | 'source' | 'targetKind'>
    & Partial<Pick<DeploymentTargetLinkProviderIntentInputV1, 'environmentId' | 'replacesLinkId'>>
    & Readonly<{ provider: Pick<DeploymentTargetLinkProviderIntentInputV1['provider'], 'providerIdentity'> }>;

/** Check and admitted Link compare private provider tuples through their host's Artifact reader. */
export async function findExistingDeploymentTargetLinkV1(input: ProviderLinkCandidate, reads: TargetLinkReads): Promise<DeploymentTargetLinkAlreadyLinkedResultV1 | undefined> {
    for await (const { environment, targetLink } of readableTargetLinks({ source: input.source, targetKind: input.targetKind }, reads)) {
        if (environment.id === input.environmentId && targetLink.id === input.replacesLinkId) continue;
        const opened = readDeploymentTargetLinkArtifactV1(targetLink, await reads.artifact(targetLink));
        if (!opened.ok || !opened.content.providerIdentity) {
            const code = opened.ok ? 'deployment_content_unavailable' : opened.error;
            throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code });
        }
        if (sameStrictJsonValue(opened.content.providerIdentity, input.provider.providerIdentity)) return {
            ok: false, error: 'provider_scope_already_linked', targetLinkId: targetLink.id,
            environment: { serverId: input.serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id },
        };
    }
}

/** Native adoption identifies the protected physical project and its installed runtime member. */
export async function findExistingNativeComposeTargetLinkV1(input: Readonly<{
    machineId: string; origin: DeploymentNativeComposeOriginV1;
}>, reads: TargetLinkReads): Promise<Extract<DeploymentTargetLinksListResultV1, { ok: true }>['items'][number] | undefined> {
    for await (const item of readableTargetLinks({ source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer' }, reads)) {
        const { environment, targetLink } = item;
        if (environment.runtimeTargetLinkId !== targetLink.id
            || !targetLink.members.some(member => member.machineId === input.machineId && member.state === 'active'
                && member.installationId === input.origin.capture?.installationId)) continue;
        const opened = readDeploymentTargetLinkArtifactV1(targetLink, await reads.artifact(targetLink));
        if (!opened.ok) throw createActionExecuteFailureError({ ok: false, errorCode: opened.error, error: opened.error });
        const origin = opened.content.nativeOrigin;
        if (origin?.projectName === input.origin.projectName && origin.dockerEndpoint === input.origin.dockerEndpoint) return item;
    }
}


export function readDeploymentTargetInspectionV1(output: unknown):
    Exclude<DeploymentTargetCheckResultV1, { kind: 'alreadyLinked' }> | ActionExecuteFailure {
    const parsed = DeploymentTargetLinkProviderContentV1Schema.safeParse(output);
    if (!parsed.success) return { ok: false, errorCode: 'provider_response_invalid', error: 'provider_response_invalid' };
    const provider = parsed.data;
    const access = provider.repositoryAccess;
    return access?.status === 'needsGitAccess'
        ? { kind: 'needsGitAccess', provider, grantUrl: access.grantUrl ?? null }
        : { kind: 'ready', provider };
}

/** The same Account Action produces provider readiness and the exact saved association for every caller. */
export async function checkDeploymentTargetV1(input: DeploymentTargetCheckInputV1, host: Readonly<{
    accountId: string;
    assertCurrent(): void | Promise<void>;
    readSource(): Promise<ProjectSourcesReadOutputV1 | ActionExecuteFailure>;
    readEnvironment(environmentId: string): Promise<DeploymentEnvironmentGetResultV1 | ActionExecuteFailure>;
    readTarget(): Promise<Readonly<{ target: DeploymentTargetV1 | undefined | null;
        manifests: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[] }>>;
    inspect(action: Readonly<{ pluginId: string; localId: string }>, input: unknown, machineId?: string): Promise<ActionExecuteResult>;
    list(owner: ProjectSourceV1['owner'], selection: TargetLinkSelection, cursor?: string): Promise<DeploymentTargetLinksListResultV1>;
    artifact: TargetLinkReads['artifact'];
}>): Promise<DeploymentTargetCheckResultV1 | ActionExecuteFailure> {
    const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    await host.assertCurrent();
    const source = await host.readSource();
    if (!source.ok) return failure('deployment_content_unavailable');
    const environment = input.environmentId === undefined ? undefined : await host.readEnvironment(input.environmentId);
    if (environment && !environment.ok) return 'errorCode' in environment ? environment : failure(environment.error);
    if (environment && environment.environment.projectSourceId !== source.source.id) return failure('deployment_unavailable');
    const { target, manifests } = await host.readTarget();
    const inspect = target?.role === 'runtime' && target.source.kind === 'plugin' ? target.actions.inspect : undefined;
    const action = inspect?.kind === 'plugin' ? parseQualifiedPluginActionId(inspect.actionId) : null;
    const manifest = action && manifests.find(item => item.manifest.id === action.pluginId)?.manifest;
    const credential = action && manifest ? readPluginActionCredentialPurposeV1(manifest, action.localId) : null;
    if (!target || !action || !credential) return failure('target_unavailable');
    if (!sameStrictJsonValue(credential.service, input.credentialRef.service)) return failure('target_mismatch');
    const repositoryIdentity = readProjectSourceRepositoryIdentityV1(source.source.repository);
    const { repository: _repository, environmentId: _environmentId, expectedRevision: _expectedRevision, ...fields } = input.fields;
    const inspected = await host.inspect(action, { ...fields, v: 1, serverId: input.serverId,
        ...(repositoryIdentity ? { repository: repositoryIdentity } : {}),
        ...(environment ? { environmentId: environment.environment.id, expectedRevision: environment.environment.revision } : {}),
        credentialRef: input.credentialRef, credentialPrincipal: {
            kind: 'account', accountId: host.accountId, purpose: { consumer: action, purpose: credential.purpose },
            target: { kind: 'account', account: input.credentialRef },
        },
    }, environment?.environment.controllerMachineId ?? input.controllerMachineId);
    await host.assertCurrent();
    if (!inspected.ok) return inspected;
    const inspection = readDeploymentTargetInspectionV1(inspected.result);
    if (!('kind' in inspection) || inspection.kind !== 'ready') return inspection;
    const { provider } = inspection;
    const association = await findExistingDeploymentTargetLinkV1({ serverId: input.serverId,
        environmentId: input.environmentId, source: target.source, targetKind: target.targetKind, provider,
    }, { list: (selection, cursor) => host.list(source.source.owner, selection, cursor), artifact: host.artifact });
    await host.assertCurrent();
    return association ? { kind: 'alreadyLinked', association } : inspection;
}
