import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { NotificationsNotifyMeInputV1Schema, NotificationsNotifyMeResultV1Schema } from '../../account/notifications/notifyMeV1.js';
import type { PreNormalizedActionSpec } from './definition.js';


function createNotificationDeliveryActionSpecs() {
  return Object.freeze([
  {
    id: 'notifications.notify_me', approval: {result: 'required'},
    title: 'Notify me',
    description: "Send a notification to your Account's configured channels, following your delivery policy.",
    sideEffectClass: 'write',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    bindings: {
      voiceClientToolName: 'notifyMe',
      mcpToolName: 'notifications_notify_me',
      rpcMethod: 'notifications.notify_me',
    },
    examples: {
      voice: { argsExample: '{"title":"Tests finished","message":"The test run on the API branch passed."}' },
    },
    surfaces: { ui: false, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Notify me',
      fields: [
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'open', title: 'Open', description: 'Optional Session or Workflow run link.', widget: 'json' },
        { path: 'channels', title: 'Send to', widget: 'multiselect', optionsSourceId: 'notifications.channels.available' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{ path: ['notify'], positionals: ['message'], visibility: 'canonical' }],
      flagAliases: [{ path: 'message', aliases: ['-p'] }, { path: 'title', aliases: ['-t'] }],
    },
    inputSchema: NotificationsNotifyMeInputV1Schema,
    outputSchema: NotificationsNotifyMeResultV1Schema,
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const NOTIFICATION_DELIVERY_ACTION_SPECS: ReturnType<typeof createNotificationDeliveryActionSpecs> = lazyActionSpecArray(createNotificationDeliveryActionSpecs);

