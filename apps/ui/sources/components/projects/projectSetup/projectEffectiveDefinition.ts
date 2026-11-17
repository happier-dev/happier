import type { ProjectDefinitionInspectOutput } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectEffectiveDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';

export type ProjectEffectiveDefinitionInspection =
    | Readonly<{ kind: 'available'; value: ProjectEffectiveDefinitionV1 }>
    | Readonly<{ kind: 'unavailable'; code: 'project_setup_review_unavailable' }>;
const EFFECTIVE_DEFINITION_UNAVAILABLE = { kind: 'unavailable', code: 'project_setup_review_unavailable' } as const;

/** Scripts and review consume the Machine's composition; raw repository bytes belong to its editor. */
export function readProjectEffectiveDefinition(
    inspection: Pick<ProjectDefinitionInspectOutput, 'effectiveDefinition'>,
): ProjectEffectiveDefinitionInspection {
    return inspection.effectiveDefinition
        ? { kind: 'available', value: inspection.effectiveDefinition }
        : EFFECTIVE_DEFINITION_UNAVAILABLE;
}
