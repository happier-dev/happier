import {
  parseWorkflowDocumentJsonIngressV1,
  serializeWorkflowDocumentJsonV1,
  type WorkflowDocumentV1,
  type WorkflowDocumentParseResultV1,
} from '@happier-dev/protocol/workflows/workflowDocumentV1';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import type {
  WorkflowDefinitionV1,
  WorkflowIngressContextV1,
  WorkflowValidationIssue,
} from '@happier-dev/protocol/workflows/workflowV1';

import type { TranslationKeyNoParams } from '@/text';

import {
  buildWorkflowEditorDraftFromDefinition,
  firstBlockingWorkflowIssue,
  validateWorkflowEditorDraft,
} from './workflowAuthoring';
import type { WorkflowEditorDraft } from './workflowEditorDraft';
import { WorkflowDefinitionImportResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { callWorkflowAction } from './callWorkflowAction';

/**
 * JSON interchange for authored workflows.
 *
 * This is an adapter, not a parser: Protocol's ingress-aware document parser
 * owns the envelope and delegates definition normalization to the canonical
 * workflow validator, exactly as save and run admission do. Mounted import
 * delegates through the shared Action front door; local draft tools retain
 * the pure codec and draft projection. The platform file, share and download
 * boundary stays with the caller.
 *
 * Import opens an unsaved review draft. It never runs, schedules, saves or
 * creates an Artifact, and a failed import returns the caller's draft
 * unchanged so a bad file cannot destroy open work.
 */

export type WorkflowImportFailureCode =
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_document'
  | 'invalid_definition';

export type WorkflowImportResult =
  | Readonly<{
    ok: true;
    /** A fresh unsaved review draft. Never the caller's `currentDraft`. */
    draft: WorkflowEditorDraft;
    definition: WorkflowDefinitionV1;
  }>
  | Readonly<{
    ok: false;
    code: WorkflowImportFailureCode;
    /**
     * The authored envelope-failure copy, or `null` for `invalid_definition`,
     * where the canonical issues below are the message and the editor points
     * at each `path` with the existing `workflows.issue.<code>` copy.
     */
    messageKey: TranslationKeyNoParams | null;
    issues: readonly WorkflowValidationIssue[];
    /** The unchanged `currentDraft`, by identity. */
    draft: WorkflowEditorDraft;
    /**
     * Canonically normalized material that may be opened only for repair.
     * Structural parse failures have no normalized definition and therefore
     * never expose a draft that could silently discard unknown input.
     */
    repairDraft?: WorkflowEditorDraft;
  }>;

export type WorkflowExportResult =
  | Readonly<{ ok: true; json: string; document: WorkflowDocumentV1 }>
  | Readonly<{
    ok: false;
    issues: readonly WorkflowValidationIssue[];
    blockingIssue: WorkflowValidationIssue | null;
  }>;

function serializeValidatedWorkflowDefinition(
  definition: WorkflowDefinitionV1,
): Extract<WorkflowExportResult, Readonly<{ ok: true }>> {
  const document: WorkflowDocumentV1 = { kind: 'happier.workflow', version: 1, definition };
  return { ok: true, document, json: serializeWorkflowDocumentJsonV1(document) };
}

/**
 * The authored note the caller shows before sharing an exported file. The
 * definition schema already excludes credentials, staged media and every
 * runtime-only field, so this previews a consequence rather than describing a
 * filter.
 */
export const WORKFLOW_EXPORT_PRIVACY_NOTE_KEY: TranslationKeyNoParams =
  'workflows.interchange.exportPrivacyNote';

const IMPORT_FAILURE_MESSAGE_KEYS = {
  invalid_json: 'workflows.interchange.importFailedInvalidJson',
  unsupported_version: 'workflows.interchange.importFailedUnsupportedVersion',
  invalid_document: 'workflows.interchange.importFailedInvalidDocument',
} as const satisfies Readonly<Record<
  Exclude<WorkflowImportFailureCode, 'invalid_definition'>,
  TranslationKeyNoParams
>>;

type WorkflowImportParams = Readonly<{
  source: string;
  /** The draft currently open in the editor; returned unchanged on failure. */
  currentDraft: WorkflowEditorDraft;
  draftId: string;
  /** The document carries no title, so the review draft is unnamed by default. */
  name?: string;
  /** The same trusted host context the validator receives at save and start. */
  context?: WorkflowIngressContextV1;
}>;

/** Pure draft projection remains available to local draft tools; document admission has one codec. */
export function importWorkflowDocument(params: WorkflowImportParams): WorkflowImportResult {
  return projectImportedWorkflowDocument(params, parseWorkflowDocumentJsonIngressV1(params.source, params.context));
}

/** The mounted file-import flow consumes the same Action as CLI and agents. Picking stays local. */
export async function importWorkflowDocumentViaAction(params: Omit<WorkflowImportParams, 'context'>): Promise<WorkflowImportResult> {
  const parsed = await callWorkflowAction({ actionId: 'workflow.definition.import', input: { json: params.source },
    parseResult: (value) => WorkflowDefinitionImportResultV1Schema.parse(value) });
  return projectImportedWorkflowDocument(params, parsed);
}

function projectImportedWorkflowDocument(params: WorkflowImportParams, parsed: WorkflowDocumentParseResultV1): WorkflowImportResult {
  const failure = (
    code: WorkflowImportFailureCode,
    issues: readonly WorkflowValidationIssue[] = [],
    repairDraft?: WorkflowEditorDraft,
  ): WorkflowImportResult => ({
    ok: false,
    code,
    messageKey: code === 'invalid_definition' ? null : IMPORT_FAILURE_MESSAGE_KEYS[code],
    issues,
    draft: params.currentDraft,
    ...(repairDraft === undefined ? {} : { repairDraft }),
  });

  if (!parsed.ok) {
    if (parsed.code === 'workflow_document_invalid_json') return failure('invalid_json');
    if (parsed.code === 'workflow_document_unsupported_version') return failure('unsupported_version');
    if (parsed.code === 'workflow_document_invalid') return failure('invalid_document');
    const definition = parsed.normalizedDefinition;
    return failure(
      'invalid_definition',
      parsed.issues,
      definition === undefined
        ? undefined
        : buildWorkflowEditorDraftFromDefinition({
          draftId: params.draftId,
          name: params.name ?? '',
          definition,
        }),
    );
  }
  const definition = parsed.document.definition;

  return {
    ok: true,
    definition,
    draft: buildWorkflowEditorDraftFromDefinition({
      draftId: params.draftId,
      name: params.name ?? '',
      definition,
    }),
  };
}

/**
 * Serializes the reviewed draft through the canonical codec. An invalid draft
 * is refused with the same issues the editor already shows, so export cannot
 * publish a document the app itself would reject on import.
 */
export function exportWorkflowDocument(params: Readonly<{
  draft: WorkflowEditorDraft;
  context?: WorkflowIngressContextV1;
}>): WorkflowExportResult {
  const validation = validateWorkflowEditorDraft(
    params.draft,
    params.context === undefined ? {} : { context: params.context },
  );
  const definition = validation.normalizedDefinition;
  if (!validation.valid || definition === undefined) {
    return {
      ok: false,
      issues: validation.issues,
      blockingIssue: firstBlockingWorkflowIssue(validation),
    };
  }

  return serializeValidatedWorkflowDefinition(definition);
}

/**
 * Serializes an already-opened saved or frozen Run definition through the same
 * validator and file codec as the editor. Callers never reconstruct authored
 * content from progress, results, transcripts, or list projections.
 */
export function exportWorkflowDefinition(params: Readonly<{
  definition: WorkflowDefinitionV1;
  context?: WorkflowIngressContextV1;
}>): WorkflowExportResult {
  const validation = validateWorkflowDefinition(
    params.definition,
    params.context === undefined ? {} : { context: params.context },
  );
  const definition = validation.normalizedDefinition;
  if (!validation.valid || definition === undefined) {
    return {
      ok: false,
      issues: validation.issues,
      blockingIssue: firstBlockingWorkflowIssue(validation),
    };
  }
  return serializeValidatedWorkflowDefinition(definition);
}
