import type { ArtifactRevisionV1 } from './artifactActionsV1.js';
import type { ArtifactBodyV1 } from './artifactBinaryV1.js';
import { artifactKindRequiresTextBodyV1 } from './artifactSharingV1.js';
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactBodyV1ReadSchema, WorkflowDefinitionArtifactHeaderV1Schema, retargetWorkflowDefinitionArtifactHeaderV1 } from '../workflows/workflowDefinitionV1.js';
import { workflowDefinitionPreviewStepsV1 } from '../workflows/workflowStepLabel.js';
import { LaunchProfileArtifactV1Schema, buildLaunchProfileArtifactHeaderV1 } from '../launchProfiles/launchProfileArtifactV1.js';
import { RoleArtifactV1Schema, buildRoleArtifactHeaderV1 } from '../prompts/roles/roleArtifactV1.js';
import { WorkBoardV1Schema } from '../boards/workBoardV1.js';
import { buildWorkBoardArtifactHeaderV1 } from '../boards/workBoardArtifactV1.js';

/** Generic key-holding writes consume the same authored projections as typed writes and restore. */
export function prepareArtifactHeaderForBodyV1(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null): Readonly<Record<string, unknown>> {
  // Workspace identity is supplied separately by the host to private revision metadata.
  const { source: _source, ...publicHeader } = header;
  header = publicHeader;
  if (header.kind !== 'workflow-definition.v1' && header.kind !== 'work-board.v1') return header;
  try {
    if (typeof body !== 'string') throw new Error('artifact_body_unavailable');
    if (header.kind === 'work-board.v1') return { ...header, ...buildWorkBoardArtifactHeaderV1(WorkBoardV1Schema.parse(JSON.parse(body))) };
    const parsed = WorkflowDefinitionArtifactBodyV1Schema.parse(JSON.parse(body));
    WorkflowDefinitionArtifactHeaderV1Schema.parse(header);
    return { ...header, previewSteps: workflowDefinitionPreviewStepsV1(parsed.definition.blocks) };
  } catch {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
}

/** Key-holding restore preparation; content-kind owners define their header projections. */
export function prepareArtifactHeaderForRevisionV1(input: Readonly<{
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  body: ArtifactBodyV1 | null;
  expectedRevision: ArtifactRevisionV1;
  nextRevision: ArtifactRevisionV1;
}>): Readonly<Record<string, unknown>> {
  const { source: _source, ...publicHeader } = input.header;
  input = { ...input, header: publicHeader };
  const kind = input.header.kind;
  if (artifactKindRequiresTextBodyV1(kind) && typeof input.body !== 'string') {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
  if (kind !== 'workflow-definition.v1' && kind !== 'launch-profile.v1' && kind !== 'role.v1' && kind !== 'work-board.v1') {
    return input.header;
  }
  try {
    if (typeof input.body !== 'string') throw new Error('artifact_body_unavailable');
    const body: unknown = JSON.parse(input.body);
    if (kind === 'workflow-definition.v1') {
      const parsed = WorkflowDefinitionArtifactBodyV1ReadSchema.parse(body);
      return { ...retargetWorkflowDefinitionArtifactHeaderV1(input), previewSteps: workflowDefinitionPreviewStepsV1(parsed.definition.blocks) };
    }
    if (kind === 'launch-profile.v1') {
      return { ...input.header, ...buildLaunchProfileArtifactHeaderV1(LaunchProfileArtifactV1Schema.parse(body)) };
    }
    if (kind === 'role.v1') {
      return { ...input.header, ...buildRoleArtifactHeaderV1(RoleArtifactV1Schema.parse(body)) };
    }
    const board = WorkBoardV1Schema.parse(body);
    if (board.id !== input.artifactId) throw new Error('artifact_identity_mismatch');
    return { ...input.header, ...buildWorkBoardArtifactHeaderV1(board) };
  } catch {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
}
