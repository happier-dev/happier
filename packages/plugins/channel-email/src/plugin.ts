import { setupEmailNotificationDestination, sendEmailNotification } from './channelActions.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { ConversationProvidersContributionProtocolV1 as providers, CONVERSATION_CORE_PLUGIN_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { EmailTransportsContributionPointV1 } from './transports.js';
import { EMAIL_CHANNEL_PLUGIN_ID, EMAIL_CHANNEL_ACTION_IDS as ids } from './constants.js';
import { setupEmailChannels, testEmailConnection, resolveEmailEndpoint, resolveEmailPrincipal, pollEmailObservations, deliverEmailMessage, reconcileEmailDelivery, fetchEmailAttachment, EMAIL_SETUP_INPUT_SCHEMA } from './channelActions.js';

import { EMAIL_SETUP_INPUT_HINTS } from './ui/setupHints.js';
import { IMAP_SMTP_CONNECTED_ACCOUNT_ID, IMAP_SMTP_CREDENTIAL_PURPOSE,
  imapSmtpActions, imapSmtpConnectedAccountDescriptor, imapSmtpTransportContribution } from './transports/imapSmtp/index.js';

function providerAction(
  title: string,
  declaration: { surfaces: readonly ('plugin' | 'ui' | 'cli' | 'agent' | 'mcp' | 'voice')[]; dangerLevel: 'safe' | 'writesLocal' | 'writesRemote' | 'externalSideEffect' | 'destructive'; resultSchema: { jsonSchema: PluginJsonSchema } },
  inputSchema: PluginJsonSchema,
  run: ActionHandler,
) {
  return { title, inputSchema, resultSchema: declaration.resultSchema.jsonSchema,
    surfaces: declaration.surfaces, dangerLevel: declaration.dangerLevel, run };
}

export const emailPlugin = definePlugin({
  id: EMAIL_CHANNEL_PLUGIN_ID, version: '0.0.0', displayName: 'Email Channels',
  description: 'Connects authenticated mailbox conversations to Happier Channels.', entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: IMAP_SMTP_CREDENTIAL_PURPOSE, capability: 'connectedAccounts',
      reason: 'Authenticate the selected mailbox for IMAP and SMTP operations.',
      scope: { serviceRefs: [IMAP_SMTP_CONNECTED_ACCOUNT_ID], operations: ['select', 'use'], materializationKinds: ['environment'] } },
    { id: 'microsoft-token', capability: 'network', reason: 'Authenticate Microsoft app-only mailbox access.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://login.microsoftonline.com' }], methods: ['POST'] } },
  ], optional: [] },
  brand: { iconResourceId: 'email-brand' },
  resources: { 'email-brand': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  ui: { translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
  ] },
  contributionPoints: { transports: EmailTransportsContributionPointV1 },
  connectedAccountDescriptors: { [IMAP_SMTP_CONNECTED_ACCOUNT_ID]: imapSmtpConnectedAccountDescriptor },
  notificationChannels: { alerts: { declaration: { title: 'Email', kind: 'plugin', metadata: { destinationSetup: { pluginId: EMAIL_CHANNEL_PLUGIN_ID, localId: ids.notificationSetup } } }, sender: sendEmailNotification } },
  actions: {
    [ids.notificationSetup]: {
      title: 'Choose Email notification destination',
      surfaces: providers.operations.notificationDestinationSetup.declaration.surfaces,
      dangerLevel: providers.operations.notificationDestinationSetup.declaration.dangerLevel,
      inputSchema: providers.operations.notificationDestinationSetup.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.notificationDestinationSetup.declaration.resultSchema.jsonSchema,
      run: setupEmailNotificationDestination,
    },
    ...imapSmtpActions,
    [ids.setup]: {
      ...providerAction('Set up Email Channels', providers.operations.setup.declaration, EMAIL_SETUP_INPUT_SCHEMA.jsonSchema, setupEmailChannels),
      inputHints: EMAIL_SETUP_INPUT_HINTS,
      hostAccess: [IMAP_SMTP_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: IMAP_SMTP_CREDENTIAL_PURPOSE }],
    },
    [ids.connectionTest]: providerAction('Test email connection', providers.operations.connectionTest.declaration, providers.operations.connectionTest.declaration.input.schema.jsonSchema, testEmailConnection),
    [ids.endpointResolve]: providerAction('Resolve mailbox destination', providers.operations.endpointResolve.declaration, providers.operations.endpointResolve.declaration.input.schema.jsonSchema, resolveEmailEndpoint),
    [ids.principalResolve]: providerAction('Resolve email principal', providers.operations.principalResolve.declaration, providers.operations.principalResolve.declaration.input.schema.jsonSchema, resolveEmailPrincipal),
    [ids.observationsPoll]: providerAction('Poll mailbox observations', providers.operations.observationsPoll.declaration, providers.operations.observationsPoll.declaration.input.schema.jsonSchema, pollEmailObservations),
    [ids.messageDeliver]: providerAction('Deliver email message', providers.operations.messageDeliver.declaration, providers.operations.messageDeliver.declaration.input.schema.jsonSchema, deliverEmailMessage),
    [ids.deliveryReconcile]: providerAction('Reconcile email delivery', providers.operations.deliveryReconcile.declaration, providers.operations.deliveryReconcile.declaration.input.schema.jsonSchema, reconcileEmailDelivery),
    [ids.attachmentFetch]: providerAction('Fetch email attachment', providers.operations.attachmentFetch.declaration, providers.operations.attachmentFetch.declaration.input.schema.jsonSchema, fetchEmailAttachment),
  },
  contributesTo: {
    [EMAIL_CHANNEL_PLUGIN_ID]: { transports: { 'imap-smtp': imapSmtpTransportContribution } },
    [CONVERSATION_CORE_PLUGIN_ID_V1]: {
      providers: { 'email-provider': providers.contribute({ descriptor: { v: 1, displayName: 'Email' }, operations: {
        setup: providers.operations.setup.bind(ids.setup),
        notificationDestinationSetup: providers.operations.notificationDestinationSetup.bind(ids.notificationSetup),
      connectionTest: providers.operations.connectionTest.bind(ids.connectionTest),
        endpointResolve: providers.operations.endpointResolve.bind(ids.endpointResolve),
        principalResolve: providers.operations.principalResolve.bind(ids.principalResolve),
        observationsPoll: providers.operations.observationsPoll.bind(ids.observationsPoll),
        messageDeliver: providers.operations.messageDeliver.bind(ids.messageDeliver),
        deliveryReconcile: providers.operations.deliveryReconcile.bind(ids.deliveryReconcile),
        attachmentFetch: providers.operations.attachmentFetch.bind(ids.attachmentFetch),
      } }) },
    },
  },
});
export const EMAIL_TRANSPORT_POINT_REF = emailPlugin.contributionPoints.transports;
export const PLUGIN_MANIFEST = emailPlugin.manifest;
export const activate = emailPlugin.activate;
