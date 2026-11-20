import type { WorkflowDocumentParseResultV1 } from '@happier-dev/protocol/workflows/workflowDocumentV1';
import type {
  WorkflowDefinitionV1,
  WorkflowValidationIssue,
} from '@happier-dev/protocol/workflows/workflowV1';

import type { TranslationKeyNoParams } from '@/text';

import {
  buildWorkflowEditorDraftFromDefinition,
  buildWorkflowDefinitionCandidate,
} from './workflowAuthoring';
import type { WorkflowEditorDraft } from './workflowEditorDraft';
import { WorkflowDefinitionExportResultV1Schema, WorkflowDefinitionImportResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { callWorkflowAction } from './callWorkflowAction';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * JSON interchange for authored workflows.
 *
 * This is an adapter, not a parser: Protocol's ingress-aware document parser
 * owns the envelope and delegates definition normalization to the canonical
 * workflow validator, exactly as save and run admission do. Mounted import and
 * export delegate through the shared Action front door; this module projects
 * the parsed document into a review draft. The platform file, share and
 * download boundary stays with the caller.
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
}>;

/** The mounted file-import flow consumes the same Action as CLI and agents. Picking stays local. */
export async function importWorkflowDocumentViaAction(params: WorkflowImportParams): Promise<WorkflowImportResult> {
  const parsed = await callWorkflowAction({ actionId: 'workflow.definition.import', input: { json: params.source },
    parseResult: (value) => WorkflowDefinitionImportResultV1Schema.parse(value) });
  return projectImportedWorkflowDocument(params, parsed);
}

/** Export open authored content through the same validated Action as saved definitions. */
export async function exportWorkflowDocumentViaAction(params: Readonly<(
  { draft: WorkflowEditorDraft } | { definition: WorkflowDefinitionV1 }
) & { accountLifetime?: ServerAccountScopeLifetime | null }>) {
  return callWorkflowAction({ actionId: 'workflow.definition.export',
    input: { draft: 'draft' in params ? buildWorkflowDefinitionCandidate(params.draft) : params.definition },
    ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
    parseResult: value => WorkflowDefinitionExportResultV1Schema.parse(value) });
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
