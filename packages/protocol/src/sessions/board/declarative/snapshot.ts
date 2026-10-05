import { z } from 'zod';
import { sameStrictJsonValue } from '../../../json/strictJsonValue.js';
import { SessionSurfaceDeclarativeDocumentV1Schema } from './authoring.js';
import { freezePluginDeclarativeDataNodeV1, isPluginDeclarativeDataNodeV1, type PluginDeclarativeDataNodeV1 } from '../../../plugins/contributions/ui/declarativeDataV1.js';
import type { PluginDeclarativeDocumentV1 } from '../../../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';

export const WidgetSnapshotMetadataV1Schema = z.object({
  asOf: z.iso.datetime(),
  provenance: z.array(z.object({ label: z.string().trim().min(1), digest: z.string().trim().min(1).optional() }).strict()),
}).strict();
export type WidgetSnapshotMetadataV1 = z.infer<typeof WidgetSnapshotMetadataV1Schema>;

/** A frozen publication has no Action, plugin binding, Markdown fetch, or hidden data. */
export const WidgetSnapshotDocumentV1Schema = SessionSurfaceDeclarativeDocumentV1Schema.superRefine((document, context) => {
  const pending = [document.root];
  const inert = new Set(['text', 'status', 'stack', 'group', 'list', 'section', 'item', 'metadata', 'state']);
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isPluginDeclarativeDataNodeV1(node)) {
      if (node.data.kind !== 'value') context.addIssue({ code: 'custom', message: 'A snapshot cannot retain executable data sources' });
      else {
        try {
          if (!sameStrictJsonValue(node, freezePluginDeclarativeDataNodeV1(node, node.data.value))) context.addIssue({ code: 'custom', message: 'A snapshot contains unprojected data' });
        } catch { context.addIssue({ code: 'custom', message: 'Snapshot data is invalid' }); }
      }
    } else if (!inert.has(node.kind) || (node.kind === 'item' && (node.action !== undefined || node.input !== undefined))) {
      context.addIssue({ code: 'custom', message: 'A snapshot cannot retain executable nodes or bindings' });
    }
    if ('children' in node) pending.push(...node.children);
  }
});
export type WidgetSnapshotDocumentV1 = z.infer<typeof WidgetSnapshotDocumentV1Schema>;

export const WidgetSnapshotPreviewV1Schema = z.object({ v: z.literal(1), document: WidgetSnapshotDocumentV1Schema,
  ...WidgetSnapshotMetadataV1Schema.shape }).strict();
export type WidgetSnapshotPreviewV1 = z.infer<typeof WidgetSnapshotPreviewV1Schema>;

const SNAPSHOT_INERT_NODE_KINDS = new Set(['text', 'status', 'stack', 'group', 'list', 'section', 'item', 'metadata', 'state']);

/**
 * The output a person previews before posting: every live data node replaced by the exact frozen
 * node they are looking at (keyed by its document path, `root.children[1]`), executable and fetching
 * nodes left out, an item's Action and input removed. Nothing is read again; a live node with no
 * frozen counterpart makes the whole preview unavailable rather than partly current.
 */
export function projectWidgetSnapshotPreviewV1(input: Readonly<{
  document: PluginDeclarativeDocumentV1;
  frozenByPath: ReadonlyMap<string, PluginDeclarativeDataNodeV1>;
  asOf: string;
  provenance: WidgetSnapshotMetadataV1['provenance'];
}>): WidgetSnapshotPreviewV1 | null {
  let missing = false;
  const project = (node: unknown, path: string): unknown => {
    const record = node as Readonly<Record<string, unknown>> & { kind: string };
    if (isPluginDeclarativeDataNodeV1(record)) {
      const data = record;
      if (data.data.kind === 'value') return freezePluginDeclarativeDataNodeV1(data, data.data.value);
      const frozen = input.frozenByPath.get(path);
      if (!frozen || frozen.data.kind !== 'value') missing = true;
      return frozen ?? null;
    }
    if (!SNAPSHOT_INERT_NODE_KINDS.has(record.kind)) return null;
    const { action: _action, input: _input, children, ...rest } = record as Readonly<Record<string, unknown>>;
    const copy: Record<string, unknown> = record.kind === 'item' ? rest : { ...rest, ...(_action === undefined ? {} : { action: _action }), ...(_input === undefined ? {} : { input: _input }) };
    if (Array.isArray(children)) copy.children = children.map((child, index) => project(child, `${path}.children[${index}]`)).filter((child) => child !== null);
    return copy;
  };
  try {
    const root = project(input.document.root, 'root');
    if (missing || root === null) return null;
    const parsed = WidgetSnapshotPreviewV1Schema.safeParse({ v: 1, document: { ...input.document, root }, asOf: input.asOf, provenance: input.provenance });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
