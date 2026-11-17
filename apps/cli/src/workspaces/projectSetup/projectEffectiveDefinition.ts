import { resolveProjectDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import type { ProjectSetupReadV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import type { ProjectManifestInspectionSnapshot } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { readProjectManifest } from './projectManifestFile';
import { readAcceptedProjectSetupForProject } from './projectAcceptedSetup';

/** Raw repository authoring and effective execution share one selected protected-detail read. */
export async function readProjectEffectiveDefinition(input: Readonly<{
    root: string; account: ProjectAccountRowsInput; serverHttpBaseUrl: string;
    project: Readonly<{ serverId: string; projectId: string }>; signal?: AbortSignal;
    acceptedSetup?: ProjectSetupReadV1;
    repositorySnapshot?: ProjectManifestInspectionSnapshot;
}>) {
    const snapshot = input.repositorySnapshot ?? await readProjectManifest({ root: input.root });
    if (snapshot.document?.status === 'invalid') throw Object.assign(new Error('invalid_manifest'), { code: 'invalid_manifest' });
    const acceptedSetup = input.acceptedSetup ?? await readAcceptedProjectSetupForProject(input);
    if (acceptedSetup.kind === 'unavailable') throw Object.assign(new Error(acceptedSetup.code), { code: acceptedSetup.code });
    const effectiveDefinition = resolveProjectDefinitionV1({ repositoryManifest: snapshot.document?.manifest ?? null, ...acceptedSetup });
    return { snapshot, acceptedSetup, effectiveDefinition };
}
