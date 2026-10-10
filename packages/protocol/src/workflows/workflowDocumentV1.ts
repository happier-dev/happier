import { z } from 'zod';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import {
  type WorkflowDefinitionV1,
  type WorkflowIngressContextV1,
  type WorkflowValidationIssue,
} from './workflowV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';

import { WorkflowDocumentV1Schema, type WorkflowDocumentV1 } from './workflowDocumentSchemasV1.js';
export { WorkflowDocumentV1Schema, WorkflowDocumentParseFailureV1Schema, type WorkflowDocumentV1 } from './workflowDocumentSchemasV1.js';

export type WorkflowDocumentParseErrorCodeV1 =
  | 'workflow_document_invalid_json'
  | 'workflow_document_unsupported_version'
  | 'workflow_document_invalid'
  | 'workflow_document_invalid_definition';

export type WorkflowDocumentParseResultV1 =
  | Readonly<{ ok: true; document: WorkflowDocumentV1 }>
  | Readonly<{
    ok: false;
    code: WorkflowDocumentParseErrorCodeV1;
    issues: readonly WorkflowValidationIssue[];
    normalizedDefinition?: WorkflowDefinitionV1;
    version?: unknown;
  }>;

export class WorkflowDocumentParseErrorV1 extends TypeError {
  readonly code: WorkflowDocumentParseErrorCodeV1;

  constructor(code: WorkflowDocumentParseErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowDocumentParseErrorV1';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const WorkflowDocumentIngressEnvelopeV1Schema = z.object({
  kind: z.literal('happier.workflow'),
  version: z.literal(1),
  definition: z.unknown(),
}).strict();

/**
 * Canonical ingress-aware document owner. It classifies the wrapper, delegates
 * definition normalization to the one workflow validator, and never exposes a
 * recursive schema exception to a UI or CLI boundary.
 */
export function parseWorkflowDocumentIngressV1(
  value: unknown,
  context?: WorkflowIngressContextV1,
): WorkflowDocumentParseResultV1 {
  const envelope = WorkflowDocumentIngressEnvelopeV1Schema.safeParse(value);
  if (!envelope.success) {
    if (
      isRecord(value)
      && value.kind === 'happier.workflow'
      && Object.hasOwn(value, 'version')
      && value.version !== 1
    ) {
      return {
        ok: false,
        code: 'workflow_document_unsupported_version',
        issues: [],
        version: value.version,
      };
    }
    return { ok: false, code: 'workflow_document_invalid', issues: [] };
  }

  const validation = validateWorkflowDefinition(
    envelope.data.definition,
    context === undefined ? {} : { context },
  );
  if (!validation.valid || validation.normalizedDefinition === undefined) {
    return {
      ok: false,
      code: 'workflow_document_invalid_definition',
      issues: validation.issues,
      ...(validation.normalizedDefinition === undefined
        ? {}
        : { normalizedDefinition: validation.normalizedDefinition }),
    };
  }
  return {
    ok: true,
    document: {
      kind: 'happier.workflow',
      version: 1,
      definition: validation.normalizedDefinition,
    },
  };
}

export function parseWorkflowDocumentJsonIngressV1(
  json: string,
  context?: WorkflowIngressContextV1,
): WorkflowDocumentParseResultV1 {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, code: 'workflow_document_invalid_json', issues: [] };
  }
  return parseWorkflowDocumentIngressV1(value, context);
}

function throwWorkflowDocumentParseFailure(
  result: Exclude<WorkflowDocumentParseResultV1, Readonly<{ ok: true }>>,
): never {
  if (result.code === 'workflow_document_unsupported_version') {
    throw new WorkflowDocumentParseErrorV1(
      result.code,
      `Unsupported Workflow document version: ${String(result.version)}`,
    );
  }
  throw new WorkflowDocumentParseErrorV1(
    result.code === 'workflow_document_invalid_definition'
      ? 'workflow_document_invalid'
      : result.code,
    result.code === 'workflow_document_invalid_json'
      ? 'Workflow document is not valid JSON'
      : 'Workflow document does not match the version 1 schema',
  );
}

export function parseWorkflowDocumentV1(value: unknown): WorkflowDocumentV1 {
  const result = parseWorkflowDocumentIngressV1(value);
  if (result.ok) return result.document;
  return throwWorkflowDocumentParseFailure(result);
}

export function parseWorkflowDocumentJsonV1(json: string): WorkflowDocumentV1 {
  const result = parseWorkflowDocumentJsonIngressV1(json);
  if (result.ok) return result.document;
  return throwWorkflowDocumentParseFailure(result);
}

/** Stable JSON interchange projection derived from the one executable document schema. */
export function serializeWorkflowDocumentJsonV1(document: unknown): string {
  return createCanonicalJsonSigningInput(parseWorkflowDocumentV1(document));
}
