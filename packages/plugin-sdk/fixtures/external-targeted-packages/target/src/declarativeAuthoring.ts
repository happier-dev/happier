/**
 * A representative external author of the declarative document grammar.
 *
 * Every export here is INFERRED rather than annotated, which is the point: an
 * annotation lets TypeScript reprint the author's own words, while an inferred
 * export forces it to name the types the SDK actually gave them. If any of
 * those names lives in a package the author cannot resolve — Protocol reaches
 * them only as a bundled copy nested under the SDK — the declaration build
 * stops with TS2883 and this fixture fails, which is the only reason a leak in
 * the SDK's declarative vocabulary is observable at all.
 */
import type { PluginDeclarativeNodeV2 } from '@happier-dev/plugin-sdk/manifest';

/**
 * An authored document, written as a plain literal exactly as a plugin manifest
 * would carry it. It exercises every container the grammar admits so a
 * tightened arm that authors can no longer express fails here first.
 */
export const physicalCopyDeclarativeDocument: PluginDeclarativeNodeV2 = {
  kind: 'stack',
  direction: 'vertical',
  gap: 'medium',
  children: [
    { kind: 'text', text: 'Physical copy sources', tone: 'muted' },
    { kind: 'markdown', text: { key: 'sources.summary', fallback: 'Sources' } },
    {
      kind: 'group',
      title: 'Configuration',
      children: [
        {
          kind: 'field',
          label: 'Source name',
          control: { kind: 'text', settingId: 'source-name' },
        },
        {
          kind: 'field',
          label: 'Mode',
          control: {
            kind: 'select',
            settingId: 'source-mode',
            options: [
              { value: 'mirror', label: 'Mirror' },
              { value: 42, label: { key: 'mode.batch', fallback: 'Batch' } },
            ],
          },
        },
        { kind: 'status', label: 'State', value: 'Ready', tone: 'success' },
      ],
    },
    {
      kind: 'list',
      label: 'Entries',
      children: [
        {
          kind: 'section',
          title: 'Recent',
          footer: 'Updated moments ago',
          children: [
            {
              kind: 'item',
              title: 'external-42',
              subtitle: 'Physical package source',
              icon: 'file',
              tone: 'default',
              action: { pluginId: 'fixture.physical-copy-target', localId: 'inspect' },
              input: { entryId: 'external-42', nested: [1, true, null] },
            },
            { kind: 'state', state: 'loading', title: 'Loading more', icon: 'refresh' },
          ],
        },
        { kind: 'state', state: 'empty', title: 'No archived entries' },
      ],
    },
    {
      kind: 'actionPanel',
      title: 'Actions',
      children: [
        { kind: 'action', label: 'Inspect', variant: 'primary', action: 'inspect' },
        {
          kind: 'action',
          label: 'Insert reference',
          effect: {
            kind: 'composerApply',
            expectedRevision: 3,
            operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'external-42' }],
          },
        },
      ],
    },
    {
      kind: 'metadata',
      title: 'Details',
      entries: [
        { label: 'Origin', value: 'external', tone: 'muted' },
        { label: 'Entries', value: '1' },
      ],
    },
    {
      kind: 'collectionList',
      source: { collectionId: 'sources', uiQueryId: 'recent', parameters: { limit: 20 } },
      projection: {
        titleField: { field: 'name', kind: 'string' },
        statusField: { field: 'active', kind: 'boolean' },
      },
      primaryCommand: { kind: 'action', action: 'inspect' },
      secondaryCommands: [{ kind: 'openSurface', destination: 'detail' }],
    },
  ],
};

// Read through an array element so control-flow analysis cannot narrow the
// document back to the single arm its literal happens to use: the point is to
// exercise every arm's inference, not the one this fixture authored.
const authoredDocuments: PluginDeclarativeNodeV2[] = [physicalCopyDeclarativeDocument];
const declarativeNode = authoredDocuments[0] as PluginDeclarativeNodeV2;

export const declarativeActionNode = declarativeNode.kind === 'action' ? declarativeNode : null;
export const declarativeItemNode = declarativeNode.kind === 'item' ? declarativeNode : null;
export const declarativeSectionNode = declarativeNode.kind === 'section' ? declarativeNode : null;
export const declarativeListNode = declarativeNode.kind === 'list' ? declarativeNode : null;
export const declarativeStateNode = declarativeNode.kind === 'state' ? declarativeNode : null;
export const declarativeMetadataNode = declarativeNode.kind === 'metadata' ? declarativeNode : null;
export const declarativeActionPanelNode = declarativeNode.kind === 'actionPanel'
  ? declarativeNode
  : null;
export const declarativeCollectionListNode = declarativeNode.kind === 'collectionList'
  ? declarativeNode
  : null;
export const declarativeFieldControl = declarativeNode.kind === 'field'
  ? declarativeNode.control
  : null;
export const declarativeTargetedSurfaceReference = declarativeNode.kind === 'targetedSurface'
  ? declarativeNode.surface
  : null;
export const declarativeComposerApplyEffect = declarativeNode.kind === 'action'
  ? declarativeNode.effect
  : undefined;
export const declarativeItemInput = declarativeNode.kind === 'item'
  ? declarativeNode.input
  : undefined;
export const declarativeRoundTrip = (() => declarativeNode)();

export function readPhysicalCopyDeclarativeKind(node: PluginDeclarativeNodeV2) {
  return node.kind;
}
