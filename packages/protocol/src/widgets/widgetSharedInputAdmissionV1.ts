import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { readPluginDeclarativeDataSourcesV1 } from '../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { WidgetDefinitionV1StoredSchema } from './widgetDefinitionV1.js';

const ConnectedAccountSelectionSchema = createStoredReadSchema(asProtocolZod(QualifiedConnectedAccountRefSchema));
export type WidgetSharedInputIssueV1 = Readonly<{
  instanceId: string;
  inputPath?: string;
  path: readonly (string | number)[];
  reasonCode: 'widget_private_connection_selection' | 'widget_shared_resource_input_literal';
  /** Review identifies the service, never the author's account choice or credential. */
  service?: Readonly<{ pluginId: string; localId: string }>;
}>;

function privateSelections(value: unknown, stopAfterFirst = false) {
  const found: Readonly<{ path: readonly (string | number)[]; service: Readonly<{ pluginId: string; localId: string }> }>[] = [];
  const pending: { value: unknown; path: (string | number)[] }[] = [{ value, path: [] }];
  while (pending.length) {
    const next = pending.pop()!;
    if (!next.value || typeof next.value !== 'object') continue;
    const parsed = ConnectedAccountSelectionSchema.safeParse(next.value);
    if (parsed.success) {
      found.push({ path: next.path, service: parsed.data.service });
      if (stopAfterFirst) return found;
    }
    const entries = Array.isArray(next.value) ? next.value.map((child, index) => [index, child] as const) : Object.entries(next.value);
    for (const [key, child] of entries) pending.push({ value: child, path: [...next.path, key] });
  }
  return found;
}

/** Opaque JSON and additive stored fields cannot hide a private selection. */
export function containsPrivateConnectedAccountSelection(value: unknown): boolean {
  return privateSelections(value, true).length > 0;
}

export function findWidgetPrivateInputSelectionsV1(instance: unknown): readonly WidgetSharedInputIssueV1[] {
  const instanceId = instance && typeof instance === 'object' && 'id' in instance && typeof instance.id === 'string' ? instance.id : '';
  return privateSelections(instance).map(selection => ({ instanceId, ...selection, reasonCode: 'widget_private_connection_selection',
    ...(selection.path[0] === 'bindings' && typeof selection.path[1] === 'string' ? { inputPath: selection.path[1] } : {}) }));
}

/** Content privacy only. The Artifact owner separately admits actor, keys and view/edit access. */
export function getWidgetSharedInputIssuesV1(instance: unknown): readonly WidgetSharedInputIssueV1[] {
  const issues = [...findWidgetPrivateInputSelectionsV1(instance)];
  if (!instance || typeof instance !== 'object' || !('definition' in instance)) return issues;
  const ref = instance.definition;
  if (!ref || typeof ref !== 'object' || !('kind' in ref) || ref.kind !== 'inline' || !('definition' in ref)) return issues;
  const definition = WidgetDefinitionV1StoredSchema.safeParse(ref.definition);
  if (definition.success && definition.data.body.kind === 'declarative'
    && readPluginDeclarativeDataSourcesV1(definition.data.body.document).some(source => source.kind === 'resource' && source.input !== undefined)) {
    issues.push({ instanceId: 'id' in instance && typeof instance.id === 'string' ? instance.id : '',
      path: ['definition'], reasonCode: 'widget_shared_resource_input_literal' });
  }
  return issues;
}
