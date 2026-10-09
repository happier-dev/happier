import * as z from 'zod/mini';

import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import { ProjectManifestV1Schema, ProjectManifestV1StoredSchema } from './projectManifestV1.js';

const pathSchema = z.array(z.union([z.string(), z.number().check(z.int(), z.nonnegative())]));
export const ProjectManifestDiagnosticSchema = z.strictObject({
  code: z.enum(['invalid_json', 'invalid_field', 'unrecognized_key']),
  path: pathSchema, message: z.string(), offset: z.optional(z.number().check(z.int(), z.nonnegative())),
});
export type ProjectManifestDiagnostic = z.infer<typeof ProjectManifestDiagnosticSchema>;

const validDocumentSchema = z.strictObject({ status: z.literal('valid'), bytes: z.string(), original: z.record(z.string(), z.unknown()), manifest: ProjectManifestV1Schema, diagnostics: z.array(ProjectManifestDiagnosticSchema) });
export const ProjectManifestDocumentSchema = z.union([
  validDocumentSchema,
  z.strictObject({ status: z.literal('invalid'), bytes: z.string(), original: z.optional(z.unknown()), diagnostics: z.array(ProjectManifestDiagnosticSchema) }),
]);
export type ProjectManifestDocument = z.infer<typeof ProjectManifestDocumentSchema>;
const absentBasis = z.strictObject({ kind: z.literal('absent') });
const presentBasis = z.strictObject({ kind: z.literal('present'), hash: z.string().check(z.regex(/^[a-f0-9]{64}$/u)) });
export const ProjectManifestFileBasisV1Schema = z.union([absentBasis, presentBasis]);
export type ProjectManifestFileBasisV1 = z.infer<typeof ProjectManifestFileBasisV1Schema>;
export const ProjectManifestFileSnapshotSchema = z.union([
  z.strictObject({ basis: absentBasis, document: z.null() }),
  z.strictObject({ basis: presentBasis, document: ProjectManifestDocumentSchema }),
]);
export type ProjectManifestFileSnapshot = z.infer<typeof ProjectManifestFileSnapshotSchema>;
export const ProjectManifestUpdateResultSchema = z.union([
  z.strictObject({ status: z.literal('saved'), basis: presentBasis, document: validDocumentSchema }),
  z.strictObject({ status: z.literal('conflict'), current: ProjectManifestFileSnapshotSchema }),
  z.strictObject({ status: z.literal('refused'), code: z.enum(['invalid_manifest', 'invalid_basis', 'access_denied', 'write_failed']), diagnostics: z.optional(z.array(ProjectManifestDiagnosticSchema)), message: z.optional(z.string()) }),
]);
export type ProjectManifestUpdateResult = z.infer<typeof ProjectManifestUpdateResultSchema>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownDiagnostics(original: unknown, projected: unknown, path: (string | number)[] = []): ProjectManifestDiagnostic[] {
  if (Array.isArray(original) && Array.isArray(projected)) return original.flatMap((value, index) => unknownDiagnostics(value, projected[index], [...path, index]));
  if (!isObject(original) || !isObject(projected)) return [];
  const diagnostics: ProjectManifestDiagnostic[] = Object.keys(original)
    .filter(key => !Object.hasOwn(projected, key))
    .map(key => ({ code: 'unrecognized_key', path: [...path, key], message: `Unrecognized key: ${key}` }));
  for (const key of Object.keys(original)) if (Object.hasOwn(projected, key)) diagnostics.push(...unknownDiagnostics(original[key], projected[key], [...path, key]));
  return diagnostics;
}

/** Read projection and original text are separate: only the text is ever saved. */
export function readProjectManifestDocument(bytes: string): ProjectManifestDocument {
  let original: unknown;
  try { original = JSON.parse(bytes); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    const position = /position (\d+)/u.exec(message);
    const location = /line (\d+) column (\d+)/iu.exec(message);
    const offset = position ? Number(position[1]) : location
      ? bytes.split('\n').slice(0, Number(location[1]) - 1).reduce((length, line) => length + line.length + 1, 0) + Number(location[2]) - 1
      : /(?:unexpected end|end of json)/iu.test(message) ? bytes.length : undefined;
    return { status: 'invalid', bytes, diagnostics: [{ code: 'invalid_json', path: [], message, ...(offset === undefined ? {} : { offset }) }] };
  }
  const parsed = ProjectManifestV1StoredSchema.safeParse(original);
  if (!parsed.success || !isObject(original)) {
    const diagnostics: ProjectManifestDiagnostic[] = parsed.success ? [{ code: 'invalid_field', path: [], message: 'Project manifest must be an object' }]
      : parsed.error.issues.map(issue => ({ code: 'invalid_field', path: issue.path.map(item => typeof item === 'number' ? item : String(item)), message: issue.message }));
    return { status: 'invalid', bytes, original, diagnostics };
  }
  return { status: 'valid', bytes, original, manifest: parsed.data, diagnostics: unknownDiagnostics(original, parsed.data) };
}

export type ProjectManifestDocumentEdit =
  | Readonly<{ kind: 'set'; path: readonly (string | number)[]; value: unknown }>
  | Readonly<{ kind: 'remove'; path: readonly (string | number)[] }>
  | Readonly<{ kind: 'reorder'; path: readonly (string | number)[]; keys: readonly (string | number)[] }>;

type TextMember = { key: string | number; start: number; value: TextNode };
type TextNode = { start: number; end: number; kind: 'object' | 'array' | 'value'; members: TextMember[] };

/** Index spans only after JSON.parse admission; JSON syntax has one parser. */
function indexJsonText(bytes: string): TextNode {
  const tokens = /\s*("(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gyu;
  let next: RegExpExecArray | null = tokens.exec(bytes);
  function consume(): { text: string; start: number; end: number } {
    if (!next) throw new Error('Missing admitted JSON token');
    const result = { text: next[1]!, start: tokens.lastIndex - next[1]!.length, end: tokens.lastIndex };
    next = tokens.exec(bytes);
    return result;
  }
  function value(): TextNode {
    const token = consume();
    const kind = token.text === '{' ? 'object' : token.text === '[' ? 'array' : 'value';
    const node: TextNode = { start: token.start, end: token.end, kind, members: [] };
    if (kind === 'value') return node;
    const close = kind === 'object' ? '}' : ']';
    while (next?.[1] !== close) {
      let key: string | number = node.members.length;
      let start = next ? tokens.lastIndex - next[1]!.length : token.end;
      if (kind === 'object') { const name = consume(); key = JSON.parse(name.text) as string; start = name.start; consume(); }
      node.members.push({ key, start, value: value() });
      if (next?.[1] === ',') consume();
    }
    node.end = consume().end;
    return node;
  }
  return value();
}

function memberFor(node: TextNode, key: string | number): TextMember | undefined {
  // JSON.parse gives the last duplicate member meaning; an edit uses that same member.
  return [...node.members].reverse().find(member => member.key === key);
}

function nodeAt(node: TextNode, path: readonly (string | number)[]): TextNode | undefined {
  let current: TextNode | undefined = node;
  for (const key of path) { if (!current) return undefined; current = memberFor(current, key)?.value; }
  return current;
}

function splice(bytes: string, start: number, end: number, text: string): string {
  return bytes.slice(0, start) + text + bytes.slice(end);
}

function serialize(value: unknown): string { return JSON.stringify(normalizeStrictJsonValue(value)); }

function applyTextEdit(bytes: string, edit: ProjectManifestDocumentEdit): string {
  const tree = indexJsonText(bytes);
  if (edit.kind === 'reorder') {
    const node = nodeAt(tree, edit.path);
    if (!node || node.kind === 'value') throw new Error('Reorder requires declarations or steps');
    const keys = [...new Set(node.members.map(member => member.key))];
    if (new Set(edit.keys).size !== edit.keys.length || edit.keys.length !== keys.length || keys.some(key => !edit.keys.includes(key))) throw new Error('Reorder must contain each declaration once');
    const parts = edit.keys.flatMap(key => node.members.filter(member => member.key === key)).map(member => bytes.slice(member.start, member.value.end));
    const first = node.members[0];
    const last = node.members.at(-1);
    if (!first || !last) return bytes;
    const leading = bytes.slice(node.start + 1, first.start);
    return splice(bytes, first.start, last.value.end, parts.join(`,${leading}`));
  }
  if (!edit.path.length) throw new Error('Structured edits require a field path');
  let parent = tree;
  for (let index = 0; index < edit.path.length - 1; index++) {
    const child = memberFor(parent, edit.path[index]!);
    if (!child) {
      if (edit.kind === 'remove') return bytes;
      let value: unknown = edit.value;
      for (let at = edit.path.length - 1; at > index; at--) {
        const key = edit.path[at]!;
        if (typeof key === 'number') { if (key !== 0) throw new Error('Cannot create a sparse array'); value = [value]; }
        else value = { [key]: value };
      }
      return applyTextEdit(bytes, { kind: 'set', path: edit.path.slice(0, index + 1), value });
    }
    parent = child.value;
  }
  const key = edit.path.at(-1)!;
  if (parent.kind === 'value' || (parent.kind === 'array' && (typeof key !== 'number' || key < 0 || !Number.isSafeInteger(key)))) throw new Error('Invalid field path');
  const found = memberFor(parent, key);
  if (edit.kind === 'remove') {
    if (!found) return bytes;
    const index = parent.members.indexOf(found);
    const previous = parent.members[index - 1];
    const next = parent.members[index + 1];
    const removed = next ? splice(bytes, found.start, next.start, '')
      : splice(bytes, previous ? previous.value.end : found.start, found.value.end, '');
    // Remove all duplicates so deleting a declaration cannot reveal an earlier body.
    return parent.members.filter(member => member.key === key).length > 1 ? applyTextEdit(removed, edit) : removed;
  }
  const value = serialize(edit.value);
  if (found) return splice(bytes, found.value.start, found.value.end, value);
  if (parent.kind === 'array' && key !== parent.members.length) throw new Error('Cannot create a sparse array');
  const last = parent.members.at(-1);
  const first = parent.members[0];
  const leading = first ? bytes.slice(parent.start + 1, first.start) : '';
  const separator = parent.kind === 'object' ? `${JSON.stringify(String(key))}: ` : '';
  const insertAt = last ? last.value.end : parent.start + 1;
  return splice(bytes, insertAt, insertAt, `${last ? ',' : ''}${leading}${separator}${value}`);
}

/** Field edits splice original text, retaining every untouched known or unknown value. */
export function editProjectManifestDocument(document: ProjectManifestDocument, edits: readonly ProjectManifestDocumentEdit[]): ProjectManifestDocument {
  if (document.status !== 'valid') return document;
  let bytes = document.bytes;
  try {
    for (const edit of edits) {
      bytes = applyTextEdit(bytes, edit);
      if (edit.kind === 'set' && edit.path.at(-1) === 'bytes' && edit.path.at(-2) === 'memoryDemand') {
        const demandPath = edit.path.slice(0, -1);
        bytes = applyTextEdit(bytes, { kind: 'set', path: [...demandPath, 'basis', 'kind'], value: 'declared' });
        bytes = applyTextEdit(bytes, { kind: 'remove', path: [...demandPath, 'basis', 'operation'] });
      }
    }
    return readProjectManifestDocument(bytes);
  } catch (error) {
    return { status: 'invalid', bytes, original: document.original, diagnostics: [{ code: 'invalid_field', path: [], message: error instanceof Error ? error.message : 'Invalid structured edit' }] };
  }
}
