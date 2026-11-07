import { lazyActionSpecArray } from '../lazyActionSpecValue.js';

import type { ApprovalPresentationContext, PreNormalizedActionSpec } from '../actionSpecs.js';
import type { InputFieldHint } from '../../inputs/inputFields.js';
import { WIDGET_SIZE_ORDER_V1, WidgetGroupWidthV1Schema, WidgetProjectAreaV1Schema } from '../../widgets/widgetPresentationV1.js';
import {
  WIDGET_INSTANCE_ACTION_IDS_V1, WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1,
  readWidgetActionSurfaceV1, readWidgetActionDestinationV1,
  type WidgetInstanceActionIdV1,
} from '../../widgets/actionsV1.js';
import {
  WIDGET_DEFINITION_ACTION_IDS_V1, WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1,
  type WidgetDefinitionActionIdV1,
} from '../../widgets/definitionActionsV1.js';
import { WidgetSnapshotPostInputV1Schema, WidgetSnapshotPostOutputV1Schema } from '../../widgets/widgetSnapshotV1.js';
import { readBuiltinWidgetDescriptorV1 } from '../../widgets/builtinWidgetDescriptorV1.js';
import { WidgetDefinitionRefV1Schema } from '../../widgets/widgetInstanceV1.js';
import { WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1, WidgetLayoutFragmentActionInputSchemasV1, WidgetLayoutFragmentActionOutputSchemasV1,
  type WidgetLayoutFragmentActionIdV1 } from '../../widgets/fragmentActionsV1.js';
import { readWidgetLayoutFragmentApprovalNameV1 } from '../../widgets/fragmentActionsV1.js';

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const WIDGET_INSTANCE_ACTION_COPY = {
  'widgets.catalog.list': ['List available widgets', 'See the widgets you can add, from Happier, your plugins and your own library.'],
  'widgets.item.list': ['List widgets', 'See the widgets in one place, such as a dashboard or a session board, in their order.'],
  'widgets.item.add': ['Add widget', 'Put a widget on a dashboard or a board.'],
  'widgets.item.remove': ['Remove widget', 'Take a widget off a dashboard or a board. Removing a group removes the widgets in it.'],
  'widgets.item.move': ['Move widget', 'Change where a widget sits: its order, its group, or the dashboard it is on.'],
  'widgets.item.rename': ['Rename widget', 'Change the name shown on a widget.'],
  'widgets.item.size.set': ['Resize widget', 'Change how wide or tall a widget is.'],
  'widgets.item.frame.set': ['Change widget frame', 'Choose how a widget is framed, such as with or without its card and title.'],
  'widgets.item.network.set': ['Change widget network', 'Choose which sites this widget can contact from its guest frame.'],
  'widgets.item.inputs.get': ['Read widget settings', 'See what a widget is set to show, such as its project or time range.'],
  'widgets.item.inputs.validate': ['Check widget settings', 'Check that new settings for a widget would work, without saving them.'],
  'widgets.item.inputs.set': ['Change widget settings', 'Change what a widget shows, such as its project or time range.'],
  'widgets.item.inputs.reset': ['Reset widget settings', 'Put a widget back to its default settings.'],
  'widgets.item.refresh': ['Refresh widget', 'Load a widget\'s data again now.'],
  'widgets.group.create': ['Group widgets', 'Put widgets that are already there into one group.'],
  'widgets.group.add': ['Add saved group', 'Add a copy of a saved group of widgets to Home or a widget area.'],
  'widgets.group.ungroup': ['Ungroup widgets', 'Remove a group and keep the widgets that were in it.'],
  'widgets.group.set': ['Change widget group', 'Change a group\'s width and whether lines separate its widgets.'],
  'widgets.group.inputs.set': ['Change widget group settings', 'Set what the widgets in a group show together, such as one project for all of them.'],
  'widgets.area.layout.select': ['Switch dashboard', 'Show a different dashboard.'],
  'widgets.area.layout.reset': ['Reset dashboard', 'Put a dashboard back to how Happier set it up. You can undo this right after.'],
  'widgets.area.layout.undo': ['Undo dashboard reset', 'Bring back the dashboard as it was before you reset it.'],
  'widgets.area.layout.list': ['List dashboards', 'See the dashboards a place has.'],
  'widgets.area.layout.create': ['Create dashboard', 'Add a dashboard, empty or as a copy of the current one.'],
  'widgets.area.layout.rename': ['Rename dashboard', 'Change a dashboard\'s name.'],
  'widgets.area.layout.delete': ['Delete view', 'Remove a view with its widgets. People it was shared with lose it too.'],
  'widgets.area.layout.reorder': ['Reorder dashboards', 'Change the order dashboards are listed in.'],
} as const satisfies Record<WidgetInstanceActionIdV1, readonly [title: string, summary: string]>;

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const WIDGET_DEFINITION_ACTION_COPY = {
  'widgets.definition.list': ['List your widgets', 'See the widgets saved in your library.'],
  'widgets.definition.get': ['Read one of your widgets', 'See one widget from your library and what it is made of.'],
  'widgets.definition.create': ['Create widget', 'Add a widget of your own to your library.'],
  'widgets.definition.update': ['Update one of your widgets', 'Change a widget in your library. Every place that shows it changes too.'],
  'widgets.definition.duplicate': ['Duplicate one of your widgets', 'Make a copy of a widget in your library to change on its own.'],
  'widgets.definition.delete': ['Delete one of your widgets', 'Remove a widget from your library. Places that showed it keep an empty spot you can fix or remove.'],
  'widgets.definition.saveFromSession': ['Save session widget to your library', 'Keep a widget a session made, so you can use it elsewhere. The session keeps its copy.'],
} as const satisfies Record<WidgetDefinitionActionIdV1, readonly [title: string, summary: string]>;

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const WIDGET_LAYOUT_FRAGMENT_ACTION_COPY = {
  'widgets.fragment.list': ['List saved groups', 'See the groups of widgets saved in your library.'],
  'widgets.fragment.get': ['Read saved group', 'See one saved group and the widgets in it.'],
  'widgets.fragment.create': ['Save widget group', 'Save a group of widgets to your library to reuse.'],
  'widgets.fragment.update': ['Update saved group', 'Change a saved group. Copies already added somewhere stay as they are.'],
  'widgets.fragment.duplicate': ['Duplicate saved group', 'Make a copy of a saved group to change on its own.'],
  'widgets.fragment.delete': ['Delete saved group', 'Remove a saved group from your library. Copies already added somewhere stay.'],
} as const satisfies Record<WidgetLayoutFragmentActionIdV1, readonly [title: string, summary: string]>;

// Presentation of the existing Action schemas, not a second value/admission owner.
const surfaceField = { path: 'surface', title: 'Widget surface', widget: 'json', required: true,
  description: 'Qualified target with serverId, accountId and owner. Public profile layouts and presets use owner:{kind:"corePage",pageId:"public-profile",area:"main",layoutId}. For a named area layout, include owner.layoutId; discover layouts with widgets.area.layout.list. Public profile layout edits stay private until reviewed Publish or Apply.' } as const satisfies InputFieldHint;
const refField = { path: 'ref', title: 'Widget or group', widget: 'json', required: true,
  description: 'Qualified surface and instanceId from widgets.item.list. A group uses its group id as instanceId.' } as const satisfies InputFieldHint;
const accountField = { path: 'account', title: 'Library Account', widget: 'json', required: true,
  description: 'The library owner, qualified by serverId and accountId.' } as const satisfies InputFieldHint;
const artifactField = { path: 'artifactId', title: 'Library item id', widget: 'text', required: true,
  description: 'Artifact id from the library list, or a new UUID when creating an item. Keep that UUID for retries of the same creation.' } as const satisfies InputFieldHint;
const bindingsField = { path: 'bindings', title: 'Input bindings', widget: 'json', required: true,
  description: 'Bindings by declared field path: value, context or viewer intent. A value must satisfy the widget’s inputSchema from widgets.catalog.list. Viewer intent uses the current viewer’s existing Connected Account purpose selection.' } as const satisfies InputFieldHint;
const pathsField = { path: 'paths', title: 'Input paths', widget: 'text_list', listSeparator: 'newline',
  description: 'Only change these declared field paths. Omit to replace or reset the complete binding set.' } as const satisfies InputFieldHint;
const revisionField = { path: 'expectedRevision', title: 'Current layout revision', widget: 'json', required: true,
  description: 'Use the exact revision returned by the current layout read, or null for a missing layout. Intervening edits refuse the change.' } as const satisfies InputFieldHint;
const nameField = { path: 'name', title: 'Name', widget: 'text', required: true } as const satisfies InputFieldHint;
const widthField = { path: 'width', title: 'Group width', widget: 'select',
  options: WidgetGroupWidthV1Schema.options.map(value => ({ value, label: value === 'half' ? 'Half width' : 'Full width' })),
  description: 'The selected width must fit every child widget.' } as const satisfies InputFieldHint;
const sizeField = { path: 'size', title: 'Widget size', widget: 'select',
  options: WIDGET_SIZE_ORDER_V1.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
  description: 'Choose a size declared by this widget and supported by the target surface; inspect widgets.catalog.list for available sizes.' } as const satisfies InputFieldHint;
const areaField = { path: 'area', title: 'Project area', widget: 'select',
  options: WidgetProjectAreaV1Schema.options.map(value => ({ value, label: value === 'main' ? 'Main' : 'Aside' })),
  description: 'For Project layouts, choose the main area or aside in the same document.' } as const satisfies InputFieldHint;
const indexField = { path: 'toIndex', title: 'Insertion index', widget: 'integer',
  description: 'Zero-based widget position in the current view.' } as const satisfies InputFieldHint;
const groupIdField = { path: 'groupId', title: 'Group id', widget: 'text',
  description: 'A group id in the selected surface, as returned by widgets.item.list.' } as const satisfies InputFieldHint;

function sentenceCaseIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const words = value.trim().replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function quote(value: string): string {
  return `“${value}”`;
}

function widgetSurfaceApprovalLabel(surface: ReturnType<typeof readWidgetActionSurfaceV1>, presentation?: ApprovalPresentationContext['widgetPresentation']): string {
  if (!surface) return 'the selected surface';
  const owner = surface.owner;
  if (owner.kind === 'corePage') {
    return `${sentenceCaseIdentifier(owner.pageId, 'Page')} · ${sentenceCaseIdentifier(owner.area, 'Main')} area`;
  }
  if (owner.kind === 'pluginArea') {
    if (presentation?.pageName?.trim()) return `${presentation.pageName.trim()} · ${presentation.areaName?.trim() || sentenceCaseIdentifier(owner.area, 'Main')}`;
    return `Plugin page · ${sentenceCaseIdentifier(owner.area, 'Main')} area`;
  }
  if (owner.kind === 'project') return owner.layoutId ? 'Project dashboard' : 'Project · Overview';
  if (owner.kind === 'sessionBoard') return 'Session board';
  if (owner.kind === 'workBoard') return 'Work board';
  if (owner.kind === 'companion') return 'Session companion';
  return 'Home';
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function widgetApprovalName(raw: unknown): string | null {
  const instance = readRecord(raw);
  if (typeof instance.displayName === 'string' && instance.displayName.trim()) return instance.displayName.trim();
  const definition = WidgetDefinitionRefV1Schema.safeParse(instance.definition);
  return definition.success ? readBuiltinWidgetDescriptorV1(definition.data)?.title ?? null : null;
}

/** A widget the input names reads by that name; one it cannot name is described, never quoted as "widget". */
function widgetApprovalPhrase(raw: unknown): string {
  const name = widgetApprovalName(raw);
  if (name) return quote(name);
  return WidgetDefinitionRefV1Schema.safeParse(readRecord(raw).definition).data?.kind === 'artifact' ? 'a saved widget' : 'the widget';
}

function widgetGroupApprovalContents(raw: unknown): string {
  const group = readRecord(raw);
  const children = Array.isArray(group.children) ? group.children : [];
  const names = children.map(child => widgetApprovalName(readRecord(child).instance) ?? 'Widget');
  return names.length ? ` with ${names.join(' · ')}` : '';
}

/** Domain-owned approval sentence for widget mutations; raw structured operands stay in Details. */
function describeWidgetActionApprovalSummary(actionId: WidgetInstanceActionIdV1, input: unknown, context?: ApprovalPresentationContext): string | null {
  const value = readRecord(input);
  const surface = readWidgetActionSurfaceV1(input);
  const target = widgetSurfaceApprovalLabel(surface, context?.widgetPresentation);
  const instance = readRecord(value.instance);
  const group = readRecord(value.group);
  const capture = readRecord(value.capture);
  const captureSurface = readWidgetActionSurfaceV1({ surface: capture.surface });
  const item = context?.widgetPresentation?.widgetName?.trim() ? quote(context.widgetPresentation.widgetName.trim()) : widgetApprovalPhrase(instance);
  const groupName = sentenceCaseIdentifier(value.title ?? group.title, 'group');
  const size = typeof value.size === 'string' ? value.size : null;
  const width = typeof value.width === 'string' ? `${value.width} width` : null;

  switch (actionId) {
    case 'widgets.item.add': return `Add ${item}${size ? ` (${size})` : ''} to ${target}.`;
    case 'widgets.item.remove': return `Remove ${item} from ${target}.`;
    case 'widgets.item.move': return `Move ${item} to ${widgetSurfaceApprovalLabel(readWidgetActionDestinationV1(input) ?? surface)}.`;
    case 'widgets.item.rename': return `Rename ${item} to ${value.displayName === null ? 'its default name' : quote(sentenceCaseIdentifier(value.displayName, 'widget'))} on ${target}.`;
    case 'widgets.item.size.set': return `Resize ${item} to ${size ?? width ?? 'the selected size'} on ${target}.`;
    case 'widgets.item.frame.set': return `Show ${item} with ${value.frameStyle === null ? 'the surface default frame' : `${String(value.frameStyle)} framing`} on ${target}.`;
    case 'widgets.item.network.set': return `Change network access for ${item} on ${target}.`;
    case 'widgets.item.inputs.set': return `Change settings for ${item} on ${target}.`;
    case 'widgets.item.inputs.reset': return `Reset settings for ${item} on ${target}.`;
    case 'widgets.item.refresh': return `Refresh ${item} on ${target}.`;
    case 'widgets.group.create': return `Create ${quote(groupName)} on ${target}.`;
    case 'widgets.group.add': {
      return `Add ${quote(groupName)} to ${target}${widgetGroupApprovalContents(group)}.`;
    }
    case 'widgets.group.ungroup': return `Ungroup ${quote(groupName)} on ${target}.`;
    case 'widgets.group.set': return `Change ${quote(groupName)}${width ? ` to ${width}` : ''} on ${target}.`;
    case 'widgets.group.inputs.set': return `Change shared settings for ${quote(groupName)} on ${target}.`;
    case 'widgets.area.layout.create': return `Create ${quote(sentenceCaseIdentifier(value.name, 'dashboard'))} on ${target}.`;
    case 'widgets.area.layout.rename': return `Rename the dashboard to ${quote(sentenceCaseIdentifier(value.name, 'dashboard'))} on ${target}.`;
    case 'widgets.area.layout.delete': return `Delete the selected view from ${target}.`;
    case 'widgets.area.layout.reorder': return `Reorder the selected dashboard on ${target}.`;
    case 'widgets.area.layout.reset': return `Reset ${target} to its preset.`;
    case 'widgets.area.layout.undo': return `Undo the dashboard reset on ${widgetSurfaceApprovalLabel(captureSurface)}.`;
    default: return null;
  }
}

const WIDGET_INSTANCE_ACTION_FIELDS = {
  'widgets.catalog.list': [surfaceField, { path: 'boundSession', title: 'Widget Session', widget: 'select', optionsSourceId: 'sessions',
    description: 'Optional Home-qualified Session supplying widget discovery context. Selecting it grants no access.' }],
  'widgets.item.list': [surfaceField],
  'widgets.item.add': [surfaceField, { path: 'instance', title: 'Configured widget', widget: 'json', required: true,
    description: 'Complete v1 instance with a unique id, definition reference and bindings. A value binding must satisfy the widget’s inputSchema from widgets.catalog.list; use a picked Session, Machine or checkout exactly as action_options_resolve returns it (consumer widget, fieldPath = the input path).' }, areaField, sizeField, indexField,
    { path: 'placement', title: 'Session Board placement', widget: 'json', description: 'Owner-native Session Board tab, view and placement options.' }, groupIdField],
  'widgets.item.remove': [refField],
  'widgets.item.move': [refField, { ...indexField, requiredWhen: { op: 'not', predicate: { op: 'truthy', path: 'to' } },
    description: 'Zero-based widget position for a move within the current surface. Omit when providing a qualified destination.' },
    { path: 'to', title: 'Move destination', widget: 'json', requiredWhen: { op: 'truthy', path: 'to' },
      description: 'For an explicit destination, provide surface and its native index, with optional tabId, area and groupId. Omit toIndex and the top-level area/groupId.' }, areaField,
    { path: 'groupId', title: 'Destination group', widget: 'json', description: 'Group id in the current surface; null moves out of a group. Omit to retain ordinary current-view reordering.' }],
  'widgets.item.rename': [refField, { path: 'displayName', title: 'Display name', widget: 'json', required: true,
    description: 'A nonempty name string, or null to use the widget’s default name.' }],
  'widgets.item.size.set': [refField, { ...sizeField, requiredWhen: { op: 'not', predicate: { op: 'truthy', path: 'width' } } },
    { ...widthField, requiredWhen: { op: 'truthy', path: 'width' }, description: 'For a group, choose width instead of widget size.' }],
  'widgets.item.frame.set': [refField, { path: 'frameStyle', title: 'Frame', widget: 'select', required: true,
    options: [{ value: 'card', label: 'Card' }, { value: 'plain', label: 'Plain' }, { value: null, label: 'Surface default' }] }],
  'widgets.item.network.set': [refField, { path: 'network', title: 'Guest network', widget: 'json', required: true,
    description: 'Use network none or open, or exact HTTPS networkOrigins. This changes guest egress only and cannot widen installed renderer authority.' }],
  'widgets.item.inputs.get': [refField],
  'widgets.item.inputs.validate': [refField, bindingsField],
  'widgets.item.inputs.set': [refField, bindingsField, pathsField],
  'widgets.item.inputs.reset': [refField, pathsField],
  'widgets.item.refresh': [refField],
  'widgets.group.create': [surfaceField, { ...groupIdField, required: true, description: 'New group id, unique among all layout items and children.' },
    { path: 'instanceIds', title: 'Widgets to group', widget: 'text_list', listSeparator: 'newline', required: true,
      description: 'Existing widget ids from widgets.item.list. Groups cannot nest.' }, widthField,
    { path: 'title', title: 'Group title', widget: 'text', description: 'Omit for an untitled group.' },
    { path: 'context', title: 'Group input bindings', widget: 'json', description: 'Declared bindings inherited by following children. Pinned inputs keep their own values.' }],
  'widgets.group.add': [surfaceField, { path: 'group', title: 'Configured group copy', widget: 'json', required: true,
    description: 'Complete group with fresh group and child ids, child widgets, width, frame and divider options.' }, indexField],
  'widgets.group.ungroup': [refField],
  'widgets.group.set': [refField, widthField, { path: 'dividers', title: 'Child dividers', widget: 'select',
    options: [{ value: 'hairline', label: 'Lines' }, { value: 'none', label: 'No lines' }] }],
  'widgets.group.inputs.set': [refField, { ...bindingsField, description: 'Group bindings for declared following child inputs. Pins ignore this context; it grants no read authority.' }],
  'widgets.area.layout.list': [surfaceField],
  'widgets.area.layout.select': [surfaceField],
  'widgets.area.layout.create': [surfaceField, { path: 'layoutId', title: 'New layout id', widget: 'text', required: true,
    description: 'New named-layout identity within the qualified area owner.' }, nameField,
    { path: 'fromSurface', title: 'Copy from layout', widget: 'json', description: 'Optional qualified area surface to copy. Omit to create an empty layout.' }],
  'widgets.area.layout.rename': [surfaceField, revisionField, nameField],
  'widgets.area.layout.delete': [surfaceField, revisionField],
  'widgets.area.layout.reorder': [surfaceField, revisionField, { path: 'position', title: 'Layout position', widget: 'json', required: true,
    description: 'Current sibling anchorId with placement before or after. A null anchor selects the start or end.' }],
  'widgets.area.layout.reset': [surfaceField, revisionField],
  'widgets.area.layout.undo': [{ path: 'capture', title: 'Reset Undo capture', widget: 'json', required: true,
    description: 'The complete Undo capture returned by widgets.area.layout.reset. It restores the previous layout only while the acknowledged reset revision is current.' }],
} as const satisfies Record<WidgetInstanceActionIdV1, readonly InputFieldHint[]>;

const WIDGET_DEFINITION_ACTION_FIELDS = {
  'widgets.definition.list': [accountField],
  'widgets.definition.get': [accountField, artifactField],
  'widgets.definition.create': [accountField, artifactField, { path: 'definition', title: 'Widget definition', widget: 'json', required: true,
    description: 'Draft with name, declared sizes, body, input hints and inputSchema; omit persisted id, version and provenance.' }],
  'widgets.definition.update': [accountField, artifactField, { path: 'patch', title: 'Definition changes', widget: 'json', required: true,
    description: 'Only fields to change. This updates every referencing placement; duplicate first for an independent widget.' }],
  'widgets.definition.duplicate': [accountField, artifactField, { path: 'newArtifactId', title: 'Copy id', widget: 'text', required: true,
    description: 'New UUID for the independent copy. Keep that UUID for retries of the same duplication.' },
    { ...nameField, required: false, description: 'Optional name for the independent copy.' }],
  'widgets.definition.delete': [accountField, artifactField],
  'widgets.definition.saveFromSession': [accountField, { path: 'session', title: 'Source Session', widget: 'select', optionsSourceId: 'sessions', required: true },
    { path: 'itemId', title: 'Session Board item id', widget: 'text', required: true }, artifactField,
    { ...nameField, required: false, description: 'Optional library name. The Session keeps its original item.' }],
} as const satisfies Record<WidgetDefinitionActionIdV1, readonly InputFieldHint[]>;

const WIDGET_LAYOUT_FRAGMENT_ACTION_FIELDS = {
  'widgets.fragment.list': [accountField],
  'widgets.fragment.get': [accountField, artifactField],
  'widgets.fragment.create': [accountField, artifactField, { path: 'fragment', title: 'Saved group definition', widget: 'json', required: true,
    description: 'Name, declared inputs and inputSchema, and group options/content without physical group or child ids.' }],
  'widgets.fragment.update': [accountField, artifactField, { path: 'patch', title: 'Saved group changes', widget: 'json', required: true,
    description: 'Only fields to change. Existing placed copies keep their content.' }],
  'widgets.fragment.duplicate': [accountField, artifactField, { path: 'newArtifactId', title: 'Copy id', widget: 'text', required: true },
    { ...nameField, required: false, description: 'Optional name for the independent copy.' }],
  'widgets.fragment.delete': [accountField, artifactField],
} as const satisfies Record<WidgetLayoutFragmentActionIdV1, readonly InputFieldHint[]>;

export const WIDGET_INSTANCE_ACTION_SPECS_V1: readonly (PreNormalizedActionSpec & Readonly<{
  id: WidgetInstanceActionIdV1; requiredAuthority: 'account_automation';
}>)[] = lazyActionSpecArray(() => WIDGET_INSTANCE_ACTION_IDS_V1.map(id => {
  const read = id.endsWith('.list') || id.endsWith('.get') || id.endsWith('.validate');
  const select = id === 'widgets.area.layout.select';
  const refresh = id.endsWith('.refresh');
  return {
    id, approvalPolicy: {
      uiConfirmation: id === 'widgets.area.layout.delete'
        || id === 'widgets.item.network.set' ? 'policy' : 'direct',
      // Session removal deletes shared source content. Other surfaces classify
      // referenced placements versus groups/inline content at admitted read time.
      ...(id === 'widgets.item.remove' ? { uiConfirmationForInput: (input: unknown) =>
        !readWidgetActionSurfaceV1(input) || readWidgetActionSurfaceV1(input)?.owner.kind === 'sessionBoard' } : {}),
      ...(id === 'widgets.item.move' ? { uiConfirmationForInput: (input: unknown) => {
        const source = readWidgetActionSurfaceV1(input);
        const destination = readWidgetActionDestinationV1(input);
        // Entering a different Session publishes to that Session's audience.
        // Reordering within the same Session remains a reversible edit.
        return destination?.owner.kind === 'sessionBoard' && (source?.owner.kind !== 'sessionBoard'
          || source.serverId !== destination.serverId || source.owner.sessionId !== destination.owner.sessionId);
      } } : {}),
    },
    ...(id === 'widgets.area.layout.delete' ? { confirmVerb: {
      key: 'actionPresentation.titles.widgets_area_layout_delete', fallback: 'Delete view',
    } } : {}),
    approval: { result: 'required' }, title: WIDGET_INSTANCE_ACTION_COPY[id][0], description: id === 'widgets.area.layout.reset'
      ? 'Reset a Public profile preset or another host-declared area layout immediately and return a guarded Undo for the acknowledged change. Public profile presets include Minimal, Data-rich, Story and Night owl; the layout stays private until reviewed Publish or Apply.'
      : id === 'widgets.area.layout.undo'
      ? 'Undo a Public profile reset or another area preset Reset, restoring the preceding layout only while that Reset remains the current acknowledged revision.'
      : id.startsWith('widgets.area.layout.')
      ? `${WIDGET_INSTANCE_ACTION_COPY[id][1]} This includes Public profile layouts and presets (Minimal, Data-rich, Story and Night owl), through their existing Artifact owner. Create can copy the current layout; host presets cannot be deleted. Metadata mutations require the current revision; Public profile layouts stay private until reviewed Publish or Apply.`
      : id === 'widgets.group.create'
      ? 'Group existing widget items in a supported surface. New groups default to Card with hairline dividers; groups cannot nest.'
      : id === 'widgets.group.add'
      ? 'Atomically add an independent group copy with fresh group and child ids through the canonical layout owner.'
      : id === 'widgets.group.ungroup'
      ? 'Remove the group shell while keeping its children and restoring their saved frame options.'
      : id === 'widgets.group.inputs.set'
      ? 'Set group inputs for following children. Pins ignore group context; each child retains its own data admission and authority.'
      : id === 'widgets.group.set'
      ? 'Set group width and divider options through the canonical layout owner; widths must fit every child.'
      : id === 'widgets.item.move'
      ? 'Reorder in the same surface/view with toIndex, enter or leave a group with groupId, or move a widget to an explicit qualified destination using to.index. Project main/aside moves use one document mutation.'
      : id === 'widgets.item.add' ? 'Add through the canonical owner; viewer bindings resolve through the current viewer\'s existing Connected Account purpose selection.'
      : id === 'widgets.item.remove'
      ? 'Remove the selected widget or explicitly remove a group with all its children. Ungroup preserves children instead.'
      : 'Operate on a qualified widget layout item through its canonical surface owner.',
    safety: read || refresh || select ? 'safe' : 'danger',
    // Companion keeps only this viewer's placement; shared-content writers retain the danger default.
    ...(id === 'widgets.item.add' ? { safetyForInput: (input: unknown) =>
      readWidgetActionSurfaceV1(input)?.owner.kind === 'companion' ? 'safe' as const : 'danger' as const } : {}),
    sideEffectClass: read || refresh ? 'read' : 'write',
    executionPlacement: refresh || select ? 'client' : 'account',
    executionPlacements: refresh || select ? ['client'] : ['account', 'client'],
    executionPlacementForInput: (input: unknown) => refresh || select
      || readWidgetActionSurfaceV1(input)?.owner.kind === 'companion'
      || (id === 'widgets.item.move' && readWidgetActionDestinationV1(input)?.owner.kind === 'companion')
      ? 'client' as const : 'account' as const,
    requiredAuthority: 'account_automation', placements: [],
    bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: WidgetInstanceActionInputSchemasV1[id], outputSchema: WidgetInstanceActionOutputSchemasV1[id],
    approvalPresentation: { summary: (input, context) => describeWidgetActionApprovalSummary(id, input, context) },
    inputHints: { description: WIDGET_INSTANCE_ACTION_COPY[id][1], fields: WIDGET_INSTANCE_ACTION_FIELDS[id] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } as const satisfies PreNormalizedActionSpec;
}));

const WIDGET_DEFINITION_VOICE_EXAMPLES = {
  'widgets.definition.list': '{"account":{"serverId":"home","accountId":"owner"}}',
  'widgets.definition.get': '{"account":{"serverId":"home","accountId":"owner"},"artifactId":"definition-1"}',
  'widgets.definition.create': '{"account":{"serverId":"home","accountId":"owner"},"artifactId":"49cc4eca-1ed6-4abe-bf70-e3be06cb0730","definition":{"name":"Checks","sizeDeclaration":{"sizes":["medium"],"defaultSize":"medium"},"body":{"kind":"declarative","document":{"version":1,"root":{"kind":"text","text":"Checks"}}},"inputs":{"fields":[]},"inputSchema":{"type":"object","additionalProperties":false}}}',
  'widgets.definition.update': '{"account":{"serverId":"home","accountId":"owner"},"artifactId":"definition-1","patch":{"name":"Updated checks"}}',
  'widgets.definition.duplicate': '{"account":{"serverId":"home","accountId":"owner"},"artifactId":"definition-1","newArtifactId":"b5e2a136-e890-46bf-9ff4-f2fd042ad8eb"}',
  'widgets.definition.delete': '{"account":{"serverId":"home","accountId":"owner"},"artifactId":"definition-1"}',
  'widgets.definition.saveFromSession': '{"account":{"serverId":"home","accountId":"owner"},"session":{"serverId":"home","sessionId":"session-1"},"itemId":"item-1","artifactId":"49cc4eca-1ed6-4abe-bf70-e3be06cb0730"}',
} as const satisfies Record<WidgetDefinitionActionIdV1, string>;

export const WIDGET_DEFINITION_ACTION_SPECS_V1: readonly (PreNormalizedActionSpec & Readonly<{
  id: WidgetDefinitionActionIdV1; requiredAuthority: 'account_automation';
}>)[] = lazyActionSpecArray(() => WIDGET_DEFINITION_ACTION_IDS_V1.map(id => {
  const read = id === 'widgets.definition.list' || id === 'widgets.definition.get';
  return {
    id, approvalPolicy: {
      uiConfirmation: id === 'widgets.definition.delete' ? 'policy' : 'direct',
      ...(id === 'widgets.definition.update' ? { uiConfirmationForInput: (input: unknown) => {
        const update = WidgetDefinitionActionInputSchemasV1['widgets.definition.update'].safeParse(input);
        // Names and content are reversible edits; changing the guest network
        // retains review even when the definition is otherwise editable directly.
        return !update.success || update.data.patch.networkOverride !== undefined;
      } } : {}),
    }, approval: { result: 'required' }, title: WIDGET_DEFINITION_ACTION_COPY[id][0],
    description: id === 'widgets.definition.list'
      ? 'List reusable Account widget summaries. Each definition may include author (kind: person, agent, or plugin) and createdAt (creation timestamp); definitions saved before these provenance facts existed omit them.'
      : id === 'widgets.definition.update'
      ? 'Edit an Account widget definition used by every referencing placement. Duplicate first to make an independent copy.'
      : id === 'widgets.definition.saveFromSession'
        ? 'Copy admitted Session widget content into your Account library without removing the Session item; Session context becomes configurable inputs.'
        : id === 'widgets.definition.delete'
          ? 'Delete the Account widget definition while retaining its placements for repair or removal.'
          : 'Read or author a reusable Account widget through the existing mode-aware Artifact owner.',
    safety: id === 'widgets.definition.update' || id === 'widgets.definition.delete' || id === 'widgets.definition.saveFromSession' ? 'danger' : 'safe',
    sideEffectClass: read ? 'read' : 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
    placements: [], bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: WidgetDefinitionActionInputSchemasV1[id], outputSchema: WidgetDefinitionActionOutputSchemasV1[id],
    inputHints: { description: WIDGET_DEFINITION_ACTION_COPY[id][1], fields: WIDGET_DEFINITION_ACTION_FIELDS[id] },
    examples: { voice: { argsExample: WIDGET_DEFINITION_VOICE_EXAMPLES[id] } },
    cli: { acceptsServerId: true, commands: [{ path: id === 'widgets.definition.saveFromSession'
      ? ['widgets', 'definition', 'save-from-session'] : id.split('.'), visibility: 'canonical' }] },
  } as const satisfies PreNormalizedActionSpec;
}));

export const WIDGET_SNAPSHOT_ACTION_SPECS_V1: readonly (PreNormalizedActionSpec & Readonly<{
  id: 'widgets.snapshot.post'; requiredAuthority: 'account_automation';
  inputSchema: typeof WidgetSnapshotPostInputV1Schema; outputSchema: typeof WidgetSnapshotPostOutputV1Schema;
}>)[] = lazyActionSpecArray(() => [{
  id: 'widgets.snapshot.post', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'required'}, title: 'Post a widget snapshot',
  description: 'Publish the exact previewed frozen output and as-of provenance as an inert shared Session Board item. The approved payload is never queried again.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
  placements: [], bindings: { mcpToolName: 'widgets_snapshot_post', rpcMethod: 'widgets.snapshot.post' },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: WidgetSnapshotPostInputV1Schema, outputSchema: WidgetSnapshotPostOutputV1Schema,
  inputHints: { description: 'Put a frozen copy of what a widget shows now on a session board, for everyone who can see that session.', fields: [
    surfaceField, { path: 'sessionId', title: 'Target Session id', widget: 'text', description: 'Optional assertion; must match the Session Board surface owner.' },
    { path: 'itemId', title: 'Snapshot item id', widget: 'text', required: true },
    { path: 'title', title: 'Snapshot title', widget: 'text', required: true },
    { path: 'preview', title: 'Frozen preview', widget: 'json', required: true,
      description: 'The exact inert document, as-of time and provenance reviewed for publication. The Action never queries the source again.' },
    { path: 'placement', title: 'Session Board placement', widget: 'json', required: true,
      description: 'Target tab, view and owner-native placement for the new snapshot item.' },
  ] },
  cli: { acceptsServerId: true, commands: [{ path: ['widgets', 'snapshot', 'post'], visibility: 'canonical' }] },
  examples: { voice: { argsExample: '{"surface":{"serverId":"home","accountId":"owner","owner":{"kind":"sessionBoard","sessionId":"session-1"}},"itemId":"snapshot-1","title":"Checks","preview":{"v":1,"document":{"version":1,"root":{"kind":"text","text":"All checks passed."}},"asOf":"2026-10-05T10:42:00.000Z","provenance":[{"label":"Checks"}]},"placement":{}}' } },
}] as const satisfies readonly PreNormalizedActionSpec[]);

export const WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1: readonly (PreNormalizedActionSpec & Readonly<{
  id: WidgetLayoutFragmentActionIdV1; requiredAuthority: 'account_automation';
}>)[] = lazyActionSpecArray(() => WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1.map(id => {
  const read = id.endsWith('.list') || id.endsWith('.get');
  return {
    id, approvalPolicy: { uiConfirmation: id === 'widgets.fragment.delete' ? 'policy' : 'direct' }, approval: { result: 'required' }, title: WIDGET_LAYOUT_FRAGMENT_ACTION_COPY[id][0], description: 'Read or author an Account saved group through its mode-aware Artifact owner. Adding it makes independent copies.',
    safety: id.endsWith('.update') || id.endsWith('.delete') ? 'danger' : 'safe',
    sideEffectClass: read ? 'read' : 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
    placements: [], bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: WidgetLayoutFragmentActionInputSchemasV1[id], outputSchema: WidgetLayoutFragmentActionOutputSchemasV1[id],
    approvalPresentation: { summary: input => {
      const value = readRecord(input);
      const fragment = readRecord(value.fragment);
      const name = readWidgetLayoutFragmentApprovalNameV1(input);
      // Without a captured original name, a rename only supplies its new name.
      const targetName = id === 'widgets.fragment.update'
        ? typeof fragment.name === 'string' && fragment.name.trim() ? fragment.name.trim() : null : name;
      const target = targetName ? quote(targetName) : 'the saved group';
      const patch = readRecord(value.patch);
      switch (id) {
        case 'widgets.fragment.create': return `Save ${name ? quote(name) : 'the group'} to Your widgets${widgetGroupApprovalContents(fragment.group)}.`;
        case 'widgets.fragment.update': return typeof patch.name === 'string' && patch.name.trim()
          ? `Rename ${target} to ${quote(patch.name.trim())} in Your widgets.` : `Change ${target} in Your widgets.`;
        case 'widgets.fragment.duplicate': return `Duplicate ${target} in Your widgets.`;
        case 'widgets.fragment.delete': return `Delete ${target} from Your widgets.`;
        default: return null;
      }
    } },
    inputHints: { description: WIDGET_LAYOUT_FRAGMENT_ACTION_COPY[id][1], fields: WIDGET_LAYOUT_FRAGMENT_ACTION_FIELDS[id] }, cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } as const satisfies PreNormalizedActionSpec;
}));
