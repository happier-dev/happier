import type { ArtifactRevisionV1 } from './artifactActionsV1.js';
import type { ArtifactBodyV1 } from './artifactBinaryV1.js';
import { artifactKindRequiresTextBodyV1, getArtifactUseTargetV1, type ArtifactSharingResourceV1 } from './artifactSharingV1.js';
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactBodyV1ReadSchema, WorkflowDefinitionArtifactHeaderV1Schema, retargetWorkflowDefinitionArtifactHeaderV1 } from '../workflows/workflowDefinitionV1.js';
import { workflowDefinitionPreviewStepsV1 } from '../workflows/workflowStepLabel.js';
import { LaunchProfileArtifactV1Schema, buildLaunchProfileArtifactHeaderV1 } from '../launchProfiles/launchProfileArtifactV1.js';
import { RoleArtifactV1Schema, buildRoleArtifactHeaderV1 } from '../prompts/roles/roleArtifactV1.js';
import { WorkBoardV1Schema } from '../boards/workBoardV1.js';
import { buildWorkBoardArtifactHeaderV1 } from '../boards/workBoardArtifactV1.js';
import { buildWidgetDefinitionArtifactHeaderV1, readWidgetDefinitionArtifactV1 } from '../widgets/widgetDefinitionArtifactV1.js';
import { WidgetDefinitionV1Schema } from '../widgets/widgetDefinitionV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, readAccountNoticeArtifactV1 } from '../activity/usageNoticeArtifactV1.js';
import { readSkillBundleContentV1 } from '../prompts/library/promptBundleSchemas.js';
import { buildSkillListSummaryV1 } from '../prompts/library/skills/skillListSummaryV1.js';

type ArtifactSharedWriteContextV1 = Readonly<{ current: ArtifactSharingResourceV1; shared: boolean }>;

/** Content already safe for every audience needs no privacy-specific audience lookup. */
export function canShareArtifactWriteContentV1(current: ArtifactSharingResourceV1,
  header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null): boolean {
  return getArtifactUseTargetV1({ ...current, header, body }).canShare
    && (current.header.kind === header.kind || getArtifactUseTargetV1({ ...current, body }).canShare);
}

function requireSharedContent(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null, context?: ArtifactSharedWriteContextV1): void {
  if (!context?.shared) return;
  // The host supplies the actual audience and opened current resource. Checking its
  // kind as well as the candidate prevents retagging from bypassing content policy.
  if (!canShareArtifactWriteContentV1(context.current, header, body)) {
    throw Object.assign(new Error('artifact_shared_content_forbidden'), { code: 'artifact_shared_content_forbidden' });
  }
}

/** Generic key-holding writes consume the same authored projections as typed writes and restore. */
export function prepareArtifactHeaderForBodyV1(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null,
  context?: ArtifactSharedWriteContextV1): Readonly<Record<string, unknown>> {
  if (header.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1) {
    // This kind owns a paired notice source, not workspace revision provenance.
    const notice = readAccountNoticeArtifactV1({ header, body });
    if (!notice) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
    requireSharedContent(notice, body, context);
    return notice;
  }
  // Workspace identity is supplied separately by the host to private revision metadata.
  const { source: _source, ...publicHeader } = header;
  header = publicHeader;
  if (header.kind === 'prompt_bundle.v2' && header.bundleSchemaId === 'skills.skill_md_v1') {
    const content = readSkillBundleContentV1({ header, body });
    if (!content) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
    header = { ...header, skillListSummary: buildSkillListSummaryV1(content) };
  }
  if (header.kind === 'workflow-definition.v1' || header.kind === 'work-board.v1' || header.kind === 'widget-definition.v1') {
    try {
      if (typeof body !== 'string') throw new Error('artifact_body_unavailable');
      if (header.kind === 'work-board.v1') header = { ...header, ...buildWorkBoardArtifactHeaderV1(WorkBoardV1Schema.parse(JSON.parse(body))) };
      else if (header.kind === 'widget-definition.v1') {
        header = { ...header, ...buildWidgetDefinitionArtifactHeaderV1(WidgetDefinitionV1Schema.parse(JSON.parse(body))) };
      } else {
        const parsed = WorkflowDefinitionArtifactBodyV1Schema.parse(JSON.parse(body));
        WorkflowDefinitionArtifactHeaderV1Schema.parse(header);
        header = { ...header, previewSteps: workflowDefinitionPreviewStepsV1(parsed.definition.blocks) };
      }
    } catch {
      throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
    }
  }
  requireSharedContent(header, body, context);
  return header;
}

/** Key-holding restore preparation; content-kind owners define their header projections. */
export function prepareArtifactHeaderForRevisionV1(input: Readonly<{
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  body: ArtifactBodyV1 | null;
  expectedRevision: ArtifactRevisionV1;
  nextRevision: ArtifactRevisionV1;
  /** Actual audience admission from the key-holding Artifact owner, never header metadata. */
  shared?: boolean;
}>): Readonly<Record<string, unknown>> {
  if (input.header.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1) {
    return prepareArtifactHeaderForBodyV1(input.header, input.body, {
      current: { artifactId: input.artifactId, header: input.header }, shared: input.shared === true,
    });
  }
  const { source: _source, ...publicHeader } = input.header;
  input = { ...input, header: publicHeader };
  const kind = input.header.kind;
  if (kind === 'prompt_bundle.v2' && input.header.bundleSchemaId === 'skills.skill_md_v1') {
    return prepareArtifactHeaderForBodyV1(input.header, input.body, {
      current: { artifactId: input.artifactId, header: input.header }, shared: input.shared === true,
    });
  }
  requireSharedContent(input.header, input.body, { current: { artifactId: input.artifactId, header: input.header }, shared: input.shared === true });
  if (artifactKindRequiresTextBodyV1(kind) && typeof input.body !== 'string') {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
  if (kind !== 'workflow-definition.v1' && kind !== 'launch-profile.v1' && kind !== 'role.v1' && kind !== 'work-board.v1'
    && kind !== 'widget-definition.v1') {
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
      return { ...input.header, ...buildLaunchProfileArtifactHeaderV1(createStoredReadSchema(LaunchProfileArtifactV1Schema).parse(body)) };
    }
    if (kind === 'role.v1') {
      return { ...input.header, ...buildRoleArtifactHeaderV1(createStoredReadSchema(RoleArtifactV1Schema).parse(body)) };
    }
    if (kind === 'widget-definition.v1') {
      return { ...input.header, ...buildWidgetDefinitionArtifactHeaderV1(readWidgetDefinitionArtifactV1(input)) };
    }
    const board = WorkBoardV1Schema.parse(body);
    if (board.id !== input.artifactId) throw new Error('artifact_identity_mismatch');
    return { ...input.header, ...buildWorkBoardArtifactHeaderV1(board) };
  } catch {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
}
