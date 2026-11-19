import { z } from '../../zodRuntimePolicy.js';
import { BrowserOpenViewCommandV1Schema } from '../../browser/control/v1.js';
import { BrowserViewTargetKindV1Schema, type BrowserViewTargetKindV1 } from '../../browser/target/v1.js';
import { BrowserViewportEmulationV1Schema, BrowserViewportPresetIdV1Schema } from '../../browser/input/v1.js';
import { BrowserExtensionSourceV1Schema } from '../../browser/profile/extensionsV1.js';
import { ComputerAccessV1Schema, ComputerProviderIdV1Schema, ComputerTargetV1Schema,
  ComputerInputOperationV1Schema, type ComputerInputOperationV1 } from '../../computer/v1.js';
import { COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR } from '../../installables/definitions/computerCuaDriver.js';
import { COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR } from '../../installables/definitions/computerAgentDesktop.js';
import type { ActionInputFieldHint } from '../actionInputHints.js';
import { unwrapActionInputSchema } from '../actionInputSchemaPath.js';

function words(value: string): string {
  const text = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const FIELD_TITLES: Readonly<Record<string, string>> = {
  machineId: 'Machine', sessionId: 'Session', browserSessionId: 'Browser session', viewId: 'Browser page',
  commandId: 'Request', automationRequestId: 'Request', scopeId: 'Workspace',
  url: 'URL', currentUrl: 'Current URL', profileId: 'Browser profile', displayName: 'Name',
  extensionId: 'Extension', recordingId: 'Recording', contextId: 'Captured context',
  engineOverride: 'Open in', navigationIntent: 'Navigation', actionKind: 'Browser action',
  requestedBy: 'Requested by', requesterRef: 'Requester', payload: 'Action details',
  requestedTarget: 'Window or app', provider: 'Computer driver', access: 'Access',
  timeoutMs: 'Time limit (milliseconds)', navigationGeneration: 'Observed navigation',
};

const TEXT_FIELDS = new Set([
  'machineId', 'sessionId', 'browserSessionId', 'viewId', 'commandId', 'automationRequestId', 'scopeId',
  'profileId', 'displayName', 'extensionId', 'recordingId', 'contextId', 'requestedTarget',
]);

/** Refine declared operands only; the schema-derived hint owner fills every other field. */
function fieldsForSchema(schema: z.ZodMiniType, nested: readonly ActionInputFieldHint[],
  choiceLabels: Readonly<Record<string, Readonly<Record<string, string>>>>,
  authored: readonly ActionInputFieldHint[] = []): readonly ActionInputFieldHint[] {
  const root = unwrapActionInputSchema(schema).schema;
  if (!(root instanceof z.ZodMiniObject)) return authored;
  const fields: ActionInputFieldHint[] = [];
  for (const [path, field] of Object.entries(root.shape)) {
    const unwrapped = unwrapActionInputSchema(field).schema;
    const title = FIELD_TITLES[path] ?? words(path);
    if (unwrapped instanceof z.ZodMiniEnum) {
      fields.push({ path, title, widget: 'select', required: !z.safeParse(field, undefined).success,
        options: unwrapped.options.map(value => ({ value, label: choiceLabels[path]?.[String(value)] ?? words(String(value)) })) });
    } else if (TEXT_FIELDS.has(path) || path === 'url' || path === 'currentUrl') {
      fields.push({ path, title, widget: path === 'url' || path === 'currentUrl' ? 'url' : 'text',
        required: !z.safeParse(field, undefined).success });
    } else if (path === 'payload' || path === 'requesterRef') {
      fields.push({ path, title, widget: 'json', required: !z.safeParse(field, undefined).success });
    } else if (path === 'timeoutMs' || path === 'navigationGeneration') {
      fields.push({ path, title, widget: 'integer', required: !z.safeParse(field, undefined).success });
    }
  }
  return [...new Map([...fields, ...nested.filter(field => Object.hasOwn(root.shape, field.path.split('.')[0]!)),
    ...authored].map(field => [field.path, field])).values()];
}

const BROWSER_LOCATION_LABELS = {
  managed: 'Browser on the Machine', embedded: 'Happier',
} satisfies Record<Exclude<z.infer<typeof BrowserOpenViewCommandV1Schema>['engineOverride'], undefined>, string>;

const BROWSER_PAGE_TYPE_LABELS = {
  localServicePreview: 'Local service', hostedPluginWeb: 'Plugin page', externalUrl: 'Website',
  streamedBrowser: 'Browser on the Machine', simulatorPreview: 'Simulator',
} satisfies Record<BrowserViewTargetKindV1, string>;

const VIEWPORT_LABELS = { fitViewer: 'Fit the pane', preset: 'Device preview' } satisfies
  Record<z.infer<typeof BrowserViewportEmulationV1Schema>['kind'], string>;
const EXTENSION_SOURCE_LABELS = { webStore: 'Browser extension store', unpacked: 'Folder on the Machine' } satisfies
  Record<z.infer<typeof BrowserExtensionSourceV1Schema>['kind'], string>;

export function readBrowserActionInputHintFields(schema: z.ZodMiniType,
  authored: readonly ActionInputFieldHint[]): readonly ActionInputFieldHint[] {
  return fieldsForSchema(schema, [
    { path: 'target.kind', title: 'Page type', widget: 'select',
      options: BrowserViewTargetKindV1Schema.options.map(value => ({ value, label: BROWSER_PAGE_TYPE_LABELS[value] })) },
    { path: 'target.url', title: 'URL', widget: 'url', visibleWhen: { op: 'eq', path: 'target.kind', value: 'externalUrl' } },
    { path: 'target.machineId', title: 'Machine', widget: 'text', visibleWhen: { op: 'eq', path: 'target.kind', value: 'localServicePreview' } },
    { path: 'emulation.kind', title: 'Page size', widget: 'select',
      options: BrowserViewportEmulationV1Schema._zod.def.options.map(option => {
        const value = option.shape.kind._zod.def.values[0]!;
        return { value, label: VIEWPORT_LABELS[value] };
      }) },
    { path: 'emulation.presetId', title: 'Device', widget: 'select',
      options: BrowserViewportPresetIdV1Schema.options.map(value => ({ value, label: words(value) })),
      visibleWhen: { op: 'eq', path: 'emulation.kind', value: 'preset' } },
    { path: 'source.kind', title: 'Extension source', widget: 'select',
      options: BrowserExtensionSourceV1Schema._zod.def.options.map(option => {
        const value = option.shape.kind._zod.def.values[0]!;
        return { value, label: EXTENSION_SOURCE_LABELS[value] };
      }) },
  ], { engineOverride: BROWSER_LOCATION_LABELS }, authored);
}

const COMPUTER_ACCESS_LABELS = { see: 'View only', use: 'View and control' } satisfies
  Record<z.infer<typeof ComputerAccessV1Schema>, string>;
const COMPUTER_DRIVER_LABELS = {
  cua: COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR.display.name,
  'agent-desktop': COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR.display.name,
} satisfies Record<z.infer<typeof ComputerProviderIdV1Schema>, string>;
const COMPUTER_OPERATION_LABELS = {
  move: 'Move the pointer', click: 'Click', press: 'Press a key', type: 'Type text',
  drag: 'Drag', wheel: 'Scroll', element: 'Interact with an element',
} satisfies Record<ComputerInputOperationV1['kind'], string>;

export function readComputerActionInputHintFields(schema: z.ZodMiniType): readonly ActionInputFieldHint[] {
  return fieldsForSchema(schema, [
    { path: 'target.kind', title: 'Share', widget: 'select',
      options: ComputerTargetV1Schema._zod.def.options.map(option => {
        const value = option.shape.kind._zod.def.values[0]!;
        return { value, label: value === 'display' ? 'Display' : 'Window' };
      }) },
    { path: 'operation.kind', title: 'Input', widget: 'select',
      options: [...new Set(ComputerInputOperationV1Schema._zod.def.options.flatMap(option => option instanceof z.ZodMiniObject
        ? option.shape.kind._zod.def.values : option._zod.def.options.flatMap(branch => branch.shape.kind._zod.def.values)))]
        .map(value => ({ value, label: COMPUTER_OPERATION_LABELS[value] })) },
  ], { access: COMPUTER_ACCESS_LABELS, provider: COMPUTER_DRIVER_LABELS });
}
