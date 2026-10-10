import type { ArtifactCallerAccessV1 } from './artifactAccessV1.js';
import type { ArtifactAccessGrantsListResponseV1 } from './artifactAccessV1.js';
import type { ArtifactPublicAudienceV1 } from './artifactActionsV1.js';
import type { ArtifactBodyV1 } from './artifactBinaryV1.js';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '../approvals/approvalArtifactKindV1.js';
import { WIDGET_SURFACE_ARTIFACT_KIND_V1, readWidgetSurfaceArtifactV1 } from '../widgets/widgetSurfaceArtifactV1.js';
import { HOME_HUB_ARTIFACT_KIND_V1 } from '../home/homeHubArtifactV1.js';
import { WIDGET_LAYOUT_FRAGMENT_ARTIFACT_KIND_V1 } from '../widgets/widgetLayoutFragmentArtifactV1.js';
import { USAGE_NOTICE_ARTIFACT_KIND_V1 } from '../activity/usageNoticeArtifactV1.js';
import { WorkflowDefinitionArtifactHeaderV1ReadSchema } from '../workflows/workflowDefinitionV1.js';
import { roleArtifactSharingAdapterV1 } from '../prompts/roles/roleArtifactSharingV1.js';
import { launchProfileArtifactSharingAdapterV1 } from '../launchProfiles/launchProfileArtifactV1.js';
import { readWorkBoardArtifactV1 } from '../boards/workBoardArtifactV1.js';
import { getWidgetSharedInputIssuesV1 } from '../widgets/widgetSharedInputAdmissionV1.js';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '../prompts/library/promptDocV2.js';
import { MemoryDocArtifactHeaderV1StoredSchema, MemoryDocBodyV1StoredSchema } from '../prompts/library/memoryDocV1.js';
import { PromptBundleBodyV1Schema, PromptBundleSchemaIdV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId } from '../prompts/library/promptBundleSchemas.js';

export type ArtifactSharingResourceV1 = Readonly<{
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  body?: ArtifactBodyV1 | null;
  ownerAccountId?: string;
  access?: ArtifactCallerAccessV1;
  publicAudience?: ArtifactPublicAudienceV1;
  headerVersion?: number;
  revision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
}>;

/** Admitted audience facts, not header metadata or the public-sharing availability bit. */
export async function readArtifactSharedAudienceV1(params: Readonly<{
  current: ArtifactSharingResourceV1;
  readGrants: () => Promise<ArtifactAccessGrantsListResponseV1>;
  signal?: AbortSignal;
}>): Promise<boolean> {
  params.signal?.throwIfAborted();
  if (params.current.access === 'view' || params.current.access === 'edit' || params.current.access === 'admin'
    || params.current.publicAudience === 'retained') return true;
  const audience = await params.readGrants();
  params.signal?.throwIfAborted();
  if (audience.artifactId !== params.current.artifactId
    || params.current.ownerAccountId !== undefined && audience.ownerAccountId !== params.current.ownerAccountId) {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
  if (audience.access !== 'owner' || audience.grants.length > 0) return true;
  if (params.current.publicAudience === 'none') return false;
  // Missing predecessor or unavailable exposure facts cannot prove privacy,
  // including kinds that no longer permit creating new public publications.
  throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
}

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
  kind: 'open' | 'prompt_doc' | 'prompt_bundle' | 'memory' | 'workflow' | 'role' | 'launch_profile' | 'board';
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

export const memoryDocArtifactSharingAdapterV1 = {
  kind: 'memory_doc.v1',
  canShare(resource: ArtifactSharingResourceV1) {
    try {
      return MemoryDocArtifactHeaderV1StoredSchema.safeParse(resource.header).success
        && MemoryDocBodyV1StoredSchema.safeParse(readBody(resource)).success;
    } catch { return false; }
  },
} as const satisfies ArtifactSharingKindAdapterV1;

export const workBoardArtifactSharingAdapterV1 = {
  kind: 'work-board.v1',
  canShare(resource: ArtifactSharingResourceV1) {
    try {
      const board = readWorkBoardArtifactV1({ artifactId: resource.artifactId, header: resource.header,
        body: resource.body ?? null });
      return board !== null && !storedWidgetContentHasPrivateInputs(readBody(resource), 'widgets');
    } catch { return false; }
  },
} as const satisfies ArtifactSharingKindAdapterV1;

/** Inspect original stored values before additive projection can drop a private pin. */
function storedWidgetContentHasPrivateInputs(body: unknown, list: 'widgets' | 'items'): boolean {
  if (!body || typeof body !== 'object' || !(list in body)) return false;
  const entries = (body as Record<string, unknown>)[list];
  if (!Array.isArray(entries)) return false;
  const pending: unknown[] = [...entries];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || typeof entry !== 'object') continue;
    if (list === 'items' && getWidgetSharedInputIssuesV1(entry).length > 0) return true;
    if ('instance' in entry && getWidgetSharedInputIssuesV1(entry.instance).length > 0) return true;
    // Groups are presentation only; every child still receives the same source/privacy admission.
    if (list === 'items' && 'kind' in entry && entry.kind === 'group' && 'children' in entry && Array.isArray(entry.children)) {
      for (const child of entry.children) pending.push(child);
    }
  }
  return false;
}

export const widgetSurfaceArtifactSharingAdapterV1 = {
  kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
  canShare(resource: ArtifactSharingResourceV1) {
    try {
      return readWidgetSurfaceArtifactV1({ artifactId: resource.artifactId, header: resource.header, body: resource.body ?? null }) !== null
        && !storedWidgetContentHasPrivateInputs(readBody(resource), 'items');
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
    { adapter: memoryDocArtifactSharingAdapterV1, useKind: 'memory' as const },
    { adapter: promptBundleArtifactSharingAdapterV1, useKind: 'prompt_bundle' as const },
    { adapter: workBoardArtifactSharingAdapterV1, useKind: 'board' as const },
  ].map(policy => ({ ...documentPolicy, ...policy, kind: policy.adapter.kind, requiresTextBody: true })),
  ...Object.values(APPROVAL_ARTIFACT_KINDS_V1).map(kind => ({ ...privatePolicy, kind, useKind: 'open' as const, requiresTextBody: true })),
  { ...documentPolicy, kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, adapter: widgetSurfaceArtifactSharingAdapterV1, useKind: 'open', requiresTextBody: false,
    browserListed: false, publicLinkAllowed: false },
  { ...privatePolicy, kind: HOME_HUB_ARTIFACT_KIND_V1, useKind: 'open', requiresTextBody: false },
  { ...privatePolicy, kind: WIDGET_LAYOUT_FRAGMENT_ARTIFACT_KIND_V1, useKind: 'open', requiresTextBody: true },
  { ...privatePolicy, kind: USAGE_NOTICE_ARTIFACT_KIND_V1, useKind: 'open', requiresTextBody: true },
];

/** Unknown and untyped ordinary documents retain generic document behavior. */
export function getArtifactKindPolicyV1(kind: unknown): ArtifactKindPolicyV1 {
  return kindPolicies.find(policy => policy.kind === kind) ?? documentPolicy;
}

/** The current specialized kind owners all require a JSON text document, never a blob reference. */
export function artifactKindRequiresTextBodyV1(kind: unknown): boolean {
  return kindPolicies.find(policy => policy.kind === kind)?.requiresTextBody ?? false;
}

/** Only these existing content adapters own shared widget-input admission. */
export function artifactKindHasSharedWidgetInputsV1(kind: unknown): boolean {
  const adapter = kindPolicies.find(policy => policy.kind === kind)?.adapter;
  return adapter === workBoardArtifactSharingAdapterV1 || adapter === widgetSurfaceArtifactSharingAdapterV1;
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
