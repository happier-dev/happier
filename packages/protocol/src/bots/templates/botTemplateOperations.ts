import semver from 'semver';
import type { HomeHubArtifactTransportV1, HomeHubArtifactV1 } from '../../home/homeHubArtifactV1.js';
import type { ArtifactAccessGrantSetInputV1 } from '../../artifacts/artifactAccessV1.js';
export { bestEffortReportBotTemplateAcceptedVersionV1 } from './templateAcceptedVersionsV1.js';
import type { ArtifactListSelectionOptionsV1 } from '../../artifacts/artifactListSelectionV1.js';
import type { ArtifactKindCoverageV1 } from '../../artifacts/artifactKindV1.js';
import { artifactSavedByFromActionContextV1 } from '../../artifacts/artifactBinaryV1.js';
import type { ActionExecutorContext, ActionExecuteFailure, HostReviewedChildrenPreparationV1 } from '../../actions/executor/types.js';
import { prepareBotTemplateInstantiationV1, type BotTemplateRecipientPortV1, type BotTemplateLiveCopyReleaseV1 } from './templateInstantiationOperations.js';
export type { BotTemplateLiveCopyReleaseV1 } from './templateInstantiationOperations.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { readBotTemplateArtifactV1, projectBotTemplateReleaseV1, projectBotTemplateArtifactHeaderV1, projectBotTemplateContentV1,
  BOT_TEMPLATE_ARTIFACT_KIND_V1, BotTemplateArtifactHeaderV1Schema,
  type BotTemplateDraftV1, type BotTemplateReleaseV1, type BotTemplateReleaseSourceV1, type ResolvedBotTemplateReleaseV1 } from './botTemplateV1.js';
import { BotTemplateActionInputSchemasV1, type BotTemplateActionIdV1, type BotTemplateOpenInputV1,
  type BotTemplateDraftResultV1, type BotTemplatePreviewResultV1, type BotTemplateExportFileResultV1 } from './botTemplateActionsV1.js';
import { readBotTemplateUpdateDiffV1, mutateBotTemplateFollowV1, prepareBotTemplateUpdateV1 } from './templateUpdateOperations.js';

type SourceRef = BotTemplateDraftV1['sourceSessionRef'];
type DraftRef = Readonly<{ serverId: string; artifactId: string }>;
const signedInLinkInput = (artifactId: string) => ({ artifactId, audience: 'signed_in' as const, preserveExisting: true as const });
export type BotTemplateOperationPortV1 = Readonly<{
  artifacts: HomeHubArtifactTransportV1;
  /** The Session owner-private metadata transport also admits source ownership. */
  readSourceDraftRef(source: SourceRef, context: ActionExecutorContext): Promise<DraftRef | null>;
  writeSourceDraftRef(source: SourceRef, ref: DraftRef, context: ActionExecutorContext): Promise<void>;
  /** Already admitted parent operands; the existing Artifact sharing owner owns key preparation. */
  grant(input: ArtifactAccessGrantSetInputV1, context: ActionExecutorContext): Promise<void>;
  signedInLink?(input: ReturnType<typeof signedInLinkInput>, context: ActionExecutorContext): Promise<void>;
  open?(input: BotTemplateOpenInputV1): void | Promise<void>;
  /** Plugin acquisition stays with its registry/package owner; returned provenance is transport-owned. */
  resolvePluginRelease?(source: Extract<BotTemplateReleaseSourceV1, { kind: 'plugin' }>, context: ActionExecutorContext,
    signal?: AbortSignal, purpose?: 'update'): Promise<ResolvedBotTemplateReleaseV1>;
  /** The keyholding link host admits one mounted copy without inventing a grant or storing its key. */
  resolveInstantiationRelease?(source: BotTemplateReleaseSourceV1, context: ActionExecutorContext): Promise<BotTemplateLiveCopyReleaseV1>;
  recipient?: BotTemplateRecipientPortV1;
  isSameServerId?(left: string, right: string): boolean;
  randomId(): string;
  nowMs?(): number;
}>;
const failure = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function readOperationFailure(error: unknown): ActionExecuteFailure | null {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? { ok: false, errorCode: code, error: code } : null;
}
/** The authoring boundary consumes the Artifact owner's admitted access and exposure facts. */
export function readBotTemplateAuthorDraftV1(resource: HomeHubArtifactV1 | null): BotTemplateDraftV1 {
  if (!resource) return failure('artifact_not_found');
  if (resource.access !== 'owner' || resource.shared !== false) return failure('artifact_access_forbidden');
  const draft = readBotTemplateArtifactV1(resource);
  if (!draft || draft.state !== 'draft') return failure('invalid_request');
  return draft;
}

export type SharedBotTemplateSummaryV1 = Readonly<{
  source: Extract<BotTemplateReleaseSourceV1, { kind: 'artifact' }>;
  ownerAccountId: string;
  /** Null asks the presentation owner to show its localized unknown-author label. */
  ownerDisplay: string | null;
  identity: Pick<BotTemplateReleaseV1['content']['identity'], 'name' | 'description' | 'face'>;
  version: string;
}>;

/** Header-only received discovery consumes the existing Artifact list owner, one structural page at a time. */
export async function listSharedBotTemplateSummariesV1(input: Readonly<{
  serverId: string;
  list(options: ArtifactListSelectionOptionsV1): Promise<Readonly<{
    items: readonly Readonly<{ artifactId: string; ownerAccountId: string; ownerDisplayName?: string | null;
      header: Readonly<Record<string, unknown>> }>[];
    nextCursor?: string; coverage?: 'complete' | 'partial'; kindCoverage?: ArtifactKindCoverageV1;
  }>>;
  limit?: number; cursor?: string; query?: string; signal?: AbortSignal;
}>): Promise<Readonly<{ items: readonly SharedBotTemplateSummaryV1[]; nextCursor?: string; coverage: 'complete' | 'partial' }>> {
  input.signal?.throwIfAborted();
  const page = await input.list({ audience: 'received', kinds: [BOT_TEMPLATE_ARTIFACT_KIND_V1],
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.signal === undefined ? {} : { signal: input.signal }) });
  input.signal?.throwIfAborted();
  const query = input.query?.trim().toLocaleLowerCase();
  let coverage: 'complete' | 'partial' = page.coverage === 'partial' || page.kindCoverage?.status === 'partial' ? 'partial' : 'complete';
  const items: SharedBotTemplateSummaryV1[] = [];
  for (const row of page.items) {
    const parsed = BotTemplateArtifactHeaderV1Schema.safeParse(row.header);
    if (!parsed.success) { coverage = 'partial'; continue; }
    const header = parsed.data;
    if (header.state !== 'released' || (query && !header.title.toLocaleLowerCase().includes(query)
      && !header.description.toLocaleLowerCase().includes(query))) continue;
    items.push({ source: { kind: 'artifact', serverId: input.serverId, artifactId: row.artifactId },
      ownerAccountId: row.ownerAccountId, ownerDisplay: row.ownerDisplayName ?? null,
      identity: { name: header.title, description: header.description, ...(header.face === undefined ? {} : { face: header.face }) },
      version: header.version });
  }
  return { items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }), coverage };
}
/** The same addressed admission supplies preview, downloads and the reviewed application. */
export async function resolveBotTemplateReleaseV1(port: BotTemplateOperationPortV1, source: BotTemplateReleaseSourceV1,
  context: ActionExecutorContext, signal = context.signal, purpose?: 'update'): Promise<BotTemplatePreviewResultV1> {
  signal?.throwIfAborted();
  if (source.kind === 'plugin') {
    if (!port.resolvePluginRelease) return failure('unsupported_action');
    return port.resolvePluginRelease(source, context, signal, purpose);
  }
  if (context.serverId && context.serverId !== source.serverId && !port.isSameServerId?.(context.serverId, source.serverId)) return failure('server_scope_mismatch');
  const stored = await port.artifacts.read(source.artifactId, { signal });
  signal?.throwIfAborted();
  if (!stored) return failure('artifact_not_found');
  const artifact = readBotTemplateArtifactV1(stored);
  if (!artifact || artifact.state !== 'released') return failure('invalid_request');
  return { source, release: artifact.release, revision: stored.revision, presentation: {
    ...(stored.ownerDisplayName === undefined ? {} : { ownerDisplayName: stored.ownerDisplayName }),
    ...(stored.shared === undefined ? {} : { shared: stored.shared }),
  } };
}
function summary(draft: BotTemplateDraftV1): BotTemplateDraftResultV1['summary'] {
  const content = projectBotTemplateContentV1(draft);
  return { identity: content.identity, includes: { memoryRules: content.memoryRules.length, skills: content.skills.length,
    software: draft.content.needs.software.length, connectedAccounts: draft.content.needs.connectedAccounts.length,
    mcpServers: draft.content.needs.mcpServers.length },
    leftOut: { memoryRules: draft.candidates.memoryRules.filter(item => !item.selected).length,
      skills: draft.candidates.skills.filter(item => item.selection === 'private').length } };
}

/** The admitted release supplies the same download bytes for granted and one-time link previews. */
export function readBotTemplateReleaseFileV1(release: BotTemplateReleaseV1, skillKey: string, path: string): BotTemplateExportFileResultV1 {
  const file = release.content.skills.find(skill => skill.key === skillKey)?.entries.find(entry => entry.path === path);
  if (!file) return failure('not_found');
  return { fileName: file.path.split('/').at(-1)!, contentBase64: file.contentBase64, contentKind: file.contentKind };
}

/** One operation owner for UI, CLI and agent invocations; children retain the admitted parent context. */
export function createBotTemplateActionExecuteV1(port: BotTemplateOperationPortV1) {
  const execute = async (args: Readonly<{ actionId: BotTemplateActionIdV1; input: unknown; context: ActionExecutorContext; signal?: AbortSignal }>): Promise<unknown> => {
    const signal = args.signal ?? args.context.signal;
    signal?.throwIfAborted();
    try {
      if (args.actionId === 'template.updates.diff') return readBotTemplateUpdateDiffV1(port, args.input, args.context,
        source => resolveBotTemplateReleaseV1(port, source, args.context, signal, 'update'));
      if (args.actionId === 'template.updates.skip' || args.actionId === 'template.follow.stop')
        return mutateBotTemplateFollowV1(port, args.actionId, args.input, args.context);
      if (args.actionId === 'template.updates.apply') return failure('admission_unavailable');
      if (args.actionId === 'template.preview' || args.actionId === 'template.export_file') {
        const input = BotTemplateActionInputSchemasV1[args.actionId].parse(args.input);
        const resolved = await resolveBotTemplateReleaseV1(port, input.source, args.context, signal);
        if (args.actionId === 'template.preview') return resolved;
        const selection = BotTemplateActionInputSchemasV1['template.export_file'].parse(input);
        return readBotTemplateReleaseFileV1(resolved.release, selection.skillKey, selection.path);
      }
      if (args.actionId === 'template.instantiate') {
        // Effects exist only in the reviewed invocation's prepared continuation.
        return failure('admission_unavailable');
      }
      if (args.actionId === 'template.open') {
        const input = BotTemplateActionInputSchemasV1['template.open'].parse(args.input);
        if (!port.open) return failure('surface_unavailable');
        await port.open(input);
        return { opened: true };
      }
      if (args.actionId === 'template.draft') {
        const input = BotTemplateActionInputSchemasV1['template.draft'].parse(args.input);
        const ref = await port.readSourceDraftRef(input.sourceSessionRef, args.context);
        signal?.throwIfAborted();
        if (ref && (ref.serverId !== input.sourceSessionRef.serverId || input.draftArtifactId && input.draftArtifactId !== ref.artifactId))
          return failure('invalid_request');
        const draftArtifactId = ref?.artifactId ?? input.draftArtifactId ?? port.randomId();
        const existing = ref ? await port.artifacts.read(draftArtifactId, { signal }) : null;
        const previous = existing ? readBotTemplateAuthorDraftV1(existing) : null;
        if (previous?.state === 'draft' && !sameStrictJsonValue(previous.sourceSessionRef, input.sourceSessionRef)) return failure('invalid_request');
        if (existing && input.expectedRevision && !sameStrictJsonValue(existing.revision, input.expectedRevision)) return failure('version_mismatch');
        const draft: BotTemplateDraftV1 = { v: 1, state: 'draft', sourceSessionRef: input.sourceSessionRef,
          releaseArtifactId: previous?.state === 'draft' ? previous.releaseArtifactId : port.randomId(),
          content: input.content, candidates: input.candidates ?? (previous?.state === 'draft' ? previous.candidates : { memoryRules: [], skills: [] }) };
        if (!ref) await port.writeSourceDraftRef(input.sourceSessionRef, { serverId: input.sourceSessionRef.serverId, artifactId: draftArtifactId }, args.context);
        signal?.throwIfAborted();
        const write = { artifactId: draftArtifactId, header: projectBotTemplateArtifactHeaderV1(draft), body: JSON.stringify(draft),
          savedBy: artifactSavedByFromActionContextV1(args.context), signal };
        let revision;
        if (existing) {
          const result = await port.artifacts.update({ ...write, expectedRevision: existing.revision });
          if (!result.ok) return result;
          revision = result.revision;
        } else {
          const created = await port.artifacts.create(write);
          const admitted = readBotTemplateAuthorDraftV1(created);
          if (!sameStrictJsonValue(admitted, draft)) return failure('version_mismatch');
          revision = created.revision;
        }
        return { draftArtifactId, revision, sourceSessionRef: draft.sourceSessionRef, summary: summary(draft) };
      }
      const input = BotTemplateActionInputSchemasV1['template.release'].parse(args.input);
      if (input.share?.signedInLink && !port.signedInLink) return failure('unsupported_action');
      const stored = await port.artifacts.read(input.draftArtifactId, { signal });
      signal?.throwIfAborted();
      if (!stored) return failure('artifact_not_found');
      const draft = readBotTemplateAuthorDraftV1(stored);
      if (!sameStrictJsonValue(stored.revision, input.expectedRevision)) return failure('version_mismatch');
      let release = projectBotTemplateReleaseV1(draft, { version: input.version, changelog: input.changelog,
        releasedAtMs: input.releasedAtMs ?? (port.nowMs ?? Date.now)() });
      const current = await port.artifacts.read(draft.releaseArtifactId, { signal });
      signal?.throwIfAborted();
      if (current && current.access !== 'owner') return failure('artifact_access_forbidden');
      const previous = current ? readBotTemplateArtifactV1(current) : null;
      if (current && (!previous || previous.state !== 'released')) return failure('invalid_request');
      const reused = previous?.state === 'released' && previous.release.version === release.version
        && previous.release.changelog === release.changelog
        && (input.releasedAtMs === undefined || previous.release.releasedAtMs === input.releasedAtMs)
        && sameStrictJsonValue(previous.release.content, release.content);
      let revision;
      if (reused && previous?.state === 'released' && current) { release = previous.release; revision = current.revision; }
      else {
        if (previous?.state === 'released' && !semver.gt(input.version, previous.release.version)) return failure('version_mismatch');
        const envelope = { v: 1 as const, state: 'released' as const, release };
        // Deliberately no savedBy or source: the released Artifact contains portable reviewed bytes only.
        const write = { artifactId: draft.releaseArtifactId, header: projectBotTemplateArtifactHeaderV1(envelope), body: JSON.stringify(envelope), savedBy: null, signal };
        if (current) {
          const result = await port.artifacts.update({ ...write, expectedRevision: current.revision });
          if (!result.ok) return result;
          revision = result.revision;
        } else {
          const created = await port.artifacts.create(write);
          const admitted = readBotTemplateArtifactV1(created);
          if (!admitted || admitted.state !== 'released' || !sameStrictJsonValue(admitted.release, release)) return failure('version_mismatch');
          revision = created.revision;
        }
      }
      for (const principal of input.share?.recipients ?? []) {
        signal?.throwIfAborted();
        await port.grant({ artifactId: draft.releaseArtifactId, principal, accessLevel: 'view' }, args.context);
      }
      if (input.share?.signedInLink) {
        signal?.throwIfAborted();
        await port.signedInLink!(signedInLinkInput(draft.releaseArtifactId), args.context);
      }
      return { artifactId: draft.releaseArtifactId, revision, release, reused };
    } catch (error) {
      signal?.throwIfAborted();
      const refused = readOperationFailure(error);
      if (refused) return refused;
      throw error;
    }
  };
  const prepareRelease = async (request: Readonly<{ input: unknown; context: ActionExecutorContext }>): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure> => {
    try {
      const input = BotTemplateActionInputSchemasV1['template.release'].parse(request.input);
      if (!input.share?.signedInLink) return { children: [] };
      const draft = readBotTemplateAuthorDraftV1(await port.artifacts.read(input.draftArtifactId, { signal: request.context.signal }));
      return { children: [{ action: 'artifact.public_link.create', role: 'signed_in_link',
        input: signedInLinkInput(draft.releaseArtifactId) }] };
    } catch (error) {
      request.context.signal?.throwIfAborted();
      const refused = readOperationFailure(error);
      if (refused) return refused;
      throw error;
    }
  };
  return Object.assign(execute, { prepareRelease, prepareUpdate: (request: Readonly<{ input: unknown; context: ActionExecutorContext }>) =>
    prepareBotTemplateUpdateV1(port, request, (source, context) => resolveBotTemplateReleaseV1(port, source, context, context.signal, 'update')),
    prepareInstantiation: (request: Readonly<{ input: unknown; context: ActionExecutorContext }>) =>
    prepareBotTemplateInstantiationV1(port, request, () => {
      const source = BotTemplateActionInputSchemasV1['template.instantiate'].parse(request.input).source;
      return port.resolveInstantiationRelease ? port.resolveInstantiationRelease(source, request.context)
        : resolveBotTemplateReleaseV1(port, source, request.context);
    }) });
}

export { prepareBotTemplateSetupV1, checkBotTemplateSetupReadinessV1, applyBotTemplateMcpSetupV1, buildBotTemplateMachineSetupPlanInputV1, projectBotTemplateSoftwareFactsV1, BotTemplateSoftwareFactV1Schema, type BotTemplateSoftwareFactV1 } from './templateSetupV1.js';
