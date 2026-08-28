import {
  cloneStrictPluginJsonValueWithTraversalLimits,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
  StrictPluginJsonTraversalLimitError,
} from '../strictJsonValue.js';
import { MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1 } from './declarativeDocumentContentTypeV1.js';

/** One document may render at most this many semantic nodes. */
export const MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1 = 512;
/** Whole plain-data document depth, counting the document envelope as depth one. */
export const MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1 = 48;
/** Total containers and scalar values in the whole plain-data document. */
export const MAX_PLUGIN_DECLARATIVE_DOCUMENT_PLAIN_VALUES_V1 = 8_192;

export type PluginDeclarativeDocumentPreflightFailureV1 = Readonly<{
  ok: false;
  code:
    | 'plugin_declarative_invalid_plain_data'
    | 'plugin_declarative_document_invalid'
    | 'plugin_declarative_document_bytes_exceeded'
    | 'plugin_declarative_document_depth_exceeded'
    | 'plugin_declarative_document_values_exceeded'
    | 'plugin_declarative_nodes_exceeded';
  message: string;
}>;

export type PluginDeclarativeDocumentPreflightResultV1 =
  | Readonly<{ ok: true; document: unknown }>
  | PluginDeclarativeDocumentPreflightFailureV1;

type PlainRecord = Readonly<Record<string, unknown>>;

function readRecord(value: unknown): PlainRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as PlainRecord
    : null;
}

function isContainerKind(kind: string): boolean {
  return kind === 'stack'
    || kind === 'group'
    || kind === 'list'
    || kind === 'section'
    || kind === 'actionPanel';
}

/**
 * Counts the declarative grammar's semantic nodes without invoking the
 * recursive Zod schema. It follows only grammar-owned child slots, so an
 * invalid arbitrary object cannot turn this bounded-document check into a
 * second JSON validator.
 */
function hasBoundedSemanticNodeCount(root: unknown): boolean {
  const pending: unknown[] = [root];
  let nodeCount = 0;

  while (pending.length > 0) {
    const candidate = pending.pop();
    const node = readRecord(candidate);
    if (!node || typeof node.kind !== 'string') continue;

    nodeCount += 1;
    if (nodeCount > MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1) return false;

    if (isContainerKind(node.kind) && Array.isArray(node.children)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]);
      }
    }
    if (node.kind === 'targetedSurface' && Object.hasOwn(node, 'fallback')) {
      pending.push(node.fallback);
    }
  }

  return true;
}

/**
 * The one document-bound preflight shared by static manifest roots and dynamic
 * Resource documents. Its strict clone and serialized-byte measurement are
 * iterative and apply only this feature's earned document profile, so
 * pathological structure is rejected before recursive author-schema parsing.
 */
export function preflightPluginDeclarativeDocumentV1(
  input: unknown,
): PluginDeclarativeDocumentPreflightResultV1 {
  let document: unknown;
  try {
    document = cloneStrictPluginJsonValueWithTraversalLimits(input, 'document', {
      maxDepth: MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
      maxValues: MAX_PLUGIN_DECLARATIVE_DOCUMENT_PLAIN_VALUES_V1,
    });
  } catch (error) {
    if (error instanceof StrictPluginJsonTraversalLimitError) {
      return error.limit === 'depth'
        ? {
            ok: false,
            code: 'plugin_declarative_document_depth_exceeded',
            message: 'Declarative document exceeds the plain-data depth limit',
          }
        : {
            ok: false,
            code: 'plugin_declarative_document_values_exceeded',
            message: 'Declarative document has too many plain-data values',
          };
    }
    return {
      ok: false,
      code: 'plugin_declarative_invalid_plain_data',
      message: error instanceof Error ? error.message : 'Document must contain strict JSON data',
    };
  }

  try {
    const serializedBytes = measureSerializedValidatedStrictPluginJsonUtf8Bytes(
      document,
      'document',
      MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
    );
    if (serializedBytes > MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1) {
      return {
        ok: false,
        code: 'plugin_declarative_document_bytes_exceeded',
        message: 'Declarative document exceeds the UTF-8 byte limit',
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'plugin_declarative_invalid_plain_data',
      message: error instanceof Error ? error.message : 'Document must contain strict JSON data',
    };
  }

  const envelope = readRecord(document);
  if (envelope?.version === 1 && Object.hasOwn(envelope, 'root') && !hasBoundedSemanticNodeCount(envelope.root)) {
    return {
      ok: false,
      code: 'plugin_declarative_nodes_exceeded',
      message: 'Declarative document has too many nodes',
    };
  }

  return { ok: true, document };
}

/**
 * Decode one Resource document through the same Protocol owner that declares
 * its byte boundary. The caller still gives the parsed value to the shared
 * document preflight before recursive validation.
 */
export function parsePluginDeclarativeDocumentResourceBytesV1(
  bytes: Uint8Array,
): Readonly<{ ok: true; document: unknown }> | PluginDeclarativeDocumentPreflightFailureV1 {
  if (bytes.byteLength > MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1) {
    return {
      ok: false,
      code: 'plugin_declarative_document_bytes_exceeded',
      message: 'Declarative document exceeds the UTF-8 byte limit',
    };
  }
  try {
    return {
      ok: true,
      document: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
    };
  } catch {
    return {
      ok: false,
      code: 'plugin_declarative_document_invalid',
      message: 'Declarative document is not valid UTF-8 JSON',
    };
  }
}
