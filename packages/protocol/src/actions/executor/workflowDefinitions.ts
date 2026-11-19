import {
  WorkflowDefinitionArtifactBodyV1ReadSchema,
  WorkflowDefinitionArtifactHeaderV1Schema,
  WorkflowDefinitionArtifactHeaderV1ReadSchema,
  WorkflowDefinitionMetadataV1Schema,
  WorkflowArtifactRevisionV1Schema,
  type WorkflowArtifactRevisionV1,
  type WorkflowDefinitionSavedByV1,
  type WorkflowDefinitionContentUnavailableReasonV1,
  WorkflowDefinitionContentUnavailableReasonV1Schema,
} from '../../workflows/workflowDefinitionV1.js';
import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionUpdateRequestV1Schema,
  WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1, workflowDefinitionListCursorPhaseV1,
  type WorkflowDefinitionListResultV1 } from '../../workflows/actionsV1.js';
import { WorkflowDefinitionImportRequestV1Schema, WorkflowDefinitionImportResultV1Schema,
  WorkflowDefinitionExportRequestV1Schema } from '../../workflows/actionsV1.js';
import { parseWorkflowDocumentJsonIngressV1, serializeWorkflowDocumentJsonV1 } from '../../workflows/workflowDocumentV1.js';
import { applyWorkflowDefinitionEditsV1, countWorkflowStepsV1, type WorkflowDefinitionEditRequestV1 } from '../../workflows/workflowDefinitionEditV1.js';
import { workflowDefinitionPreviewStepsV1 } from '../../workflows/workflowStepLabel.js';
import type { createWorkflowTriggerActions } from './workflowTriggerActions.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../../plugins/contributions/strictJsonValue.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { WorkflowDefinitionV1, WorkflowIngressContextV1 } from '../../workflows/workflowV1.js';
import type { WorkflowActionExecuteArgs } from './types.js';
import type { z } from '../../zodRuntimePolicy.js';
import type { ArtifactCallerAccessV1 } from '../../artifacts/artifactAccessV1.js';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, type ArtifactListSelectionOptionsV1 } from '../../artifacts/artifactListSelectionV1.js';
import type { ArtifactKindCoverageV1 } from '../../artifacts/artifactKindV1.js';
import { artifactSavedByFromActionContextV1, type ArtifactBodyV1, type ArtifactRevisionProvenanceV1, type ArtifactSavedByV1 } from '../../artifacts/artifactBinaryV1.js';
import { workflowDefinitionArtifactSharingAdapterV1 } from '../../artifacts/artifactSharingV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { sameWorkflowDefinitionAuthoringContentV1 } from '../../workflows/workflowAuthoringEqualityV1.js';
import { WorkflowDefinitionIdV1Schema } from '../../workflows/workflowIdsV1.js';
import { parseWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionRefV1.js';
import type { WorkflowPluginSourceReaderV1, WorkflowPluginSourceV1 } from '../../workflows/workflowPluginSourceContractV1.js';
import { deriveWorkflowDestinationsV1, resolveWorkflowDestinationsV1 } from '../../workflows/workflowDestinationsV1.js';
import { resolveWorkflowDefinitionRefV1, resolveWorkflowPluginSourceV1 } from '../../workflows/workflowDefinitionResolverV1.js';
import type { CoordinationMessageRefV1 } from '../../discussions/messageRefs.js';
import { normalizeWorkflowActionThrownError } from './workflowAccountActions.js';
import { workflowStoredContentReadErrorCodeV1 } from '../../workflows/workflowStoredContentV1.js';
import { admitAgentStartV1 } from '../../account/settings/admitAgentStartV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { materializeWorkflowDefinitionAuthorityV1, type MaterializeWorkflowAcceptedSnapshotV1Input } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { isWorkflowTriggerAgentCallerV1 } from './workflowTriggerActions.js';
import { collectWorkflowTriggerEventReferencesV1 } from '../../workflows/workflowTriggerEventReferenceV1.js';

export type WorkflowDefinitionArtifactHeaderRow = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; headerVersion: number; updatedAt: number;
  ownerAccountId: string; access: ArtifactCallerAccessV1;
  sharedTeamIds?: readonly string[];
  body?: ArtifactBodyV1 | null; bodyVersion?: number;
  provenance?: ArtifactRevisionProvenanceV1;
}>;
export type WorkflowDefinitionArtifactOperations = Readonly<{
  read: (artifactId: string, options?: Readonly<{ signal?: AbortSignal; fresh?: boolean }>) => Promise<Readonly<{
    artifactId: string; header: Readonly<Record<string, unknown>>; body: ArtifactBodyV1 | null; revision: WorkflowArtifactRevisionV1;
    ownerAccountId: string; access: ArtifactCallerAccessV1;
    sharedTeamIds?: readonly string[];
    shared?: boolean;
    provenance?: ArtifactRevisionProvenanceV1;
    updatedAt?: number;
  }> | null>;
  list: (options: ArtifactListSelectionOptionsV1) => Promise<Readonly<{
    items: readonly WorkflowDefinitionArtifactHeaderRow[]; nextCursor?: string;
    coverage?: 'complete' | 'partial';
    kindCoverage?: ArtifactKindCoverageV1;
  }>>;
  create: (input: Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1 | null; memoryDecisionSource?: CoordinationMessageRefV1; signal?: AbortSignal }>) => Promise<unknown>;
  update: (input: Readonly<{ artifactId: string; expectedRevision: WorkflowArtifactRevisionV1; header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1 | null; memoryDecisionSource?: CoordinationMessageRefV1; signal?: AbortSignal }>) => Promise<
    Readonly<{ ok: true; revision: WorkflowArtifactRevisionV1 }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
  delete: (artifactId: string, options?: Readonly<{ expectedRevision?: WorkflowArtifactRevisionV1; signal?: AbortSignal; onTransportIssued?: () => void }>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
}>;
type Store = WorkflowDefinitionArtifactOperations;
type CreateInput = z.infer<typeof WorkflowDefinitionCreateRequestV1Schema>;
type UpdateInput = z.infer<typeof WorkflowDefinitionUpdateRequestV1Schema>;
type Metadata = z.infer<typeof WorkflowDefinitionMetadataV1Schema>;
type ArtifactHeader = z.infer<typeof WorkflowDefinitionArtifactHeaderV1Schema>;

type DefinitionCaller = WorkflowActionExecuteArgs['context'];
const PLUGIN_WORKFLOW_CURSOR_PREFIX = WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1;

function normalize(definition: unknown, context?: WorkflowIngressContextV1,
  triggerEvents?: NonNullable<Parameters<typeof validateWorkflowDefinition>[1]>['triggerEvents']) {
  const validated = validateWorkflowDefinition(definition, { ...(context ? { context } : {}), ...(triggerEvents === undefined ? {} : { triggerEvents }) });
  if (!validated.valid || !validated.normalizedDefinition) {
    throw Object.assign(new Error('workflow_definition_invalid'), { code: 'invalid_input', details: { issues: validated.issues } });
  }
  return validated.normalizedDefinition;
}

function savedBy(caller?: DefinitionCaller): WorkflowDefinitionSavedByV1 | undefined {
  return artifactSavedByFromActionContextV1(caller);
}

function header(definitionId: string, revision: WorkflowArtifactRevisionV1, metadata: Metadata, definition: WorkflowDefinitionV1) {
  return WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId, revision, metadata,
    previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) });
}

function assertRevisionMatches(actual: WorkflowArtifactRevisionV1, expected: WorkflowArtifactRevisionV1) {
  if (actual.headerVersion !== expected.headerVersion || actual.bodyVersion !== expected.bodyVersion) {
    throw Object.assign(new Error('artifact_version_mismatch'), { code: 'currentness_conflict' });
  }
}

function headerMatchesArtifact(
  artifact: Readonly<{ artifactId: string; headerVersion: number; bodyVersion?: number }>,
  artifactHeader: ArtifactHeader,
): boolean {
  return workflowDefinitionArtifactSharingAdapterV1.canShare({
    artifactId: artifact.artifactId, header: artifactHeader, headerVersion: artifact.headerVersion,
    ...(artifact.bodyVersion === undefined ? {} : { revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }),
  });
}

function contentUnavailable(reason: WorkflowDefinitionContentUnavailableReasonV1) {
  const code = workflowStoredContentReadErrorCodeV1({ kind: reason === 'history_not_readable' ? 'payloadInvalid' : 'contentInvalid' });
  return Object.assign(new Error('workflow_definition_content_unavailable'), { code,
    details: { reason: code === 'history_not_readable' ? code : reason } });
}

function openDefinitionBody(body: ArtifactBodyV1 | null | undefined): WorkflowDefinitionV1 {
  if (body === null || body === undefined) throw contentUnavailable('missing_body');
  if (typeof body !== 'string') throw contentUnavailable('invalid_body');
  let candidate: unknown;
  try { candidate = JSON.parse(body); } catch { throw contentUnavailable('invalid_body'); }
  const parsedBody = WorkflowDefinitionArtifactBodyV1ReadSchema.safeParse(candidate);
  if (!parsedBody.success) throw contentUnavailable('history_not_readable');
  const validation = validateWorkflowDefinition(parsedBody.data.definition);
  if (!validation.valid || !validation.normalizedDefinition) throw contentUnavailable('history_not_readable');
  return validation.normalizedDefinition;
}

export function createWorkflowDefinitionActions(params: Readonly<{
  artifactStore: Store;
  encodeListCursor: (row: WorkflowDefinitionArtifactHeaderRow) => string;
  /** Host-specific Account admission, in addition to the canonical Agent policy below. */
  assertDefinitionWriteAllowed?: (definition: WorkflowDefinitionV1, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => void | Promise<void>;
  resolveMaterializer?: (target: Readonly<{ machineId: string; directory: string; signal?: AbortSignal }>) => Promise<Pick<MaterializeWorkflowAcceptedSnapshotV1Input, 'effects' | 'roleSelection'>>;
  removeWorkflowTriggers?: (definitionId: string, signal?: AbortSignal) => Promise<void>;
  readPluginWorkflows?: WorkflowPluginSourceReaderV1;
  readWorkflowTriggerSummaries?: ReturnType<typeof createWorkflowTriggerActions>['readWorkflowSummaries'];
  readWorkflowTriggerEvents?: ReturnType<typeof createWorkflowTriggerActions>['readWorkflowTriggerEvents'];
}>) {
  const normalizeForSave = async (input: Readonly<{ definitionId: string; definition: unknown;
    intendedTriggers?: CreateInput['intendedTriggers'] }>, context?: WorkflowIngressContextV1) => {
    const definition = normalize(input.definition, context);
    if (collectWorkflowTriggerEventReferencesV1(definition).length === 0) return definition;
    if (!params.readWorkflowTriggerEvents) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    const triggerEvents = await params.readWorkflowTriggerEvents({ workflow: input.definitionId,
      ...(input.intendedTriggers === undefined ? {} : { intendedTriggers: input.intendedTriggers }) });
    return normalize(definition, context, triggerEvents);
  };
  const assertWriteAllowed = async (definition: WorkflowDefinitionV1, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
    const unavailable = () => Object.assign(new Error('definition_exceeds_authority'), {
      code: 'definition_exceeds_authority', details: { code: 'definition_exceeds_authority', cause: { code: 'target_unavailable' } },
    });
    // Missing caller wiring must never acquire the unrestricted human path.
    if (!caller || !caller.surface && caller.authority !== 'present_user' && caller.actionCaller?.kind !== 'host') throw unavailable();
    await params.assertDefinitionWriteAllowed?.(definition, context, caller);
    if (!isWorkflowTriggerAgentCallerV1(caller)) return;
    const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(caller.sessionAgentSpawnPolicyV1);
    const authority = caller.agentStartContext;
    if (!policy.success || !authority || !params.resolveMaterializer) throw unavailable();
    const { machineId, directory } = authority.baseline;
    const originSessionId = authority.caller.kind === 'session'
      ? authority.caller.sessionId
      : authority.caller.kind === 'originless' ? authority.caller.runOriginSessionId : undefined;
    const materialization = await params.resolveMaterializer({ machineId, directory,
      ...(caller.signal ? { signal: caller.signal } : {}) });
    const materialized = await materializeWorkflowDefinitionAuthorityV1({
      definition, ...(context ? { ingressContext: context } : {}), ...materialization,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
        origin: { kind: 'direct', ...(originSessionId ? { originSessionId } : {}) },
        authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw Object.assign(new Error(materialized.error.code), {
      code: materialized.error.code, details: materialized.error,
    });
    const sourceKeys = new Set(materialized.agentStartLeaves.map(leaf => leaf.sourceKey ?? '$root'));
    // Fieldless Actions and Waits still carry a Workflow permission ceiling.
    if (sourceKeys.size === 0) sourceKeys.add('$root');
    for (const sourceKey of sourceKeys) {
      const roles = { ...authority.roles };
      for (const leaf of materialized.materializedLeaves) {
        if (leaf.sourceKey === sourceKey && leaf.role) roles[leaf.role.roleId] = leaf.role;
      }
      const admission = admitAgentStartV1(policy.data, { kind: 'definition_write', permissionCeiling: materialized.permissionCeiling,
        leaves: materialized.agentStartLeaves.filter(leaf => (leaf.sourceKey ?? '$root') === sourceKey),
      }, { ...authority, roles });
      if (!admission.ok) throw Object.assign(new Error(admission.refusal.code), {
        code: admission.refusal.code, details: admission.refusal,
      });
    }
  };
  const readPluginWorkflows: WorkflowPluginSourceReaderV1 = params.readPluginWorkflows ?? (() => []);
  const read = async ({ definitionId, signal }: Readonly<{ definitionId: string; signal?: AbortSignal }>) => {
    const artifact = await params.artifactStore.read(definitionId, signal ? { signal } : undefined);
    if (!artifact) throw contentUnavailable('not_found');
    const parsedHeader = WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(artifact.header);
    if (!parsedHeader.success) throw contentUnavailable('invalid_header');
    if (!headerMatchesArtifact({
      artifactId: artifact.artifactId,
      headerVersion: artifact.revision.headerVersion,
      bodyVersion: artifact.revision.bodyVersion,
    }, parsedHeader.data)) {
      throw contentUnavailable('revision_mismatch');
    }
    const definition = openDefinitionBody(artifact.body);
    return { definitionId, revision: artifact.revision, definition, metadata: parsedHeader.data.metadata, access: artifact.access,
      ...(artifact.provenance ? { savedBy: artifact.provenance.savedBy } : {}),
      ...(artifact.updatedAt === undefined ? {} : { savedAt: artifact.updatedAt }) };
  };
  const destinations = (definition: WorkflowDefinitionV1, options: Readonly<{ signal?: AbortSignal }> = {}) => resolveWorkflowDestinationsV1({ definition }, async ref => {
    try {
      const source = await resolveWorkflowDefinitionRefV1(ref, {
        readPluginWorkflows,
        readArtifact: (definitionId, readSignal) => read({ definitionId, ...(readSignal ? { signal: readSignal } : {}) }),
        ...(options.signal ? { signal: options.signal } : {}) });
      return source?.definition ?? null;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (normalizeWorkflowActionThrownError(error, undefined, true).errorCode === 'cancelled') throw error;
      return null;
    }
  });
  // A write receipt describes committed root content; execution discovery is a read concern.
  const receipt = (value: Awaited<ReturnType<typeof read>>) => ({ ...value,
    destinations: deriveWorkflowDestinationsV1({ definition: value.definition }) });
  const get = async (input: Readonly<{ definitionId: string; signal?: AbortSignal }>) => {
    const value = await read(input);
    return { ...value, destinations: await destinations(value.definition, input.signal ? { signal: input.signal } : {}) };
  };
  const save = async (input: Pick<UpdateInput, 'definitionId' | 'expectedRevision' | 'metadata'>, definition: WorkflowDefinitionV1,
    existing: Awaited<ReturnType<typeof read>>, caller?: DefinitionCaller) => {
    if (sameWorkflowDefinitionAuthoringContentV1(existing.definition, definition) && sameStrictJsonValue(existing.metadata, input.metadata)) return receipt(existing);
    const nextRevision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
    const result = await params.artifactStore.update({ artifactId: input.definitionId,
      expectedRevision: input.expectedRevision, header: header(input.definitionId, nextRevision, input.metadata, definition),
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), savedBy: savedBy(caller) });
    if (!result.ok) throw Object.assign(new Error(result.error), {
      code: result.errorCode === 'version_mismatch' ? 'currentness_conflict' : 'content_unavailable',
    });
    const actor = savedBy(caller);
    return { definitionId: input.definitionId, revision: result.revision, definition,
      destinations: deriveWorkflowDestinationsV1({ definition }), metadata: input.metadata, access: existing.access,
      ...(actor ? { savedBy: actor } : {}) };
  };
  return {
    readPluginWorkflows,
    importDocument: async (raw: z.infer<typeof WorkflowDefinitionImportRequestV1Schema>, context?: WorkflowIngressContextV1) => {
      const { json } = WorkflowDefinitionImportRequestV1Schema.parse(raw);
      const parsed = parseWorkflowDocumentJsonIngressV1(json, context);
      return WorkflowDefinitionImportResultV1Schema.parse(parsed.ok
        ? { ...parsed, classification: 'unsaved_definition' } : parsed);
    },
    exportDocument: async (raw: z.infer<typeof WorkflowDefinitionExportRequestV1Schema>, context?: WorkflowIngressContextV1) => {
      const input = WorkflowDefinitionExportRequestV1Schema.parse(raw);
      const saved = 'draft' in input ? null : await read(input);
      const definition = 'draft' in input ? normalize(input.draft, context) : saved!.definition;
      const document = { kind: 'happier.workflow' as const, version: 1 as const, definition };
      return { ...(saved === null ? {} : { definitionId: saved.definitionId, revision: saved.revision, metadata: saved.metadata }),
        document, json: serializeWorkflowDocumentJsonV1(document) };
    },
    list: async ({ limit, cursor: inputCursor, workflow, definitionId }: Readonly<{ cursor?: string; limit?: number; workflow?: string; definitionId?: string }>): Promise<WorkflowDefinitionListResultV1> => {
      const exactArtifactId = definitionId ?? (workflow !== undefined && parseWorkflowDefinitionRefV1(workflow)?.kind === 'artifact' ? workflow : undefined);
      if (workflow !== undefined && exactArtifactId === undefined) {
        const source = await resolveWorkflowPluginSourceV1(workflow, { readPluginWorkflows });
        return { definitions: [], pluginWorkflows: source === null ? [] : [source] };
      }
      const definitions: WorkflowDefinitionListResultV1['definitions'] = [];
      let definitionBytes = 0;
      const pluginPage = async (start: number) => {
        const sources = await readPluginWorkflows();
        const pluginWorkflows: WorkflowPluginSourceV1[] = [];
        let pluginBytes = 0;
        for (let index = start; index < sources.length; index += 1) {
          const source = sources[index]!;
          const sourceBytes = measureSerializedValidatedStrictPluginJsonUtf8Bytes(source, 'pluginWorkflow');
          const framing = { definitions: [], pluginWorkflows: [],
            ...(index + 1 < sources.length ? { nextCursor: `${PLUGIN_WORKFLOW_CURSOR_PREFIX}${index + 1}` } : {}) };
          const addedBytes = sourceBytes + (pluginWorkflows.length === 0 ? 0 : 1);
          if (measureExternalActionResultResponseEnvelopeUtf8BytesV1(framing) + definitionBytes + pluginBytes + addedBytes
            > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
            if (definitions.length === 0 && pluginWorkflows.length === 0) {
              throw Object.assign(new Error('workflow_definition_exceeds_action_response'), { code: 'content_unavailable' });
            }
            return { definitions, ...(pluginWorkflows.length ? { pluginWorkflows } : {}),
              nextCursor: `${PLUGIN_WORKFLOW_CURSOR_PREFIX}${index}` };
          }
          pluginWorkflows.push(source);
          pluginBytes += addedBytes;
        }
        return { definitions, ...(pluginWorkflows.length ? { pluginWorkflows } : {}) };
      };
      if (inputCursor && workflowDefinitionListCursorPhaseV1(inputCursor) !== 'artifacts') {
        const offset = inputCursor.slice(PLUGIN_WORKFLOW_CURSOR_PREFIX.length);
        if (!/^(0|[1-9]\d*)$/u.test(offset) || !Number.isSafeInteger(Number(offset))) {
          throw Object.assign(new Error('workflow_definition_cursor_invalid'), { code: 'invalid_input' });
        }
        return pluginPage(Number(offset));
      }
      // A library row is a summary: its header carries the authored step labels
      // (written atomically with the body), so the page reads no bodies. Only a
      // legacy header written before `previewSteps` opens its body, once.
      // Opaque Artifact cursor of the last returned row. A page shortened by the
      // response ceiling resumes here, so the first omitted row is read next.
      let replayCursor: string | undefined;
      let cursor = inputCursor;
      do {
        let page: Awaited<ReturnType<Store['list']>>;
        try {
          if (exactArtifactId !== undefined) {
            const artifact = await params.artifactStore.read(exactArtifactId);
            page = { items: artifact === null ? [] : [{ ...artifact,
              headerVersion: artifact.revision.headerVersion, bodyVersion: artifact.revision.bodyVersion,
              updatedAt: artifact.updatedAt ?? 0 }] };
          } else {
            page = await params.artifactStore.list({ limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, cursor, kind: 'workflow-definition.v1', coarseKind: 'other', includeBody: false });
          }
        } catch (error) {
          if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'invalid_cursor') {
            throw Object.assign(new Error('workflow_definition_cursor_invalid'), { code: 'invalid_input' });
          }
          throw error;
        }
        const demandedIds = page.items.filter(artifact => artifact.header.kind === 'workflow-definition.v1'
          && WorkflowDefinitionIdV1Schema.safeParse(artifact.artifactId).success)
          .slice(0, limit === undefined ? undefined : limit - definitions.length)
          // Noncanonical Artifact identities cannot be Automation references;
          // keep their display rows without poisoning neighboring summaries.
          .filter(artifact => parseWorkflowDefinitionRefV1(artifact.artifactId)?.kind === 'artifact')
          .map(artifact => artifact.artifactId);
        let triggerSummaries: Awaited<ReturnType<NonNullable<typeof params.readWorkflowTriggerSummaries>>> | undefined;
        let triggerSummaryErrorCode: WorkflowDefinitionListResultV1['definitions'][number]['triggerSummaryErrorCode'];
        if (demandedIds.length > 0) {
          try {
            if (!params.readWorkflowTriggerSummaries) {
              throw Object.assign(new Error('workflow_trigger_summary_unavailable'), { code: 'target_unavailable' });
            }
            triggerSummaries = await params.readWorkflowTriggerSummaries(demandedIds);
          } catch (error) {
            // Authorized Artifact content does not depend on scheduler enrichment.
            // Preserve the typed failure and never retry with an unfiltered census.
            const failure = normalizeWorkflowActionThrownError(error, undefined, true);
            if (failure.errorCode === 'cancelled') throw error;
            triggerSummaryErrorCode = failure.errorCode;
          }
        }
        const listedRows = page.items.filter(artifact => artifact.header.kind === 'workflow-definition.v1'
          && WorkflowDefinitionIdV1Schema.safeParse(artifact.artifactId).success)
          .slice(0, limit === undefined ? undefined : limit - definitions.length)
          .map(artifact => {
            const parsed = WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(artifact.header);
            const readableHeader = parsed.success && headerMatchesArtifact({
              artifactId: artifact.artifactId,
              headerVersion: artifact.headerVersion,
              bodyVersion: artifact.bodyVersion,
            }, parsed.data) ? parsed.data : null;
            return { artifact, parsed, readableHeader };
          });
        // Every listed legacy body of the page is opened together, so the store's batch
        // owner answers them in one read instead of one round trip per row.
        const legacyOpenings = new Map(exactArtifactId !== undefined ? [] : listedRows
          .filter(({ artifact, readableHeader }) => readableHeader && artifact.bodyVersion !== undefined && readableHeader.previewSteps === undefined)
          .map(({ artifact }) => [artifact.artifactId, read({ definitionId: artifact.artifactId }).then(
            opened => ({ ok: true as const, definition: opened.definition }),
            (error: unknown) => ({ ok: false as const, error }))] as const));
        for (const { artifact, parsed, readableHeader } of listedRows) {
          const identity = WorkflowDefinitionIdV1Schema.safeParse(artifact.artifactId);
          if (!identity.success) continue;
          let stepCount: number | null = null;
          let reason: WorkflowDefinitionContentUnavailableReasonV1 = readableHeader ? 'missing_body'
            : parsed.success ? 'revision_mismatch' : 'invalid_header';
          if (readableHeader && artifact.bodyVersion !== undefined) {
            if (readableHeader.previewSteps !== undefined) stepCount = readableHeader.previewSteps.length;
            else {
              try {
                // An exact read already carries its body; a listed legacy row opens it through `read`.
                const opened = exactArtifactId !== undefined ? openDefinitionBody(artifact.body) : await (async () => {
                  const legacy = await legacyOpenings.get(artifact.artifactId)!;
                  if (!legacy.ok) throw legacy.error;
                  return legacy.definition;
                })();
                stepCount = countWorkflowStepsV1(opened.blocks);
              } catch (error) {
                // Only this record's validated content failure is isolated. Transport,
                // authorization, currentness and Account-mode errors stay at their owners.
                if (!error || typeof error !== 'object'
                  || (Reflect.get(error, 'code') !== 'content_unavailable' && Reflect.get(error, 'code') !== 'history_not_readable')) throw error;
                const detail = Reflect.get(error, 'details');
                const cause = WorkflowDefinitionContentUnavailableReasonV1Schema.safeParse(detail && typeof detail === 'object' ? Reflect.get(detail, 'reason') : undefined);
                reason = cause.success ? cause.data : 'invalid_body';
              }
            }
          }
          const summary = triggerSummaries?.get(artifact.artifactId);
          const facts = {
            ownerAccountId: artifact.ownerAccountId, access: artifact.access,
            ...(artifact.sharedTeamIds === undefined ? {} : { sharedTeamIds: [...artifact.sharedTeamIds] }),
            updatedAt: artifact.updatedAt,
            ...(artifact.provenance ? { savedBy: artifact.provenance.savedBy } : {}),
            triggers: [...(summary?.triggers ?? [])], nextRunAt: summary?.nextRunAt ?? null,
            ...(triggerSummaryErrorCode === undefined ? {} : { triggerSummaryErrorCode }),
          };
          // Rejected header bytes remain rejected. List presentation uses the
          // authorized Artifact identity/revision and only validated display facts;
          // absent facts are explicit, never a repaired stored header or readable body.
          const physicalRevision = WorkflowArtifactRevisionV1Schema.safeParse({
            headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion,
          });
          const displayMetadata = WorkflowDefinitionArtifactHeaderV1ReadSchema.shape.metadata.safeParse(artifact.header.metadata);
          // Destinations and the body are a definition's detail: `get` resolves them when it is opened.
          const definition: WorkflowDefinitionListResultV1['definitions'][number] = stepCount !== null && readableHeader
            ? { ...readableHeader, ...facts, contentStatus: 'available', stepCount }
            : { kind: 'workflow-definition.v1', definitionId: identity.data,
              revision: readableHeader?.revision ?? (physicalRevision.success ? physicalRevision.data : null),
              metadata: displayMetadata.success ? displayMetadata.data : null, ...facts,
              contentStatus: 'unavailable', stepCount: null, contentUnavailableReason: reason };
          const isExhaustedAtPageEnd = page.items.at(-1)?.artifactId === artifact.artifactId && !page.nextCursor;
          const rowCursor = exactArtifactId === undefined ? params.encodeListCursor(artifact) : undefined;
          // Measure each row once, including commas, then add the exact empty
          // page framing. Resizing every accumulated prefix made a library
          // refresh quadratic while Start was trying to publish its Run.
          const nextCursor = exactArtifactId !== undefined ? undefined : isExhaustedAtPageEnd
            ? (params.readPluginWorkflows ? `${PLUGIN_WORKFLOW_CURSOR_PREFIX}0` : undefined) : rowCursor;
          const continuation = nextCursor ? { nextCursor } : {};
          const addedBytes = measureSerializedValidatedStrictPluginJsonUtf8Bytes(definition, 'workflowDefinition')
            + (definitions.length === 0 ? 0 : 1);
          if (measureExternalActionResultResponseEnvelopeUtf8BytesV1({ definitions: [], ...continuation }) + definitionBytes + addedBytes
            > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
            if (replayCursor === undefined) {
              throw Object.assign(new Error('workflow_definition_header_exceeds_action_response'), { code: 'content_unavailable' });
            }
            return { definitions, nextCursor: replayCursor };
          }
          definitions.push(definition);
          definitionBytes += addedBytes;
          replayCursor = rowCursor;
          if (limit !== undefined && definitions.length >= limit) return { definitions, ...continuation };
        }
        cursor = page.nextCursor;
      } while (cursor);
      // Do not let a slow/offline daemon gate readable Account rows. Existing
      // opaque continuation carries plugin discovery, including an empty phase.
      return { definitions, ...(exactArtifactId === undefined && params.readPluginWorkflows ? { nextCursor: `${PLUGIN_WORKFLOW_CURSOR_PREFIX}0` } : {}) };
    },
    get,
    create: async (input: CreateInput, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
      const definition = await normalizeForSave(input, context);
      await assertWriteAllowed(definition, context, caller);
      const existingArtifact = await params.artifactStore.read(input.definitionId);
      if (existingArtifact) {
        const existing = await read({ definitionId: input.definitionId });
        if (sameWorkflowDefinitionAuthoringContentV1(existing.definition, definition)
          && sameStrictJsonValue(existing.metadata, input.metadata)) return receipt(existing);
        throw Object.assign(new Error('workflow_definition_create_conflict'), { code: 'currentness_conflict' });
      }
      const initialRevision = { headerVersion: 1, bodyVersion: 1 };
      try {
        await params.artifactStore.create({ artifactId: input.definitionId,
          header: header(input.definitionId, initialRevision, input.metadata, definition),
          body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), savedBy: savedBy(caller) });
      } catch (error) {
        // A lost response or same-id race may have committed the Artifact.
        // Rejoin only its exact normalized semantic content; an absent row
        // leaves the original transport failure intact.
        const committed = await params.artifactStore.read(input.definitionId);
        if (!committed) {
          if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'conflict') {
            throw Object.assign(new Error('workflow_definition_create_conflict'), { code: 'currentness_conflict' });
          }
          throw error;
        }
      }
      const accepted = await read({ definitionId: input.definitionId });
      if (!sameWorkflowDefinitionAuthoringContentV1(accepted.definition, definition)
        || !sameStrictJsonValue(accepted.metadata, input.metadata)) {
        throw Object.assign(new Error('workflow_definition_create_conflict'), { code: 'currentness_conflict' });
      }
      return receipt(accepted);
    },
    update: async (input: UpdateInput, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
      const definition = await normalizeForSave(input, context);
      await assertWriteAllowed(definition, context, caller);
      const existing = await read({ definitionId: input.definitionId });
      assertRevisionMatches(existing.revision, input.expectedRevision);
      return save(input, definition, existing, caller);
    },
    edit: async (input: WorkflowDefinitionEditRequestV1, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
      const existing = await read({ definitionId: input.definitionId });
      assertRevisionMatches(existing.revision, input.expectedRevision);
      const edited = applyWorkflowDefinitionEditsV1({ ...existing.definition, name: existing.metadata.title }, input.ops);
      if (!edited.ok) {
        throw Object.assign(new Error('workflow_definition_edit_invalid'), {
          code: 'invalid_input', details: { issues: [{ code: edited.issue.code, path: ['ops', edited.issue.opIndex] }] },
        });
      }
      const { name, ...candidate } = edited.draft;
      const definition = await normalizeForSave({ definitionId: input.definitionId, definition: candidate }, context);
      await assertWriteAllowed(definition, context, caller);
      const saved = await save({ definitionId: input.definitionId, expectedRevision: input.expectedRevision,
        metadata: { ...existing.metadata, title: name } }, definition, existing, caller);
      return { definition: saved.definition, revision: saved.revision, metadata: saved.metadata, changedBlockIds: [...edited.changedBlockIds] };
    },
    delete: async ({ definitionId }: Readonly<{ definitionId: string }>, caller?: DefinitionCaller) => {
      const artifact = await params.artifactStore.read(definitionId);
      const parsedHeader = artifact ? WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(artifact.header) : null;
      if (!artifact || !parsedHeader?.success) {
        throw Object.assign(new Error('workflow_definition_not_found'), { code: 'content_unavailable' });
      }
      // Shared read/edit/admin access never grants Artifact ownership.
      if (artifact.access !== 'owner') {
        throw Object.assign(new Error('workflow_definition_delete_forbidden'), { code: 'artifact_access_forbidden' });
      }
      await params.removeWorkflowTriggers?.(definitionId, caller?.signal);
      const result = await params.artifactStore.delete(definitionId, {
        ...(caller?.signal ? { signal: caller.signal } : {}),
        ...(caller?.onTransportIssued ? { onTransportIssued: caller.onTransportIssued } : {}),
      });
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
      return { deleted: true as const, definitionId };
    },
  };
}
