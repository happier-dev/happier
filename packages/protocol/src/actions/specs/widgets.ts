import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import {
  WIDGET_INSTANCE_ACTION_IDS_V1, WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1,
} from '../../widgets/actionsV1.js';
import {
  WIDGET_DEFINITION_ACTION_IDS_V1, WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1,
} from '../../widgets/definitionActionsV1.js';
import { WidgetSnapshotPostInputV1Schema, WidgetSnapshotPostOutputV1Schema } from '../../widgets/widgetSnapshotV1.js';

export const WIDGET_INSTANCE_ACTION_SPECS_V1 = WIDGET_INSTANCE_ACTION_IDS_V1.map(id => {
  const read = id.endsWith('.list') || id.endsWith('.get') || id.endsWith('.validate');
  const refresh = id.endsWith('.refresh');
  return {
    id, title: id, description: id === 'widgets.instance.move'
      ? 'Reorder in the same surface/view with toIndex (configured-widget ordinal), or move to an explicit qualified destination using to.index (native mixed-content insertion index).'
      : id === 'widgets.instance.add' ? 'Add through the canonical owner; viewer bindings resolve through the current viewer\'s existing Connected Account purpose selection.'
      : 'Operate on a qualified widget instance through its canonical surface owner.',
    safety: read || refresh ? 'safe' : 'danger',
    sideEffectClass: read || refresh ? 'read' : 'write',
    executionPlacement: refresh ? 'client' : 'account',
    requiredAuthority: 'account_automation', placements: [],
    bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: WidgetInstanceActionInputSchemasV1[id], outputSchema: WidgetInstanceActionOutputSchemasV1[id],
    inputHints: { fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } as const satisfies PreNormalizedActionSpec;
});

export const WIDGET_DEFINITION_ACTION_SPECS_V1 = WIDGET_DEFINITION_ACTION_IDS_V1.map(id => {
  const read = id === 'widgets.definition.list' || id === 'widgets.definition.get';
  return {
    id, title: id,
    description: id === 'widgets.definition.update'
      ? 'Edit an Account widget definition used by every referencing placement. Duplicate first to make an independent copy.'
      : id === 'widgets.definition.saveFromSession'
        ? 'Copy admitted Session widget content into your Account library without removing the Session item; Session context becomes configurable inputs.'
        : id === 'widgets.definition.delete'
          ? 'Delete the Account widget definition while retaining its placements for repair or removal.'
          : 'Read or author a reusable Account widget through the existing mode-aware Artifact owner.',
    safety: id === 'widgets.definition.update' || id === 'widgets.definition.delete' ? 'danger' : 'safe',
    sideEffectClass: read ? 'read' : 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
    placements: [], bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: WidgetDefinitionActionInputSchemasV1[id], outputSchema: WidgetDefinitionActionOutputSchemasV1[id],
    inputHints: { fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } as const satisfies PreNormalizedActionSpec;
});

export const WIDGET_SNAPSHOT_ACTION_SPECS_V1 = [{
  id: 'widgets.snapshot.post', title: 'Post a widget snapshot',
  description: 'Publish the exact previewed frozen output and as-of provenance as an inert shared Session Board item. The approved payload is never queried again.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
  placements: [], bindings: { mcpToolName: 'widgets_snapshot_post', rpcMethod: 'widgets.snapshot.post' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: WidgetSnapshotPostInputV1Schema, outputSchema: WidgetSnapshotPostOutputV1Schema,
  inputHints: { fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: ['widgets', 'snapshot', 'post'], visibility: 'canonical' }] },
}] as const satisfies readonly PreNormalizedActionSpec[];
