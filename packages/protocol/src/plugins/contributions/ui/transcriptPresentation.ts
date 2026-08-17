import { z } from 'zod';

import {
  PluginDeclarativeNodeV2Schema,
  type PluginDeclarativeNodeV2,
} from './v2.js';

/**
 * Immutable semantic nodes that may be persisted in a plugin transcript
 * snapshot. This is a profile over the canonical declarative grammar, not a
 * second grammar: parsing always begins with `PluginDeclarativeNodeV2Schema`.
 */
export type PluginTranscriptPresentationNodeV1 = Exclude<
  PluginDeclarativeNodeV2,
  Readonly<{ kind: 'field' | 'collectionList' | 'targetedSurface' }>
>;

export const PLUGIN_TRANSCRIPT_PRESENTATION_NODE_V1_KINDS = [
  'text',
  'markdown',
  'stack',
  'group',
  'status',
  'action',
  'list',
  'section',
  'item',
  'state',
  'metadata',
  'actionPanel',
] as const satisfies readonly PluginTranscriptPresentationNodeV1['kind'][];

export type PluginTranscriptPresentationNodeV1Kind =
  (typeof PLUGIN_TRANSCRIPT_PRESENTATION_NODE_V1_KINDS)[number];

type Assert<T extends true> = T;

// These two checks are deliberately type-level rather than a second runtime
// registry. A canonical V2 kind can neither become persistable accidentally nor
// be silently omitted from this explicit immutable-profile decision.
type _EveryTranscriptKindIsListed = Assert<
  Exclude<PluginTranscriptPresentationNodeV1['kind'], PluginTranscriptPresentationNodeV1Kind> extends never
    ? true
    : false
>;
type _EveryDeclarativeKindIsExplicitlyAccountedFor = Assert<
  Exclude<
    PluginDeclarativeNodeV2['kind'],
    PluginTranscriptPresentationNodeV1Kind | 'field' | 'collectionList' | 'targetedSurface'
  > extends never
    ? true
    : false
>;

function findExcludedTranscriptNodePath(
  node: PluginDeclarativeNodeV2,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | null {
  if (
    node.kind === 'field'
    || node.kind === 'collectionList'
    || node.kind === 'targetedSurface'
    || (node.kind === 'action' && node.effect?.kind === 'composerApply')
  ) return path;

  if (!('children' in node)) return null;
  for (const [index, child] of node.children.entries()) {
    const excludedPath = findExcludedTranscriptNodePath(child, [...path, 'children', index]);
    if (excludedPath !== null) return excludedPath;
  }
  return null;
}

function isPluginTranscriptPresentationNodeV1(
  node: PluginDeclarativeNodeV2,
): node is PluginTranscriptPresentationNodeV1 {
  return findExcludedTranscriptNodePath(node) === null;
}

/**
 * Strict parser for the persisted plugin-transcript profile.
 *
 * The canonical V2 schema remains the sole owner of node fields, child
 * structure, localization, icon, and JSON-value validation. This profile only
 * removes live controls and Account Collection data recursively, so a new V2
 * node cannot reach persistence until the explicit closure checks above are
 * updated.
 */
export const PluginTranscriptPresentationNodeV1Schema = PluginDeclarativeNodeV2Schema.transform((node, ctx) => {
  if (isPluginTranscriptPresentationNodeV1(node)) return node;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...(findExcludedTranscriptNodePath(node) ?? [])],
    message: 'Plugin transcript presentations cannot contain live controls, targeted contributors, Composer mutations, or Account Collection data.',
  });
  return z.NEVER;
});
