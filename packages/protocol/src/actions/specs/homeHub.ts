import { z } from 'zod';
import { HomeHubLayoutV1Schema, HomeHubLayoutIntentSchema } from '../../home/homeHubLayoutV1.js';
import { WidgetInstanceV1Schema } from '../../widgets/widgetInstanceV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { WidgetSizeV1Schema } from '../../widgets/widgetPresentationV1.js';

export const HOME_HUB_LAYOUT_ACTION_IDS = ['home.hub.layout.get', 'home.hub.layout.update', 'home.reachNudge.dismiss'] as const;
export type HomeHubLayoutActionId = typeof HOME_HUB_LAYOUT_ACTION_IDS[number];

const sectionId = z.string().min(1);
export { HomeHubLayoutIntentSchema };
export type { HomeHubLayoutIntent } from '../../home/homeHubLayoutV1.js';

export const HomeHubLayoutGetInputSchema = z.object({}).strict();
export const HomeHubLayoutUpdateInputSchema = z.object({ intent: HomeHubLayoutIntentSchema }).strict();
export const HomeReachNudgeDismissInputSchema = z.object({ homeServerId: z.string().trim().min(1) }).strict();
export const HomeReachNudgeDismissResultSchema = z.object({ homeIdentityId: z.string().min(1), dismissed: z.literal(true) }).strict();
export const HomeHubLayoutResultSchema = z.object({
  layout: HomeHubLayoutV1Schema,
  sections: z.array(z.object({ id: sectionId, kind: z.enum(['builtin', 'widget']), hidden: z.boolean(), hideable: z.boolean(), frameStyle: z.enum(['card', 'plain']).optional(), instance: WidgetInstanceV1Schema.optional(), size: WidgetSizeV1Schema.optional() }).strict()),
  availableWidgetIds: z.array(sectionId),
  hiddenSetupStepIds: z.array(sectionId),
}).strict();

export const HOME_HUB_LAYOUT_ACTION_SPECS = [
  {
    id: 'home.reachNudge.dismiss', title: 'Dismiss Home reachability suggestion',
    description: 'Permanently dismiss the selected Home’s reachability suggestion on this client device. Other devices are unchanged.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [],
    bindings: { mcpToolName: 'home_reach_nudge_dismiss', voiceClientToolName: 'dismissHomeReachNudge' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false },
    inputSchema: HomeReachNudgeDismissInputSchema, outputSchema: HomeReachNudgeDismissResultSchema,
    inputHints: { fields: [{ path: 'homeServerId', title: 'Saved Home ID', widget: 'text', required: true }] },
    examples: { voice: { argsExample: '{"homeServerId":"home-1"}' } },
  },
  {
    id: 'home.hub.layout.get', title: 'Read Home customization',
    description: 'Read this Home and Account’s section order, visibility, configured widget instances and available widgets.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'home_hub_layout_get', voiceClientToolName: 'readHomeLayout', rpcMethod: 'home.hub.layout.get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: HomeHubLayoutGetInputSchema, outputSchema: HomeHubLayoutResultSchema,
    inputHints: { fields: [] },
    examples: { voice: { argsExample: '{}' } },
  },
  {
    id: 'home.hub.layout.update', title: 'Customize Home',
    description: 'Reorder, move, show or hide Home sections and widgets, set or clear a frame style override, mark or dismiss individual setup steps, restore them or reset the layout. Start and attention stay visible.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'home_hub_layout_update', voiceClientToolName: 'customizeHomeLayout', rpcMethod: 'home.hub.layout.update' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: HomeHubLayoutUpdateInputSchema, outputSchema: HomeHubLayoutResultSchema,
    inputHints: { fields: [{ path: 'intent', title: 'Customization intent', widget: 'json', required: true,
      description: 'Use move, move_to (sectionId, position: anchorId and before/after placement), reorder, visibility, frameStyle (card/plain/null), setup_visibility (stepId, hidden), restore_setup, reset, widget_add (instance, optional size and position), widget_remove (instanceId), widget_rename (instanceId, optional displayName), widget_inputs (instanceId, bindings) or widget_size (instanceId, declared size). move_to preserves concurrent additions. Read the current layout first; reorder lists all sections returned by that read.' }] },
    examples: { voice: { argsExample: '{"intent":{"kind":"visibility","sectionId":"machines","hidden":false}}' } },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
