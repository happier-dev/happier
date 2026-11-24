import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { HomeHubLayoutV1Schema, HomeHubLayoutIntentSchema } from '../../home/homeHubLayoutV1.js';
import { formatGovernanceApprovalSummary } from './definition.js';
import { WidgetInstanceV1Schema } from '../../widgets/widgetInstanceV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { WidgetSizeV1Schema } from '../../widgets/widgetPresentationV1.js';
import { WidgetLayoutGroupV1Schema } from '../../widgets/widgetLayoutItemV1.js';
import { readRecord } from '../../inputs/inputRecords.js';

export const HOME_HUB_LAYOUT_UPDATE_ACTION_ID = 'home.hub.layout.update';
export const HOME_HUB_LAYOUT_ACTION_IDS = ['home.hub.layout.get', HOME_HUB_LAYOUT_UPDATE_ACTION_ID, 'home.reachNudge.dismiss'] as const;
const HOME_LAYOUT_TITLE = 'Customize Home';
export type HomeHubLayoutActionId = typeof HOME_HUB_LAYOUT_ACTION_IDS[number];

const sectionId = z.string().check(z.minLength(1));
export { HomeHubLayoutIntentSchema };
export type { HomeHubLayoutIntent } from '../../home/homeHubLayoutV1.js';

export const HomeHubLayoutGetInputSchema = lazyZodSchema(() => z.strictObject({}));
export const HomeHubLayoutUpdateInputSchema = lazyZodSchema(() => z.strictObject({ intent: HomeHubLayoutIntentSchema }));
export const HomeReachNudgeDismissInputSchema = lazyZodSchema(() => z.strictObject({ homeServerId: z.string().check(z.trim(), z.minLength(1)) }));
export const HomeReachNudgeDismissResultSchema = lazyZodSchema(() => z.strictObject({ homeIdentityId: z.string().check(z.minLength(1)), dismissed: z.literal(true) }));
const builtinSectionSchema = lazyZodSchema(() => z.strictObject({ id: sectionId, kind: z.literal('builtin'), hidden: z.boolean(), hideable: z.boolean(), frameStyle: z.optional(z.enum(['card', 'plain'])) }));
const widgetSectionSchema = lazyZodSchema(() => z.strictObject({ id: sectionId, kind: z.literal('widget'), hidden: z.boolean(), hideable: z.literal(true), frameStyle: z.optional(z.enum(['card', 'plain'])), instance: WidgetInstanceV1Schema, size: WidgetSizeV1Schema }));
const groupSectionSchema = lazyZodSchema(() => z.strictObject({ id: sectionId, kind: z.literal('group'), hidden: z.boolean(), hideable: z.literal(true), frameStyle: z.enum(['card', 'plain']), group: WidgetLayoutGroupV1Schema, children: z.array(widgetSectionSchema) }));
export const HomeHubLayoutResultSchema = lazyZodSchema(() => z.strictObject({
  layout: HomeHubLayoutV1Schema,
  sections: z.array(z.discriminatedUnion('kind', [builtinSectionSchema, widgetSectionSchema, groupSectionSchema])),
  availableWidgetIds: z.array(sectionId),
  hiddenSetupStepIds: z.array(sectionId),
}));

type SimpleHomeLayoutApprovalEffect = 'move' | 'moveIntoGroup' | 'moveOutOfGroup' | 'reorder'
  | 'hide' | 'show' | 'frame' | 'defaultFrame' | 'hideSetup' | 'showSetup' | 'restoreSetup' | 'reset'
  | 'addWidget' | 'removeWidget' | 'rename' | 'defaultName' | 'inputs' | 'resetInputs' | 'size'
  | 'addGroup' | 'ungroup' | 'groupAppearance' | 'groupInputs' | 'removeItem' | 'groupWidth' | 'network';

export type HomeLayoutApprovalEffect =
  | Readonly<{ kind: SimpleHomeLayoutApprovalEffect }>
  | Readonly<{ kind: 'groupCreate'; title?: string; widgetIds: readonly string[] }>;

export function readHomeLayoutApprovalEffect(input: unknown): HomeLayoutApprovalEffect | null {
  const parsed = HomeHubLayoutUpdateInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const { intent } = parsed.data;
  switch (intent.kind) {
    case 'move':
      if ('groupId' in intent && intent.groupId !== undefined) {
        return { kind: intent.groupId === null ? 'moveOutOfGroup' : 'moveIntoGroup' };
      }
      return { kind: 'move' };
    case 'move_to': return { kind: 'move' };
    case 'reorder': return { kind: 'reorder' };
    case 'visibility': return { kind: intent.hidden ? 'hide' : 'show' };
    case 'frameStyle':
    case 'frame': return { kind: intent.frameStyle === null ? 'defaultFrame' : 'frame' };
    case 'setup_visibility': return { kind: intent.hidden ? 'hideSetup' : 'showSetup' };
    case 'restore_setup': return { kind: 'restoreSetup' };
    case 'reset': return { kind: 'reset' };
    case 'widget_add':
    case 'add': return { kind: 'addWidget' };
    case 'widget_remove': return { kind: 'removeWidget' };
    case 'widget_rename':
    case 'rename': return { kind: intent.displayName ? 'rename' : 'defaultName' };
    case 'widget_inputs':
    case 'inputs': return { kind: 'inputs' };
    case 'widget_inputs_reset':
    case 'inputs_reset': return { kind: 'resetInputs' };
    case 'widget_size':
    case 'size': return { kind: 'size' };
    case 'group_create': return { kind: 'groupCreate', title: intent.title, widgetIds: intent.instanceIds };
    case 'group_add': return { kind: 'addGroup' };
    case 'group_ungroup': return { kind: 'ungroup' };
    case 'group_set': return { kind: 'groupAppearance' };
    case 'group_inputs': return { kind: 'groupInputs' };
    case 'remove': return { kind: 'removeItem' };
    case 'width': return { kind: 'groupWidth' };
    case 'network': return { kind: 'network' };
  }
}

function createHomeHubLayoutActionSpecs() {
  return [
  {
    id: 'home.reachNudge.dismiss', approval: {result: 'required'}, title: 'Dismiss Home reachability suggestion',
    description: 'Permanently dismiss the selected Home’s reachability suggestion on this client device. Other devices are unchanged.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [],
    bindings: { mcpToolName: 'home_reach_nudge_dismiss', voiceClientToolName: 'dismissHomeReachNudge' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false },
    inputSchema: HomeReachNudgeDismissInputSchema, outputSchema: HomeReachNudgeDismissResultSchema,
    approvalPresentation: {
      inputHints: { fields: [
        { path: 'homeServerId', title: 'Home', widget: 'text', required: true },
        { path: 'clientId', title: 'Client ID', widget: 'text' },
      ] },
      referenceForField: (path, value) => path === 'homeServerId' && typeof value === 'string'
        ? { kind: 'home', id: value, unavailableWithoutName: true } : undefined,
      technicalInputPaths: ['clientId'],
    },
    inputHints: { fields: [{ path: 'homeServerId', title: 'Saved Home ID', widget: 'text', required: true }] },
    examples: { voice: { argsExample: '{"homeServerId":"home-1"}' } },
  },
  {
    id: 'home.hub.layout.get', approval: {result: 'required'}, title: 'Read Home customization',
    description: 'Read this Home and Account’s section order, visibility, configured widget and group items and available widgets.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'home_hub_layout_get', voiceClientToolName: 'readHomeLayout', rpcMethod: 'home.hub.layout.get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: HomeHubLayoutGetInputSchema, outputSchema: HomeHubLayoutResultSchema,
    inputHints: { fields: [] },
    examples: { voice: { argsExample: '{}' } },
  },
  {
    id: HOME_HUB_LAYOUT_UPDATE_ACTION_ID, approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'required'}, title: HOME_LAYOUT_TITLE,
    description: 'Reorder, move, show or hide Home sections and layout items, create and edit groups, set or clear a frame style override, mark or dismiss individual setup steps, restore them or reset the layout. Start and attention stay visible.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    safetyForInput: (input: unknown) => {
      const parsed = HomeHubLayoutUpdateInputSchema.safeParse(input);
      if (!parsed.success) return 'safe';
      const intent = parsed.data.intent;
      // Automation keeps removal's danger floor. Own UI edits classify reference
      // placements versus deleted content through the canonical admitted layout.
      return intent.kind === 'remove' || (intent.kind === 'widget_remove' && !intent.expectedInstance)
        ? 'danger' : 'safe';
    },
    bindings: { mcpToolName: 'home_hub_layout_update', voiceClientToolName: 'customizeHomeLayout', rpcMethod: 'home.hub.layout.update' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: HomeHubLayoutUpdateInputSchema, outputSchema: HomeHubLayoutResultSchema,
    approvalPresentation: {
      summary: (input, context) => {
        const effect = readHomeLayoutApprovalEffect(input);
        return effect ? formatGovernanceApprovalSummary(context, { kind: 'homeLayout', effect }, () => HOME_LAYOUT_TITLE) : null;
      },
      inputHints: { fields: [
        { path: 'intent', title: 'Customization intent', widget: 'json', required: true },
        { path: 'intent.instanceIds', title: 'projects.dashboard.widgets', widget: 'json' },
      ] },
      technicalInputPaths: [
        'intent.kind', 'intent.instance.id', 'intent.group.id', 'intent.group.children.[].instance.id',
        'intent.expectedInstance.id', 'intent.expectedInstance.definition.id', 'intent.expectedInstance.definition.artifactId',
        'intent.expectedPresentation.groupId',
        { path: 'intent.groupId', when: { path: 'intent.kind', equals: 'group_create' } },
      ],
      clearInputPaths: ['intent.displayName', 'intent.frameStyle', 'intent.groupId'],
      referenceForField: (path, value, input) => {
        if (typeof value !== 'string') return undefined;
        if (path === 'intent.stepId') return { kind: 'homeSetupStep', id: value };
        if (path === 'intent.sectionId' || path === 'intent.instanceId' || path === 'intent.position.anchorId'
          || path === 'intent.sectionIds.[]' || path === 'intent.instanceIds.[]') return { kind: 'homeLayoutItem', id: value };
        if (path === 'intent.instance.definition.artifactId' || path === 'intent.group.children.[].instance.definition.artifactId') {
          return { kind: 'artifact', id: value, unavailableWithoutName: true };
        }
        if (path === 'intent.instance.definition.id' || path === 'intent.group.children.[].instance.definition.id') {
          return { kind: 'builtinWidget', id: value };
        }
        // Creating a group allocates this ID. In all other intents it selects a saved group.
        if (path === 'intent.groupId' && readRecord(readRecord(input).intent).kind !== 'group_create') {
          return { kind: 'homeLayoutItem', id: value };
        }
        return undefined;
      },
    },
    inputHints: { fields: [{ path: 'intent', title: 'Customization intent', widget: 'json', required: true,
      description: 'Use move, move_to (sectionId, position: anchorId and before/after placement), reorder, visibility, frameStyle (card/plain/null), setup_visibility (stepId, hidden), restore_setup, reset, widget_add (instance, optional size, position and destination groupId), widget_remove (instanceId), widget_rename (instanceId, optional displayName), widget_inputs (instanceId, bindings) or widget_size (instanceId, declared size). Shared item intents include group_create, group_add, group_ungroup, group_set, group_inputs, remove, rename, size, width, frame, inputs, inputs_reset and move (instanceId, toIndex, optional groupId; null moves out). move_to preserves concurrent additions. Read the current layout first; reorder lists all sections returned by that read.' }] },
    examples: { voice: { argsExample: '{"intent":{"kind":"visibility","sectionId":"machines","hidden":false}}' } },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const HOME_HUB_LAYOUT_ACTION_SPECS: ReturnType<typeof createHomeHubLayoutActionSpecs> = lazyActionSpecArray(createHomeHubLayoutActionSpecs);
