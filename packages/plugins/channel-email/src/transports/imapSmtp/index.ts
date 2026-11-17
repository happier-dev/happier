import { PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { createProtocolStoredReadSchema, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { classifyConversationProviderMaterializationFailureV1, rethrowConversationProviderLifecycleFailureV1,
  type ConversationProviderFailureV1 } from '@happier-dev/channels-protocol/v1';
import { EmailTransportsContributionProtocolV1 as protocol, EmailTransportConnectionInputV1Schema,
  EmailTransportListSinceInputV1Schema, EmailTransportFetchRawInputV1Schema,
  EmailTransportSubmitRawInputV1Schema, EmailTransportFindSentInputV1Schema,
  type EmailTransportConnectionInputV1 } from '@happier-dev/email-transports-protocol/v1';
import { EMAIL_CHANNEL_PLUGIN_ID } from '../../constants.js';
import { createImapSmtpTransport } from './client.js';
import { IMAP_SMTP_CONNECTED_ACCOUNT_ID, IMAP_SMTP_CREDENTIAL_PURPOSE, IMAP_SMTP_ENVIRONMENT_KEY } from './connectedAccount.js';
import { EmailCredentialError } from './credentials.js';

export { IMAP_SMTP_CONNECTED_ACCOUNT_ID, IMAP_SMTP_CREDENTIAL_PURPOSE, IMAP_SMTP_ENVIRONMENT_KEY,
  imapSmtpConnectedAccountDescriptor, imapSmtpConnectedAccountRuntime } from './connectedAccount.js';

const text = defineProtocolString({ minLength: 1 });
const port = defineProtocolNumber({ integer: true, minimum: 1, maximum: 65535 });
// This is a host-materialized credential document, never an Action input.
const accountReader = createProtocolStoredReadSchema(defineProtocolObject({
  mailbox: text, imapHost: text, imapPort: port, smtpHost: text, smtpPort: port,
  inboxFolder: text, sentFolder: text.optional(), tlsCaPem: text.optional(),
  smtpSecurity: defineProtocolUnion([defineProtocolLiteral('starttls'), defineProtocolLiteral('tls')]).optional(),
  auth: defineProtocolUnion([
    defineProtocolObject({ user: text, pass: text }, { policy: 'closed' }),
    defineProtocolObject({ user: text, accessToken: text }, { policy: 'closed' }),
  ]),
}, { policy: 'closed' }));

function assertEmailCore(context: PluginInvocationContext) {
  if (context.surface !== 'plugin' || context.caller?.kind !== 'plugin' || context.caller.pluginId !== EMAIL_CHANNEL_PLUGIN_ID) {
    throw new PluginError({ code: 'email_core_caller_required', message: 'Email transport operations require the Email core plugin caller.' });
  }
  context.signal.throwIfAborted();
}

async function selectedTransport(input: EmailTransportConnectionInputV1, context: PluginInvocationContext) {
  const ref = input.credentialRef;
  if (!ref || ref.service.pluginId !== EMAIL_CHANNEL_PLUGIN_ID || ref.service.localId !== IMAP_SMTP_CONNECTED_ACCOUNT_ID) {
    return { kind: 'notReady', reason: 'credentialInvalid' } as const;
  }
  try {
    const materialized = await context.services.connectedAccounts.materialize(IMAP_SMTP_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: [IMAP_SMTP_ENVIRONMENT_KEY] }, { expectedAccount: ref, signal: context.signal });
    context.signal.throwIfAborted();
    const encoded = materialized.kind === 'environment' ? materialized.env[IMAP_SMTP_ENVIRONMENT_KEY] : undefined;
    if (!encoded) return { kind: 'notReady', reason: 'credentialInvalid' } as const;
    const value: unknown = JSON.parse(encoded);
    return { transport: createImapSmtpTransport(accountReader.parse(value), undefined, context.services.logger) };
  } catch (error) {
    return classifyConversationProviderMaterializationFailureV1(error, context.signal);
  }
}

async function invoke(input: EmailTransportConnectionInputV1, context: PluginInvocationContext,
  run: (transport: ReturnType<typeof createImapSmtpTransport>) => Promise<JsonValue>): Promise<JsonValue> {
  const selected = await selectedTransport(input, context);
  if ('kind' in selected) return selected;
  try { return await run(selected.transport); }
  catch (error) {
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
    const credentialInvalid = error && typeof error === 'object' && (
      ('authenticationFailed' in error && error.authenticationFailed === true) || ('code' in error && error.code === 'EAUTH'));
    return { kind: 'notReady', reason: error instanceof EmailCredentialError ? error.reason : credentialInvalid ? 'credentialInvalid' : 'network' } satisfies ConversationProviderFailureV1;
  }
}

const ids = {
  listSince: 'transport/imap-smtp/list-since-v1', fetchRaw: 'transport/imap-smtp/fetch-raw-v1',
  submitRaw: 'transport/imap-smtp/submit-raw-v1', connectionTest: 'transport/imap-smtp/connection-test-v1',
  findSent: 'transport/imap-smtp/find-sent-v1',
} as const;

function action(title: string, role: keyof typeof protocol.operations, run: ActionHandler) {
  const declaration = protocol.operations[role].declaration;
  return { title, inputSchema: declaration.input.schema.jsonSchema, resultSchema: declaration.resultSchema.jsonSchema,
    surfaces: declaration.surfaces, dangerLevel: declaration.dangerLevel,
    hostAccess: [IMAP_SMTP_CREDENTIAL_PURPOSE],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: IMAP_SMTP_CREDENTIAL_PURPOSE }], run };
}

export const imapSmtpActions = {
  [ids.listSince]: action('Poll IMAP inbox', 'listSince', async (input, context) => {
    assertEmailCore(context); const request = EmailTransportListSinceInputV1Schema.parse(input);
    return invoke(request, context, (transport) => transport.listSince(request.checkpoint, request.waitMs, request.limit, context.signal));
  }),
  [ids.fetchRaw]: action('Fetch raw IMAP message', 'fetchRaw', async (input, context) => {
    assertEmailCore(context); const request = EmailTransportFetchRawInputV1Schema.parse(input);
    return invoke(request, context, async (transport) => {
      const raw = await transport.fetchRaw(request.ref, context.signal);
      return { kind: 'raw', mimeBase64: raw.mime.toString('base64'), receivedAtMs: raw.receivedAtMs };
    });
  }),
  [ids.submitRaw]: action('Submit raw SMTP message', 'submitRaw', async (input, context) => {
    assertEmailCore(context); const request = EmailTransportSubmitRawInputV1Schema.parse(input);
    return invoke(request, context, (transport) => transport.submitRaw(Buffer.from(request.mimeBase64, 'base64'), request.envelope, request.messageId, context.signal));
  }),
  [ids.connectionTest]: action('Test IMAP and SMTP login', 'connectionTest', async (input, context) => {
    assertEmailCore(context); const request = EmailTransportConnectionInputV1Schema.parse(input);
    return invoke(request, context, (transport) => transport.connectionTest(context.signal));
  }),
  [ids.findSent]: action('Reconcile email Sent copy', 'findSent', async (input, context) => {
    assertEmailCore(context); const request = EmailTransportFindSentInputV1Schema.parse(input);
    return invoke(request, context, async (transport): Promise<JsonValue> => await transport.findSent(request.messageId, context.signal)
      ? { kind: 'found', messageId: request.messageId } : { kind: 'notFound' });
  }),
};

export const imapSmtpTransportContribution = protocol.contribute({ operations: {
  listSince: protocol.operations.listSince.bind(ids.listSince), fetchRaw: protocol.operations.fetchRaw.bind(ids.fetchRaw),
  submitRaw: protocol.operations.submitRaw.bind(ids.submitRaw), connectionTest: protocol.operations.connectionTest.bind(ids.connectionTest),
  findSent: protocol.operations.findSent.bind(ids.findSent),
} });
