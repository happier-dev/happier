import type { ArtifactCallerAccessV1 } from './artifactAccessV1.js';
import type { ArtifactBodyV1 } from './artifactBinaryV1.js';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '../approvals/approvalArtifactKindV1.js';
import { WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '../widgets/widgetSurfaceArtifactV1.js';
import { HOME_HUB_ARTIFACT_KIND_V1 } from '../home/homeHubArtifactV1.js';
import { WorkflowDefinitionArtifactHeaderV1ReadSchema } from '../workflows/workflowDefinitionV1.js';
import { roleArtifactSharingAdapterV1 } from '../prompts/roles/roleArtifactSharingV1.js';
import { launchProfileArtifactSharingAdapterV1 } from '../launchProfiles/launchProfileArtifactV1.js';
import { readWorkBoardArtifactV1 } from '../boards/workBoardArtifactV1.js';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '../prompts/library/promptDocV2.js';
import { PromptBundleBodyV1Schema, PromptBundleSchemaIdV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId } from '../prompts/library/promptBundleSchemas.js';

export type ArtifactSharingResourceV1 = Readonly<{
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  body?: ArtifactBodyV1 | null;
  ownerAccountId?: string;
  access?: ArtifactCallerAccessV1;
  headerVersion?: number;
  revision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
}>;

/**
 * Kind policy delegates to the document owner; the host owns transport and keys.
 */
export type ArtifactSharingKindAdapterV1 = Readonly<{
  kind: string;
  canShare: (resource: ArtifactSharingResourceV1) => boolean;
}>;

/** Recipient intent and content admission only. Grants and content opening belong to the store. */
export type ArtifactUseTargetV1 = Readonly<{
  artifactId: string;
  kind: 'open' | 'prompt_doc' | 'prompt_bundle' | 'workflow' | 'role' | 'launch_profile' | 'board';
  canShare: boolean;
  browserListed: boolean;
  publicLinkAllowed: boolean;
}>;

/** Kind admission is shared by browser, grant and publication consumers. */
export type ArtifactKindPolicyV1 = Readonly<{
  browserListed: boolean;
  publicLinkAllowed: boolean;
  peopleSharingAllowed: boolean;
}>;

export const workflowDefinitionArtifactSharingAdapterV1 = {
  kind: 'workflow-definition.v1',
  canShare: (resource: ArtifactSharingResourceV1) => {
    const parsed = WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(resource.header);
    if (!parsed.success || parsed.data.definitionId !== resource.artifactId) return false;
    const revision = resource.revision;
    const headerVersion = revision?.headerVersion ?? resource.headerVersion;
    return (headerVersion === undefined || parsed.data.revision.headerVersion === headerVersion)
      && (revision === undefined || parsed.data.revision.bodyVersion === revision.bodyVersion);
  },
} as const satisfies ArtifactSharingKindAdapterV1;

function readBody(resource: ArtifactSharingResourceV1): unknown {
  return typeof resource.body === 'string' ? JSON.parse(resource.body) : null;
}

export const promptDocArtifactSharingAdapterV1 = {
  kind: 'prompt_doc.v2',
  canShare(resource: ArtifactSharingResourceV1) {
    try {
      return PromptDocArtifactHeaderV1Schema.safeParse(resource.header).success
        && PromptDocBodyV1Schema.safeParse(readBody(resource)).success;
    } catch { return false; }
  },
} as const satisfies ArtifactSharingKindAdapterV1;

export const promptBundleArtifactSharingAdapterV1 = {
  kind: 'prompt_bundle.v2',
  canShare(resource: ArtifactSharingResourceV1) {
    try {
      const schemaId = PromptBundleSchemaIdV1Schema.safeParse(resource.header.bundleSchemaId);
      const body = PromptBundleBodyV1Schema.safeParse(readBody(resource));
      return typeof resource.header.title === 'string' && resource.header.title.trim().length > 0
        && schemaId.success && body.success
        && validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: schemaId.data, body: body.data }).ok;
    } catch { return false; }
  },
} as const satisfies ArtifactSharingKindAdapterV1;

export const workBoardArtifactSharingAdapterV1 = {
  kind: 'work-board.v1',
  canShare(resource: ArtifactSharingResourceV1) {
    try {
      return readWorkBoardArtifactV1({ artifactId: resource.artifactId, header: resource.header,
        body: resource.body ?? null }) !== null;
    } catch { return false; }
  },
} as const satisfies ArtifactSharingKindAdapterV1;

const documentPolicy = { browserListed: true, publicLinkAllowed: true, peopleSharingAllowed: true } as const;
const privatePolicy = { browserListed: false, publicLinkAllowed: false, peopleSharingAllowed: false } as const;

// One table owns presentation, grant/public admission, intent and content validation.
const kindPolicies: readonly Readonly<ArtifactKindPolicyV1 & {
  kind: string; adapter?: ArtifactSharingKindAdapterV1; useKind: ArtifactUseTargetV1['kind']; requiresTextBody: boolean;
}>[] = [
  ...[
    { adapter: workflowDefinitionArtifactSharingAdapterV1, useKind: 'workflow' as const },
    { adapter: roleArtifactSharingAdapterV1, useKind: 'role' as const },
    { adapter: launchProfileArtifactSharingAdapterV1, useKind: 'launch_profile' as const },
    { adapter: promptDocArtifactSharingAdapterV1, useKind: 'prompt_doc' as const },
    { adapter: promptBundleArtifactSharingAdapterV1, useKind: 'prompt_bundle' as const },
    { adapter: workBoardArtifactSharingAdapterV1, useKind: 'board' as const },
  ].map(policy => ({ ...documentPolicy, ...policy, kind: policy.adapter.kind, requiresTextBody: true })),
  ...Object.values(APPROVAL_ARTIFACT_KINDS_V1).map(kind => ({ ...privatePolicy, kind, useKind: 'open' as const, requiresTextBody: true })),
  { ...documentPolicy, kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, useKind: 'open', requiresTextBody: false,
    browserListed: false, publicLinkAllowed: false },
  { ...privatePolicy, kind: HOME_HUB_ARTIFACT_KIND_V1, useKind: 'open', requiresTextBody: false },
];

/** Unknown and untyped ordinary documents retain generic document behavior. */
export function getArtifactKindPolicyV1(kind: unknown): ArtifactKindPolicyV1 {
  return kindPolicies.find(policy => policy.kind === kind) ?? documentPolicy;
}

/** The current specialized kind owners all require a JSON text document, never a blob reference. */
export function artifactKindRequiresTextBodyV1(kind: unknown): boolean {
  return kindPolicies.find(policy => policy.kind === kind)?.requiresTextBody ?? false;
}

export function getArtifactUseTargetV1(resource: ArtifactSharingResourceV1): ArtifactUseTargetV1 {
  const policy = kindPolicies.find(policy => policy.kind === resource.header.kind);
  const admission = policy ?? documentPolicy;
  const validContent = policy?.adapter ? policy.adapter.canShare(resource) : true;
  // The authenticated ordinary reader excludes plugin-owned storage. Untyped/predecessor and
  // unknown ordinary documents use the generic viewer; this does not confer grant authority.
  return { artifactId: resource.artifactId, kind: policy?.useKind ?? 'open',
    browserListed: admission.browserListed, publicLinkAllowed: admission.publicLinkAllowed && validContent,
    canShare: admission.peopleSharingAllowed && validContent };
}

/** Only already-authorized, opened headers enter this projection; no foreign scan. */
export function filterArtifactSharingResourcesByKindV1<T extends ArtifactSharingResourceV1>(
  resources: readonly T[], adapter: ArtifactSharingKindAdapterV1,
): T[] {
  return resources.filter((resource) => resource.header.kind === adapter.kind && adapter.canShare(resource));
}
