import {
  WorkflowDefinitionArtifactBodyV1ReadSchema,
  WorkflowDefinitionArtifactHeaderV1Schema,
  WorkflowDefinitionArtifactHeaderV1ReadSchema,
  WorkflowDefinitionMetadataV1Schema,
  WorkflowArtifactRevisionV1Schema,
  type WorkflowArtifactRevisionV1,
  type WorkflowDefinitionSavedByV1,
  type WorkflowDefinitionContentUnavailableReasonV1,
} from '../../workflows/workflowDefinitionV1.js';
import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionUpdateRequestV1Schema,
  type WorkflowDefinitionListResultV1 } from '../../workflows/actionsV1.js';
import { applyWorkflowDefinitionEditsV1, countWorkflowStepsV1, type WorkflowDefinitionEditRequestV1 } from '../../workflows/workflowDefinitionEditV1.js';
import { workflowDefinitionPreviewStepsV1 } from '../../workflows/workflowStepLabel.js';
import type { createWorkflowTriggerActions } from './workflowTriggerActions.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { WorkflowDefinitionV1, WorkflowIngressContextV1 } from '../../workflows/workflowV1.js';
import type { WorkflowActionExecuteArgs } from './types.js';
import type { z } from 'zod';
import type { ArtifactCallerAccessV1 } from '../../artifacts/artifactAccessV1.js';
import { artifactSavedByFromActionContextV1, type ArtifactBodyV1, type ArtifactRevisionProvenanceV1, type ArtifactSavedByV1 } from '../../artifacts/artifactBinaryV1.js';
import { workflowDefinitionArtifactSharingAdapterV1 } from '../../artifacts/artifactSharingV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { WorkflowDefinitionIdV1Schema } from '../../workflows/workflowIdsV1.js';
import type { WorkflowPluginSourceReaderV1, WorkflowPluginSourceV1 } from '../../workflows/workflowPluginSourceV1.js';
import { resolveWorkflowDestinationsV1 } from '../../workflows/workflowDestinationsV1.js';
import { resolveWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionResolverV1.js';

export type WorkflowDefinitionArtifactHeaderRow = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; headerVersion: number; updatedAt: number;
  ownerAccountId: string; access: ArtifactCallerAccessV1;
  body?: ArtifactBodyV1 | null; bodyVersion?: number;
  provenance?: ArtifactRevisionProvenanceV1;
}>;
export type WorkflowDefinitionArtifactOperations = Readonly<{
  read: (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<Readonly<{
    artifactId: string; header: Readonly<Record<string, unknown>>; body: ArtifactBodyV1 | null; revision: WorkflowArtifactRevisionV1;
    ownerAccountId: string; access: ArtifactCallerAccessV1;
    provenance?: ArtifactRevisionProvenanceV1;
  }> | null>;
  list: (options: Readonly<{ limit?: number; cursor?: string; includeBody?: boolean; signal?: AbortSignal }>) => Promise<Readonly<{
    items: readonly WorkflowDefinitionArtifactHeaderRow[]; nextCursor?: string;
  }>>;
  create: (input: Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1; signal?: AbortSignal }>) => Promise<unknown>;
  update: (input: Readonly<{ artifactId: string; expectedRevision: WorkflowArtifactRevisionV1; header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1; signal?: AbortSignal }>) => Promise<
    Readonly<{ ok: true; revision: WorkflowArtifactRevisionV1 }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
  delete: (artifactId: string, options?: Readonly<{ expectedRevision?: WorkflowArtifactRevisionV1; signal?: AbortSignal }>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
}>;
type Store = WorkflowDefinitionArtifactOperations;
type CreateInput = z.infer<typeof WorkflowDefinitionCreateRequestV1Schema>;
type UpdateInput = z.infer<typeof WorkflowDefinitionUpdateRequestV1Schema>;
type Metadata = z.infer<typeof WorkflowDefinitionMetadataV1Schema>;
type ArtifactHeader = z.infer<typeof WorkflowDefinitionArtifactHeaderV1Schema>;

type DefinitionCaller = WorkflowActionExecuteArgs['context'];
// Account Artifact cursors encode a JSON object as base64url (and start `ey`).
// This reserved base64url-safe phase continues the same list after its headers.
const PLUGIN_WORKFLOW_CURSOR_PREFIX = 'plugin-workflows_';

function normalize(definition: unknown, context?: WorkflowIngressContextV1) {
  const validated = validateWorkflowDefinition(definition, context ? { context } : {});
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
  return Object.assign(new Error('workflow_definition_content_unavailable'), { code: 'content_unavailable', details: { reason } });
}

function openDefinitionBody(body: ArtifactBodyV1 | null | undefined): WorkflowDefinitionV1 {
  if (body === null || body === undefined) throw contentUnavailable('missing_body');
  if (typeof body !== 'string') throw contentUnavailable('invalid_body');
  let candidate: unknown;
  try { candidate = JSON.parse(body); } catch { throw contentUnavailable('invalid_body'); }
  const parsedBody = WorkflowDefinitionArtifactBodyV1ReadSchema.safeParse(candidate);
  if (!parsedBody.success) throw contentUnavailable('invalid_body');
  const validation = validateWorkflowDefinition(parsedBody.data.definition);
  if (!validation.valid || !validation.normalizedDefinition) throw contentUnavailable('invalid_body');
  return validation.normalizedDefinition;
}

export function createWorkflowDefinitionActions(params: Readonly<{
  artifactStore: Store;
  encodeListCursor: (row: WorkflowDefinitionArtifactHeaderRow) => string;
  assertDefinitionWriteAllowed: (definition: WorkflowDefinitionV1, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => void | Promise<void>;
  removeWorkflowTriggers?: (definitionId: string) => Promise<void>;
  readPluginWorkflows?: WorkflowPluginSourceReaderV1;
  readWorkflowTriggerSummaries?: ReturnType<typeof createWorkflowTriggerActions>['readWorkflowSummaries'];
}>) {
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
      ...(artifact.provenance ? { savedBy: artifact.provenance.savedBy } : {}) };
  };
  const destinations = (definition: WorkflowDefinitionV1, signal?: AbortSignal) => resolveWorkflowDestinationsV1({ definition }, async ref => {
    const source = await resolveWorkflowDefinitionRefV1(ref, { readPluginWorkflows,
      readArtifact: (definitionId, readSignal) => read({ definitionId, ...(readSignal ? { signal: readSignal } : {}) }),
      ...(signal ? { signal } : {}) });
    return source?.definition ?? null;
  });
  const get = async (input: Readonly<{ definitionId: string; signal?: AbortSignal }>) => {
    const value = await read(input);
    return { ...value, destinations: await destinations(value.definition, input.signal) };
  };
  const save = async (input: Pick<UpdateInput, 'definitionId' | 'expectedRevision' | 'metadata'>, definition: WorkflowDefinitionV1, access: ArtifactCallerAccessV1, caller?: DefinitionCaller) => {
    const nextRevision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
    const result = await params.artifactStore.update({ artifactId: input.definitionId,
      expectedRevision: input.expectedRevision, header: header(input.definitionId, nextRevision, input.metadata, definition),
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), savedBy: savedBy(caller) });
    if (!result.ok) throw Object.assign(new Error(result.error), {
      code: result.errorCode === 'version_mismatch' ? 'currentness_conflict' : 'content_unavailable',
    });
    const actor = savedBy(caller);
    return { definitionId: input.definitionId, revision: result.revision, definition, destinations: await destinations(definition), metadata: input.metadata, access,
      ...(actor ? { savedBy: actor } : {}) };
  };
  return {
    readPluginWorkflows,
    list: async ({ limit, cursor: inputCursor }: Readonly<{ cursor?: string; limit?: number }>): Promise<WorkflowDefinitionListResultV1> => {
      const sources = await readPluginWorkflows();
      const definitions: WorkflowDefinitionListResultV1['definitions'] = [];
      let triggerSummaries: Awaited<ReturnType<NonNullable<typeof params.readWorkflowTriggerSummaries>>> | undefined;
      const pluginPage = (start: number) => {
        const pluginWorkflows: WorkflowPluginSourceV1[] = [];
        for (let index = start; index < sources.length; index += 1) {
          const candidate = { definitions, pluginWorkflows: [...pluginWorkflows, sources[index]!],
            ...(index + 1 < sources.length ? { nextCursor: `${PLUGIN_WORKFLOW_CURSOR_PREFIX}${index + 1}` } : {}) };
          if (measureExternalActionResultResponseEnvelopeUtf8BytesV1(candidate) > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
            if (definitions.length === 0 && pluginWorkflows.length === 0) {
              throw Object.assign(new Error('workflow_definition_exceeds_action_response'), { code: 'content_unavailable' });
            }
            return { definitions, ...(pluginWorkflows.length ? { pluginWorkflows } : {}),
              nextCursor: `${PLUGIN_WORKFLOW_CURSOR_PREFIX}${index}` };
          }
          pluginWorkflows.push(sources[index]!);
        }
        return { definitions, ...(pluginWorkflows.length ? { pluginWorkflows } : {}) };
      };
      if (inputCursor?.startsWith(PLUGIN_WORKFLOW_CURSOR_PREFIX)) {
        const offset = inputCursor.slice(PLUGIN_WORKFLOW_CURSOR_PREFIX.length);
        if (!/^(0|[1-9]\d*)$/u.test(offset) || !Number.isSafeInteger(Number(offset))) {
          throw Object.assign(new Error('workflow_definition_cursor_invalid'), { code: 'invalid_input' });
        }
        return pluginPage(Number(offset));
      }
      // Opaque Artifact cursor of the last returned row. A page shortened by the
      // response ceiling resumes here, so the first omitted row is read next.
      let replayCursor: string | undefined;
      let cursor = inputCursor;
      do {
        let page: Awaited<ReturnType<Store['list']>>;
        try {
          page = await params.artifactStore.list({ limit: 500, cursor, includeBody: true });
        } catch (error) {
          if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'invalid_cursor') {
            throw Object.assign(new Error('workflow_definition_cursor_invalid'), { code: 'invalid_input' });
          }
          throw error;
        }
        for (const artifact of page.items) {
          if (artifact.header.kind !== 'workflow-definition.v1') continue;
          const identity = WorkflowDefinitionIdV1Schema.safeParse(artifact.artifactId);
          if (!identity.success) continue;
          const parsed = WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(artifact.header);
          const readableHeader = parsed.success && headerMatchesArtifact({
            artifactId: artifact.artifactId,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
          }, parsed.data) ? parsed.data : null;
          if (!triggerSummaries) {
            if (!params.readWorkflowTriggerSummaries) {
              throw Object.assign(new Error('workflow_trigger_summary_unavailable'), { code: 'target_unavailable' });
            }
            triggerSummaries = await params.readWorkflowTriggerSummaries();
          }
          let opened: WorkflowDefinitionV1 | null = null;
          let reason: WorkflowDefinitionContentUnavailableReasonV1 = readableHeader ? 'missing_body'
            : parsed.success ? 'revision_mismatch' : 'invalid_header';
          try {
            if (readableHeader && artifact.bodyVersion !== undefined) opened = openDefinitionBody(artifact.body);
          } catch (error) {
            // Only this record's validated content failure is isolated. Transport,
            // authorization, currentness and Account-mode errors stay at their owners.
            if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'content_unavailable') throw error;
            reason = artifact.body == null ? 'missing_body' : 'invalid_body';
          }
          const summary = triggerSummaries.get(artifact.artifactId);
          const facts = {
            ownerAccountId: artifact.ownerAccountId, access: artifact.access,
            ...(artifact.provenance ? { savedBy: artifact.provenance.savedBy } : {}),
            triggers: [...(summary?.triggers ?? [])], nextRunAt: summary?.nextRunAt ?? null,
          };
          // Rejected header bytes remain rejected. List presentation uses the
          // authorized Artifact identity/revision and only validated display facts;
          // absent facts are explicit, never a repaired stored header or readable body.
          const physicalRevision = WorkflowArtifactRevisionV1Schema.safeParse({
            headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion,
          });
          const displayMetadata = WorkflowDefinitionArtifactHeaderV1ReadSchema.shape.metadata.safeParse(artifact.header.metadata);
          const definition: WorkflowDefinitionListResultV1['definitions'][number] = opened && readableHeader
            ? { ...readableHeader, ...facts, contentStatus: 'available', stepCount: countWorkflowStepsV1(opened.blocks),
              destinations: await destinations(opened) }
            : { kind: 'workflow-definition.v1', definitionId: identity.data,
              revision: readableHeader?.revision ?? (physicalRevision.success ? physicalRevision.data : null),
              metadata: displayMetadata.success ? displayMetadata.data : null, ...facts,
              contentStatus: 'unavailable', stepCount: null, contentUnavailableReason: reason };
          const isExhaustedAtPageEnd = page.items.at(-1)?.artifactId === artifact.artifactId && !page.nextCursor;
          const rowCursor = params.encodeListCursor(artifact);
          // Size the exact page this row could close, inside the complete public
          // response framing, so the outer envelope owner never has to replace a
          // completed list with `result_too_large`.
          const nextCursor = isExhaustedAtPageEnd
            ? (sources.length ? `${PLUGIN_WORKFLOW_CURSOR_PREFIX}0` : undefined) : rowCursor;
          const candidate = { definitions: [...definitions, definition], ...(nextCursor ? { nextCursor } : {}) };
          if (measureExternalActionResultResponseEnvelopeUtf8BytesV1(candidate) > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
            if (replayCursor === undefined) {
              throw Object.assign(new Error('workflow_definition_header_exceeds_action_response'), { code: 'content_unavailable' });
            }
            return { definitions, nextCursor: replayCursor };
          }
          definitions.push(definition);
          replayCursor = rowCursor;
          if (limit !== undefined && definitions.length >= limit) return candidate;
        }
        cursor = page.nextCursor;
      } while (cursor);
      return pluginPage(0);
    },
    get,
    create: async (input: CreateInput, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
      const definition = normalize(input.definition, context);
      await params.assertDefinitionWriteAllowed(definition, context, caller);
      const existingArtifact = await params.artifactStore.read(input.definitionId);
      if (existingArtifact) {
        const existing = await get({ definitionId: input.definitionId });
        if (sameStrictJsonValue(existing.definition, definition)
          && sameStrictJsonValue(existing.metadata, input.metadata)) return existing;
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
      const accepted = await get({ definitionId: input.definitionId });
      if (!sameStrictJsonValue(accepted.definition, definition)
        || !sameStrictJsonValue(accepted.metadata, input.metadata)) {
        throw Object.assign(new Error('workflow_definition_create_conflict'), { code: 'currentness_conflict' });
      }
      return accepted;
    },
    update: async (input: UpdateInput, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
      const definition = normalize(input.definition, context);
      await params.assertDefinitionWriteAllowed(definition, context, caller);
      const existing = await get({ definitionId: input.definitionId });
      assertRevisionMatches(existing.revision, input.expectedRevision);
      return save(input, definition, existing.access, caller);
    },
    edit: async (input: WorkflowDefinitionEditRequestV1, context?: WorkflowIngressContextV1, caller?: DefinitionCaller) => {
      const existing = await get({ definitionId: input.definitionId });
      assertRevisionMatches(existing.revision, input.expectedRevision);
      const edited = applyWorkflowDefinitionEditsV1({ ...existing.definition, name: existing.metadata.title }, input.ops);
      if (!edited.ok) {
        throw Object.assign(new Error('workflow_definition_edit_invalid'), {
          code: 'invalid_input', details: { issues: [{ code: edited.issue.code, path: ['ops', edited.issue.opIndex] }] },
        });
      }
      const { name, ...candidate } = edited.draft;
      const definition = normalize(candidate, context);
      await params.assertDefinitionWriteAllowed(definition, context, caller);
      const saved = await save({ definitionId: input.definitionId, expectedRevision: input.expectedRevision,
        metadata: { ...existing.metadata, title: name } }, definition, existing.access, caller);
      return { definition: saved.definition, revision: saved.revision, metadata: saved.metadata, changedBlockIds: [...edited.changedBlockIds] };
    },
    delete: async ({ definitionId }: Readonly<{ definitionId: string }>) => {
      const artifact = await params.artifactStore.read(definitionId);
      const parsedHeader = artifact ? WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(artifact.header) : null;
      if (!artifact || !parsedHeader?.success) {
        throw Object.assign(new Error('workflow_definition_not_found'), { code: 'content_unavailable' });
      }
      // Shared read/edit/admin access never grants Artifact ownership.
      if (artifact.access !== 'owner') {
        throw Object.assign(new Error('workflow_definition_delete_forbidden'), { code: 'artifact_access_forbidden' });
      }
      // The Artifact owner deletes by id without a revision precondition, so a
      // header that names another definition or a stale revision must be as
      // unreadable here as it is for get/list before anything is destroyed.
      if (!headerMatchesArtifact({
        artifactId: artifact.artifactId,
        headerVersion: artifact.revision.headerVersion,
        bodyVersion: artifact.revision.bodyVersion,
      }, parsedHeader.data)) {
        throw Object.assign(new Error('workflow_definition_content_unavailable'), { code: 'content_unavailable' });
      }
      await params.removeWorkflowTriggers?.(definitionId);
      const result = await params.artifactStore.delete(definitionId);
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
      return { deleted: true as const, definitionId };
    },
  };
}
