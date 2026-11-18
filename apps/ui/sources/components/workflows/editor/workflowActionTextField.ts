import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import {
  formatInlineReferenceTokenV1,
  scanInlineReferenceTokensV1,
} from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import {
  buildMentionRefForKindV1,
  MENTION_KIND_V1,
} from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { readWorkflowStepInputIndexV1 } from '@happier-dev/protocol/workflows/workflowComposerDocumentV1';
import {
  normalizeWorkflowActionTextBindingV1,
  type WorkflowActionTextBindingV1,
  type WorkflowActionTextDocumentV1,
} from '@happier-dev/protocol/workflows/workflowActionTextV1';
import type {
  WorkflowActionFieldBindingV1,
  WorkflowActionValueReferenceV1,
} from '@happier-dev/protocol/workflows/workflowLeafV1';

/**
 * The editor seam for workflow values inside an Action field. The field's
 * text is the same Composer document a prompt saves, so the '@' list
 * (`createWorkflowPromptSuggestions` with the field's `input`), Insert and the
 * token chips behave exactly as in a prompt. Every write goes through the
 * Protocol normalizer, which keeps the narrowest binding.
 */

const EMPTY_FIELD: WorkflowActionTextBindingV1 = {
  kind: 'text',
  document: { text: '', references: [] },
  input: [],
};

function tokenRecord(label: string, index: number) {
  const ref = buildMentionRefForKindV1(
    MENTION_KIND_V1.workflowInput,
    String(index),
  );
  return {
    kind: MENTION_KIND_V1.workflowInput,
    ref,
    label,
    token: formatInlineReferenceTokenV1({ label, ref }),
  };
}

/**
 * The field as editable text: unset, a text literal or text with values inside;
 * a lone value opens as one value inside the text so the person can type around
 * it. Null for a value that is not text (a number, a list, an object).
 */
export function readWorkflowActionFieldText(
  binding: WorkflowActionFieldBindingV1 | undefined,
  labelFor: (reference: WorkflowActionValueReferenceV1) => string,
): WorkflowActionTextBindingV1 | null {
  if (binding === undefined) return EMPTY_FIELD;
  switch (binding.kind) {
    case 'text':
      return binding;
    case 'literal':
      return typeof binding.value === 'string'
        ? {
            kind: 'text',
            document: { text: binding.value, references: [] },
            input: [],
          }
        : null;
    case 'list':
    case 'object':
      return null;
    default: {
      const record = tokenRecord(labelFor(binding), 0);
      return {
        kind: 'text',
        document: { text: record.token, references: [record] },
        input: [binding],
      };
    }
  }
}

/** Writes the edited document back; a document with no value inside is a literal, a lone value is that value. */
export function writeWorkflowActionFieldText(
  field: WorkflowActionTextBindingV1,
  document: WorkflowActionTextDocumentV1,
): WorkflowActionFieldBindingV1 {
  return normalizeWorkflowActionTextBindingV1({ ...field, document });
}

/** Insert's effect in a plain text input: the value replaces the selection, or lands at the end. */
export function insertWorkflowActionFieldValue(
  field: WorkflowActionTextBindingV1,
  params: Readonly<{
    reference: WorkflowActionValueReferenceV1;
    label: string;
    selection?: Readonly<{ start: number; end: number }>;
  }>,
): WorkflowActionFieldBindingV1 {
  const existing = field.input.findIndex((value) =>
    pluginJsonValuesEqual(value, params.reference),
  );
  const index = existing < 0 ? field.input.length : existing;
  const record = tokenRecord(params.label, index);
  const { text } = field.document;
  const start = params.selection?.start ?? text.length;
  const end = params.selection?.end ?? start;
  return normalizeWorkflowActionTextBindingV1({
    kind: 'text',
    input: existing < 0 ? [...field.input, params.reference] : field.input,
    document: {
      text: text.slice(0, start) + record.token + text.slice(end),
      references: field.document.references.some(
        (mention) => mention.token === record.token,
      )
        ? field.document.references
        : [...field.document.references, record],
    },
  });
}

export type WorkflowActionFieldTextPart =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{
      kind: 'value';
      label: string;
      reference: WorkflowActionValueReferenceV1;
    }>;

/** A resting field's reading order: its words with each value as a chip, labelled as authored. */
export function listWorkflowActionFieldTextParts(
  binding: WorkflowActionTextBindingV1,
): WorkflowActionFieldTextPart[] {
  const bound = new Set(
    binding.document.references.flatMap((mention) =>
      mention.kind === MENTION_KIND_V1.workflowInput ? [mention.token] : [],
    ),
  );
  const parts: WorkflowActionFieldTextPart[] = [];
  let cursor = 0;
  const pushText = (text: string) => {
    if (text) parts.push({ kind: 'text', text });
  };
  for (const token of scanInlineReferenceTokensV1(binding.document.text)) {
    const index = readWorkflowStepInputIndexV1(token.ref);
    const reference = index === null ? undefined : binding.input[index];
    if (
      !bound.has(binding.document.text.slice(token.start, token.end)) ||
      reference === undefined
    )
      continue;
    pushText(binding.document.text.slice(cursor, token.start));
    parts.push({ kind: 'value', label: token.label, reference });
    cursor = token.end;
  }
  pushText(binding.document.text.slice(cursor));
  return parts;
}
