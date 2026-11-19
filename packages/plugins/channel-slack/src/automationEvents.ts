import {
  parseConversationProviderAutomationEventObservationV1, assertConversationChannelsCoreCallerV1,
  CONVERSATION_CORE_PLUGIN_ID_V1, CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionsSnapshotV1Schema, hasCurrentConversationProviderConnectionV1,
  type ConversationProviderAutomationEventAdmitResultV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  admitSessionSocketPluginEventObservationV1,
  createPluginEventAutomationSetupResultV1JsonSchema,
  type PluginEventAutomationSetupResultV1,
} from '@happier-dev/plugin-sdk/events';
import { defineProtocolObject, defineProtocolString, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import { materializeExactSlackCredentials } from './slackActions.js';
import { createSlackApi } from './slackApi.js';
import { SLACK_PLUGIN_ID, SLACK_CONNECTED_ACCOUNT_ID, SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
  createSlackAutomationMessageSourceInstanceId, createSlackConnectionKey } from './slackPluginConstants.js';

const slackId = { type: 'string', minLength: 1, pattern: '^[A-Z0-9]+$' } as const;
export const SLACK_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { v: { type: 'integer', const: 1 }, teamId: slackId, appId: slackId, channelId: slackId },
  required: ['v', 'teamId', 'appId', 'channelId'],
} satisfies PluginJsonSchema;

export const SLACK_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    teamId: slackId, channelId: slackId,
    channelKind: { type: 'string', enum: ['direct', 'shared', 'thread'] },
    messageId: { type: 'string', minLength: 1, pattern: '^[0-9]+\\.[0-9]+$' },
    text: { type: 'string' },
    actorKind: { type: 'string', enum: ['human', 'integration', 'bot', 'unknown'] },
    actorPrincipalId: { type: 'string', minLength: 1 },
    addressingEvidence: { type: 'string', enum: ['directIntegrationMention', 'integrationRoleMention', 'replyToIntegration', 'none'] },
    replyToMessageId: { type: 'string', minLength: 1, pattern: '^[0-9]+\\.[0-9]+$' },
  },
  required: ['teamId', 'channelId', 'channelKind', 'messageId', 'text', 'actorKind', 'addressingEvidence'],
} satisfies PluginJsonSchema;

const setupInput = defineProtocolObject({
  credentialRef: QualifiedConnectedAccountRefSchema,
  channelId: defineProtocolString({ minLength: 1, pattern: '^[CDG][A-Z0-9]+$' }),
}, { policy: 'closed' });
export const SLACK_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA = setupInput.jsonSchema;
export const SLACK_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA = createPluginEventAutomationSetupResultV1JsonSchema(
  SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION, SLACK_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
);
export const SLACK_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS = {
  title: 'Watch a Slack conversation',
  description: 'Choose the Slack bot and conversation whose messages should start this Workflow.',
  submitLabel: 'Watch conversation',
  fields: [
    { path: 'credentialRef', title: 'Slack bot account', widget: 'select', connectedAccountOptions: true,
      required: true, requireExplicitSelection: true },
    { path: 'channelId', title: 'Conversation ID', widget: 'text', required: true,
      description: 'Enter a channel or direct conversation ID the bot can already read.' },
  ],
} as const;

/** Source setup resolves provider facts; Channels owns whether that connection can observe. */
export async function setupSlackAutomationMessageSource(input: unknown, context: PluginInvocationContext): Promise<PluginEventAutomationSetupResultV1> {
  const { credentialRef, channelId } = setupInput.parse(input);
  if (credentialRef.service.pluginId !== SLACK_PLUGIN_ID || credentialRef.service.localId !== SLACK_CONNECTED_ACCOUNT_ID) {
    throw new PluginError({ code: 'slack_automation_source_credential_invalid', message: 'Select a Slack bot Connected Account.' });
  }
  const credentials = await materializeExactSlackCredentials(context, credentialRef);
  if ('kind' in credentials) throw new PluginError({ code: `slack_bot_${credentials.reason}`, message: credentials.diagnostic ?? 'Slack credentials are unavailable.' });
  const api = createSlackApi({ credentials, http: context.services.http });
  const identity = await api.getIdentity({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) throw new PluginError({ code: `slack_bot_${identity.reason}`, message: identity.diagnostic ?? 'Slack identity could not be verified.' });
  const connections = ConversationProviderConnectionsSnapshotV1Schema.parse(await context.services.actions.execute({
    pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
  }, {}, { signal: context.signal }));
  if (!hasCurrentConversationProviderConnectionV1({ connections, credentialRef,
    providerConnectionKey: createSlackConnectionKey(identity) })) {
    throw new PluginError({ code: 'slack_automation_channels_connection_required',
      message: 'Set up and enable this Slack app in Channels before watching a conversation.',
      remediation: { kind: 'openSettings', path: '/settings/plugins/happier.channels/connections' } });
  }
  const channel = await api.getChannel(channelId, { signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in channel) throw new PluginError({ code: `slack_channel_${channel.reason}`, message: channel.diagnostic ?? 'Slack did not return the selected conversation.' });
  if (channel.id !== channelId || channel.isArchived) throw new PluginError({ code: 'slack_automation_source_channel_unavailable', message: 'Choose an active Slack conversation the bot can read.' });
  const sourceConfig = { v: 1, teamId: identity.teamId, appId: identity.appId, channelId: channel.id };
  return { v: 1, sourceInstanceId: createSlackAutomationMessageSourceInstanceId(sourceConfig),
    sourceContractVersion: SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION, sourceConfig,
    displayLabel: channel.name ? `#${channel.name}` : `Slack conversation ${channel.id}` };
}

export async function admitSlackAutomationEvent(input: unknown, context: PluginInvocationContext): Promise<ConversationProviderAutomationEventAdmitResultV1> {
  assertConversationChannelsCoreCallerV1(context, { code: 'slack_channels_core_caller_required', message: 'Slack provider operations require the Channels core caller.' });
  const disposition = await admitSessionSocketPluginEventObservationV1(parseConversationProviderAutomationEventObservationV1(input), context);
  return { kind: disposition.kind };
}
