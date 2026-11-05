import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { type DeploymentTargetLinkAlreadyLinkedResultV1, type DeploymentTargetLinkProviderIntentInputV1, type DeploymentTargetLinkHeaderV1, type DeploymentTargetLinksListInputV1, type DeploymentTargetLinksListResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTargetLinkArtifactV1, type DeploymentArtifactDocumentV1 } from './artifacts.js';
import type { DeploymentNativeComposeOriginV1 } from './target.js';

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
            throw Object.assign(new Error(code), { code, ...(page.ok ? {} : { details: page }) });
        }
        yield* page.items;
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
}

/** Both admitted client hosts compare private provider tuples through their own Artifact reader. */
export async function findExistingDeploymentTargetLinkV1(input: DeploymentTargetLinkProviderIntentInputV1, reads: TargetLinkReads): Promise<DeploymentTargetLinkAlreadyLinkedResultV1 | undefined> {
    for await (const { environment, targetLink } of readableTargetLinks({ source: input.source, targetKind: input.targetKind }, reads)) {
        if (environment.id === input.environmentId && targetLink.id === input.replacesLinkId) continue;
        const opened = readDeploymentTargetLinkArtifactV1(targetLink, await reads.artifact(targetLink));
        if (!opened.ok || !opened.content.providerIdentity) {
            const code = opened.ok ? 'deployment_content_unavailable' : opened.error;
            throw Object.assign(new Error(code), { code });
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
        if (!opened.ok) throw Object.assign(new Error(opened.error), { code: opened.error });
        const origin = opened.content.nativeOrigin;
        if (origin?.projectName === input.origin.projectName && origin.dockerEndpoint === input.origin.dockerEndpoint) return item;
    }
}
