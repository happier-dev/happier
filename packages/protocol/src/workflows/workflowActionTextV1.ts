import { lazyZodSchema } from '../lazyZodSchema.js';
import { isUrlJsonSchemaFormat } from '../actions/actionInputJsonSchema.js';
import { z } from '../zodRuntimePolicy.js';
import {
  StrictJsonValueSchema,
  type JsonValue,
} from '../json/strictJsonValue.js';
import {
  MENTION_BOUNDS,
  MENTION_KIND_V1,
  MentionRefV1Schema,
  buildMentionRefForKindV1,
} from '../runtime/input/mentionRefV1.js';
import {
  formatInlineReferenceTokenV1,
  scanInlineReferenceTokensV1,
} from '../runtime/input/inlineReferenceTokenV1.js';
import { readWorkflowStepInputIndexV1 } from './workflowComposerDocumentV1.js';
import type {
  WorkflowActionFieldBindingV1,
  WorkflowActionValueReferenceV1,
} from './workflowV1.js';

/**
 * The text of one Action field with workflow values inside it. It is the same
 * Composer document a prompt step saves: literal text holding inline reference
 * tokens, each bound by a `workflowInput` record to an index of the binding's
 * `input` list.
 */
export const WorkflowActionTextDocumentV1Schema = lazyZodSchema(() =>
  z.strictObject({
    text: z.string(),
    references: z._default(
      z
        .array(MentionRefV1Schema)
        .check(z.maxLength(MENTION_BOUNDS.maxPerMessage)),
      [],
    ),
  }),
);
export type WorkflowActionTextDocumentV1 = z.infer<
  typeof WorkflowActionTextDocumentV1Schema
>;
export type WorkflowActionTextBindingV1 = Extract<
  WorkflowActionFieldBindingV1,
  { kind: 'text' }
>;

/** How a field's declared type reads an inserted value. Shell text is never substituted (literal-only fields). */
export type WorkflowActionTextEncodingV1 = 'plain' | 'url' | 'json';

type BoundToken = Readonly<{
  start: number;
  end: number;
  label: string;
  index: number;
}>;

/** Tokens in text order whose exact text a `workflowInput` record binds; other token text stays literal. */
function readBoundTokens(document: WorkflowActionTextDocumentV1): BoundToken[] {
  const indexByToken = new Map<string, number>();
  for (const mention of document.references) {
    if (mention.kind !== MENTION_KIND_V1.workflowInput) continue;
    const index = readWorkflowStepInputIndexV1(mention.ref);
    if (index !== null && !indexByToken.has(mention.token))
      indexByToken.set(mention.token, index);
  }
  return scanInlineReferenceTokensV1(document.text).flatMap((token) => {
    const index = indexByToken.get(document.text.slice(token.start, token.end));
    return index === undefined
      ? []
      : [{ start: token.start, end: token.end, label: token.label, index }];
  });
}

/** The binding indexes the text actually uses; only these are resolved at run time. */
export function listWorkflowActionTextInputIndexesV1(
  document: WorkflowActionTextDocumentV1,
): number[] {
  return [...new Set(readBoundTokens(document).map((token) => token.index))];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const JSON_SOURCE_TYPES = new Set([
  'object',
  'array',
  'number',
  'integer',
  'boolean',
]);

/**
 * The one encoding decision, from the field's declared JSON Schema: a URL
 * string (the same `uri`/`url` formats the field hint presents as a URL)
 * percent-encodes each value, a declared non-string type reads the text as
 * JSON source, and everything else is plain text.
 */
export function readWorkflowActionFieldTextEncodingV1(inputSchema: unknown, field: string): WorkflowActionTextEncodingV1 {
  const properties = isRecord(inputSchema) && isRecord(inputSchema.properties) ? inputSchema.properties : null;
  const node = properties && Object.hasOwn(properties, field)
    ? readLocalSchemaNode(inputSchema as Readonly<Record<string, unknown>>, properties[field]) : null;
  if (!node) return 'plain';
  if (node.type === 'string') return isUrlJsonSchemaFormat(node.format) ? 'url' : 'plain';
  return typeof node.type === 'string' && JSON_SOURCE_TYPES.has(node.type) ? 'json' : 'plain';
}

/** Frozen contracts share subschemas through local `#/definitions` or `#/$defs` pointers; sibling keywords still apply. */
function readLocalSchemaNode(root: Readonly<Record<string, unknown>>, value: unknown): Readonly<Record<string, unknown>> | null {
  let node = isRecord(value) ? value : null;
  const seen = new Set<string>();
  while (node && typeof node.$ref === 'string') {
    const match = /^#\/(definitions|\$defs)\/([^/]+)$/.exec(node.$ref);
    if (!match || seen.has(node.$ref)) return null;
    seen.add(node.$ref);
    const definitions = root[match[1]!];
    const target = isRecord(definitions) ? definitions[decodeURIComponent(match[2]!)] : undefined;
    if (!isRecord(target)) return null;
    const { $ref: _ref, ...siblings } = node;
    node = { ...target, ...siblings };
  }
  return node;
}

function encodeValue(
  value: JsonValue,
  encoding: WorkflowActionTextEncodingV1,
): string {
  if (encoding === 'json') return JSON.stringify(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return encoding === 'url' ? encodeURIComponent(text) : text;
}

/** Substitutes each bound token with its value; a JSON field's result must parse as JSON. */
export function renderWorkflowActionTextV1(
  document: WorkflowActionTextDocumentV1,
  encoding: WorkflowActionTextEncodingV1,
  valueAt: (index: number) => JsonValue,
): Readonly<{ ok: true; value: JsonValue }> | Readonly<{ ok: false }> {
  let text = '';
  let cursor = 0;
  for (const token of readBoundTokens(document)) {
    text +=
      document.text.slice(cursor, token.start) +
      encodeValue(valueAt(token.index), encoding);
    cursor = token.end;
  }
  text += document.text.slice(cursor);
  if (encoding !== 'json') return { ok: true, value: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const value = StrictJsonValueSchema.safeParse(parsed);
  return value.success ? { ok: true, value: value.data } : { ok: false };
}

/**
 * The narrowest binding for an edited field: no value inside is a literal, a
 * lone value is that whole value (keeping its type), and otherwise the text
 * keeps only the values it uses, numbered in order of first use. A token that
 * addresses no binding is an invalid draft that validation names, so it is
 * returned unchanged.
 */
export function normalizeWorkflowActionTextBindingV1(
  binding: WorkflowActionTextBindingV1,
): WorkflowActionFieldBindingV1 {
  const tokens = readBoundTokens(binding.document);
  if (tokens.length === 0)
    return { kind: 'literal', value: binding.document.text };
  if (tokens.some((token) => token.index >= binding.input.length))
    return binding;
  const only = tokens.length === 1 ? tokens[0]! : null;
  if (only && only.start === 0 && only.end === binding.document.text.length)
    return binding.input[only.index]!;
  const renumbered = new Map<number, number>();
  const input: WorkflowActionValueReferenceV1[] = [];
  const references: WorkflowActionTextDocumentV1['references'] = [];
  let text = '';
  let cursor = 0;
  for (const token of tokens) {
    let index = renumbered.get(token.index);
    if (index === undefined) {
      index = input.length;
      renumbered.set(token.index, index);
      input.push(binding.input[token.index]!);
    }
    const ref = buildMentionRefForKindV1(
      MENTION_KIND_V1.workflowInput,
      String(index),
    );
    const formatted = formatInlineReferenceTokenV1({ label: token.label, ref });
    if (!references.some((mention) => mention.token === formatted)) {
      references.push({
        kind: MENTION_KIND_V1.workflowInput,
        ref,
        label: token.label,
        token: formatted,
      });
    }
    text += binding.document.text.slice(cursor, token.start) + formatted;
    cursor = token.end;
  }
  text += binding.document.text.slice(cursor);
  return { kind: 'text', document: { text, references }, input };
}

/** Every value reference one Action field reads, whatever shape binds it. */
export function listWorkflowActionFieldReferencesV1(
  binding: WorkflowActionFieldBindingV1,
): readonly WorkflowActionValueReferenceV1[] {
  switch (binding.kind) {
    case 'list':
      return binding.items;
    case 'object':
      return Object.values(binding.fields);
    case 'text':
      return binding.input;
    default:
      return [binding];
  }
}

/** Rewrites every value reference of one Action field, keeping its shape. */
export function mapWorkflowActionFieldReferencesV1(
  binding: WorkflowActionFieldBindingV1,
  map: (
    reference: WorkflowActionValueReferenceV1,
  ) => WorkflowActionValueReferenceV1,
): WorkflowActionFieldBindingV1 {
  switch (binding.kind) {
    case 'list':
      return { ...binding, items: binding.items.map(map) };
    case 'object':
      return {
        ...binding,
        fields: Object.fromEntries(
          Object.entries(binding.fields).map(([field, item]) => [
            field,
            map(item),
          ]),
        ),
      };
    case 'text':
      return { ...binding, input: binding.input.map(map) };
    default:
      return map(binding);
  }
}
