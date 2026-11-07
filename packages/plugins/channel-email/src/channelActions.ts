import { createHash } from 'node:crypto';
import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionHandlerInvocationNotStartedAdvisory } from '@happier-dev/plugin-sdk/actions';
import {
  assertConversationChannelsCoreCallerV1, rethrowConversationProviderLifecycleFailureV1,
  hasCurrentConversationProviderConnectionV1,
  CONVERSATION_CORE_PLUGIN_ID_V1, CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
  ConversationConnectionTestInputV1Schema, ConversationDeliveryInputV1Schema,
  ConversationAttachmentFetchInputV1Schema,
  getConversationAttachmentIdRepresentationsV1, encodeConversationAttachmentBytesV1,
  ConversationDeliveryReconcileInputV1Schema, ConversationEndpointResolveInputV1Schema,
  ConversationPollInputV1Schema,
  ConversationIngressObservedEntryV1Schema,
  ConversationPrincipalResolveInputV1Schema, ConversationProviderConnectionsSnapshotV1Schema,
  ConversationProviderSetupOutcomeV1Schema,
  type ConversationConnectionTestResultV1, type ConversationDeliveryResultV1,
  type ConversationEndpointResolveResultV1, type ConversationPrincipalResolveResultV1,
  type ConversationPollResultV1, type ConversationProviderConnectionInputV1,
  type ConversationProviderFailureV1, type ConversationProviderSetupOutcomeV1,
  type ConversationAttachmentFetchResultV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { EMAIL_CONFIG_SCHEMA, EMAIL_SETUP_INPUT_SCHEMA, EMAIL_STORED_CONFIG_SCHEMA, type EmailConfig } from './config.js';
import { normalizeEmailAddress } from './email/address.js';
import { emailThreadKey, parseEmail, type ParsedEmail } from './email/parse.js';
import { classifyEmailActor, evaluateEmailTrust } from './email/trust.js';
import { composeEmail, emailDeliveryMessageId } from './email/compose.js';
import { readEmailTransport, type EmailTransportContribution } from './transportInvocation.js';

export { EMAIL_SETUP_INPUT_SCHEMA } from './config.js';

function invalidConfiguration(diagnostic: string): ConversationProviderFailureV1 {
  return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic };
}

function readConfig(request: ConversationProviderConnectionInputV1): EmailConfig | ConversationProviderFailureV1 {
  const config = EMAIL_STORED_CONFIG_SCHEMA.safeParse(request.providerConfig);
  if (!config.success || request.providerConfigVersion !== 1) return invalidConfiguration('Email connection configuration is unsupported.');
  const mailbox = normalizeEmailAddress(config.data.mailbox);
  if (mailbox === null || request.providerConnectionKey !== `email:${mailbox}`) return invalidConfiguration('Email mailbox identity is inconsistent.');
  return { ...config.data, mailbox };
}

function transportInput(config: EmailConfig, request: Pick<ConversationProviderConnectionInputV1, 'credentialRef'>) {
  return { credentialRef: request.credentialRef, config: config.transportConfig };
}

function transportOptions(request: Pick<ConversationProviderConnectionInputV1, 'credentialRef'>, context: PluginInvocationContext) {
  return { signal: context.signal, expectedSelectedConnectedAccountRef: request.credentialRef };
}

async function fetchMail(ref: string, config: EmailConfig, request: ConversationProviderConnectionInputV1,
  transport: EmailTransportContribution, context: PluginInvocationContext) {
  const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    transport.operations.fetchRaw, { ...transportInput(config, request), ref }, transportOptions(request, context));
  return execution.result;
}

async function parseProviderEmail(raw: Uint8Array, options: Parameters<typeof parseEmail>[1],
  context: PluginInvocationContext): Promise<ParsedEmail | PluginError> {
  try {
    return await parseEmail(raw, options);
  } catch (error) {
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
    const missingModule = error !== null && typeof error === 'object' && 'code' in error
      && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND');
    // Project only known runtime categories, never exception text or custom names.
    return new PluginError({ code: missingModule ? 'email_parser_module_not_found'
      : error instanceof SyntaxError ? 'email_parser_syntax_error' : 'email_parser_runtime_failed',
      message: 'The Email parser is temporarily unavailable.', retryable: true });
  }
}

/** Safe setup authenticates the mailbox; trust-marker support is observed on real inbound mail. */
export async function setupEmailChannels(input: unknown, context: PluginInvocationContext): Promise<ConversationProviderSetupOutcomeV1> {
  assertConversationChannelsCoreCallerV1(context);
  context.signal.throwIfAborted();
  const setup = EMAIL_SETUP_INPUT_SCHEMA.parse(input);
  const mailbox = normalizeEmailAddress(setup.mailbox);
  if (mailbox === null) throw new PluginError({ code: 'email_configuration_invalid', message: 'Enter one mailbox address.' });
  const { credentialRef, ...fields } = setup;
  const config = EMAIL_CONFIG_SCHEMA.parse({ ...fields, mailbox,
    transport: setup.transport ?? { pluginId: 'happier.channel.email', contributionId: 'imap-smtp' },
    transportConfig: setup.transportConfig ?? {} });
  const transport = await readEmailTransport(config.transport, context);
  const { result } = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    transport.operations.connectionTest, transportInput(config, { credentialRef }), transportOptions({ credentialRef }, context));
  if (result.kind !== 'ready' || normalizeEmailAddress(result.mailbox) !== mailbox) {
    throw new PluginError({ code: 'email_connection_not_ready', message: 'The selected transport could not authenticate this mailbox.',
      retryable: result.kind === 'notReady' && result.reason === 'network' });
  }
  return ConversationProviderSetupOutcomeV1Schema.parse({
    v: 1, credentialRef, providerConnectionKey: `email:${mailbox}`, providerConfigVersion: 1,
    providerConfig: config, integrationPrincipal: { id: mailbox, label: mailbox },
    supportedTransports: ['checkpointedPull'], recommendedTransport: 'checkpointedPull',
    overlapSafety: 'safe', replayContinuity: 'checkpointed',
    setupGuidance: {
      externalUrl: 'https://www.rfc-editor.org/rfc/rfc8314.html',
      requiredPermissionsLabel: 'Authenticated IMAP and SMTP access, verified TLS, and receiving-server authentication markers for the selected trust strategy.',
      steps: [
        { title: 'Get your mailbox address and IMAP and SMTP host names from your mail administrator' },
        { title: 'Use verified TLS: IMAP implicit TLS, and SMTP STARTTLS or implicit TLS as supported by your host',
          externalUrl: 'https://www.rfc-editor.org/rfc/rfc8314.html',
          copyableValues: [
            { label: 'IMAP TLS port', value: '993' },
            { label: 'SMTP STARTTLS port', value: '587' },
            { label: 'SMTP implicit TLS port', value: '465' },
          ] },
        { title: 'Save the hosts, ports, TLS mode and mailbox authentication in an Email IMAP + SMTP Connected Account; supply a custom CA certificate when your host requires it' },
        { title: 'Choose a trust strategy supported and protected by your receiving mail server',
          copyableValues: [
            { label: 'Authentication-Results strategy', value: 'authenticationResults' },
            { label: 'Exchange strategy', value: 'exchangeOrganization' },
          ] },
        { title: 'Copy the actual receiving server’s authserv-id into authservId, or its Exchange AuthSource into authSource; never guess these values',
          externalUrl: 'https://www.rfc-editor.org/rfc/rfc8601.html' },
      ],
    },
  });
}

export async function testEmailConnection(input: unknown, context: PluginInvocationContext): Promise<ConversationConnectionTestResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  const request = ConversationConnectionTestInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return config;
  if (request.selectedTransport !== 'checkpointedPull') return { kind: 'notReady', reason: 'unsupported' };
  const transport = await readEmailTransport(config.transport, context);
  const { result } = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    transport.operations.connectionTest, transportInput(config, request), transportOptions(request, context));
  if (result.kind !== 'ready') return result;
  if (normalizeEmailAddress(result.mailbox) !== config.mailbox) return invalidConfiguration('The transport authenticated a different mailbox.');
  return { kind: 'ready', integrationPrincipal: { id: config.mailbox, label: config.mailbox }, providerConnectionKey: request.providerConnectionKey };
}

export async function resolveEmailEndpoint(input: unknown, context: PluginInvocationContext): Promise<ConversationEndpointResolveResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  const request = ConversationEndpointResolveInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return config;
  return { kind: 'resolved', candidates: normalizeEmailAddress(request.query) === config.mailbox
    && (request.kinds === undefined || request.kinds.includes('direct'))
    ? [{ kind: 'direct', audience: 'direct', id: config.mailbox, label: config.mailbox }] : [] };
}

/** Domain policy is applied once when an owner admits a principal; the core owns allowlists. */
export async function resolveEmailPrincipal(input: unknown, context: PluginInvocationContext): Promise<ConversationPrincipalResolveResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  context.signal.throwIfAborted();
  const request = ConversationPrincipalResolveInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return config;
  const address = normalizeEmailAddress(request.query);
  const domains = config.allowedDomains?.map(domain => domain.trim().toLowerCase()) ?? [];
  if (address === null || (domains.length > 0 && !domains.includes(address.slice(address.lastIndexOf('@') + 1)))) {
    return { kind: 'resolved', candidates: [] };
  }
  return { kind: 'resolved', candidates: [{ id: address, label: address, kind: address === config.mailbox ? 'integration' : 'human' }] };
}

async function reportMissingTrustMarkers(request: ConversationProviderConnectionInputV1, context: PluginInvocationContext,
  senderEligibility: Readonly<{ endpoint: ConversationResolvedEndpointV1; principalId: string }>): Promise<void> {
  const snapshot = ConversationProviderConnectionsSnapshotV1Schema.parse(await context.services.actions.execute(
    { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead },
    { connectionId: request.connectionId }, { signal: context.signal }));
  const current = snapshot[request.connectionId];
  if (current === undefined || !hasCurrentConversationProviderConnectionV1({
    connections: { [request.connectionId]: current }, providerConnectionKey: request.providerConnectionKey,
    credentialRef: request.credentialRef,
  })) return;
  // A completed old poll cannot borrow a new configuration's authority epoch.
  if (JSON.stringify(readConfig(current)) !== JSON.stringify(readConfig(request))) return;
  await context.services.actions.execute(
    { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport },
    { connectionId: request.connectionId, authorityEpoch: current.authorityEpoch, senderEligibility,
      fact: { kind: 'providerReadiness', status: 'attention', code: 'providerPermissionMissing',
        diagnostic: 'Inbound mail lacks the authentication markers required by this connection’s trust strategy.' } },
    { signal: context.signal });
}

export async function pollEmailObservations(input: unknown, context: PluginInvocationContext): Promise<ConversationPollResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  const request = ConversationPollInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return config;
  const transport = await readEmailTransport(config.transport, context);
  const { result } = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    transport.operations.listSince, { ...transportInput(config, request), checkpoint: request.checkpoint,
      waitMs: request.waitMs, limit: request.limit }, transportOptions(request, context));
  if (result.kind !== 'batch') return result;
  const observations: Array<Extract<ConversationPollResultV1, { kind: 'batch' }>['observations'][number]> = [];
  const missingMarkerSenders: Array<{ endpoint: ConversationResolvedEndpointV1; principalId: string }> = [];
  for (const ref of result.refs) {
    const raw = await fetchMail(ref, config, request, transport, context);
    if (raw.kind !== 'raw') return raw;
    const bytes = Buffer.from(raw.mimeBase64, 'base64');
    const mail = await parseProviderEmail(bytes, { ...config, knownThread: identity =>
        request.bindings?.some(binding => binding.endpoint.kind === 'thread' && binding.endpoint.id === emailThreadKey(identity)
          && binding.endpoint.parentId === config.mailbox
          && (identity.messageId === null || !binding.excludedMessageIds?.includes(identity.messageId))) ?? false }, context);
    if (isPluginError(mail)) throw mail;
    const trust = evaluateEmailTrust({ ...mail, strategy: config.trustStrategy });
    const actor = classifyEmailActor({ ...mail, mailbox: config.mailbox, trust });
    const identity = mail.messageId ?? ref;
    const idHash = createHash('sha256').update(identity).digest('hex');
    const timestamp = mail.receivedAtMs !== null && mail.receivedAtMs >= 0 ? mail.receivedAtMs : raw.receivedAtMs;
    const label = Array.from(mail.subject.trim()).slice(0, MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS).join('');
    const envelope = {
      v: 1, occurrenceId: `email:${idHash}`, occurredAt: timestamp, transport: { kind: 'poll' },
      endpoint: { kind: 'thread', audience: 'direct', id: emailThreadKey(mail) ?? `email-invalid:${idHash}`, parentId: config.mailbox,
        ...(label ? { label } : {}) }, actor,
      message: { id: identity, providerTimestamp: timestamp, contentProvenance: mail.forwarded ? 'forwarded' : 'original',
        addressingEvidence: 'none', ...(mail.inReplyTo === null ? {} : { replyToMessageId: mail.inReplyTo }) },
    };
    const attachments = mail.attachments.map(attachment => ({ attachmentId: attachment.attachmentId,
      name: attachment.name, mediaType: attachment.mediaType, byteLength: attachment.bytes.byteLength }));
    const candidate = mail.from === null ? null : normalizeEmailAddress(mail.from);
    if (candidate !== null && actor.kind === 'unknown' && !actor.isIntegrationSelf && trust.markersMissing) {
      missingMarkerSenders.push({ endpoint: { kind: 'thread', audience: 'direct', id: envelope.endpoint.id,
        parentId: config.mailbox }, principalId: candidate });
    }
    const text = mail.text;
    observations.push(ConversationIngressObservedEntryV1Schema.parse({ eventCandidate: null,
      observation: mail.messageId === null || (text.length === 0 && attachments.length === 0)
        ? { kind: 'routableNonAdmission', shell: envelope, reason: 'unsupportedContent' }
        : { kind: 'fullText', observation: { ...envelope, message: { ...envelope.message, text,
          ...(attachments.length === 0 ? {} : { attachments }) } } } }));
  }
  for (const sender of missingMarkerSenders) await reportMissingTrustMarkers(request, context, sender);
  return observations.length === 0 ? { kind: 'checkpointOnly', checkpointAfterBatch: result.checkpointAfterBatch }
    : { kind: 'batch', observations, checkpointAfterBatch: result.checkpointAfterBatch };
}

export async function deliverEmailMessage(input: unknown, context: PluginInvocationContext): Promise<ConversationDeliveryResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  const request = ConversationDeliveryInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return { kind: 'notDelivered', retry: 'never' };
  const transport = await readEmailTransport(config.transport, context);
  let recipients: readonly string[];
  let reply: Parameters<typeof composeEmail>[0]['reply'];
  if (request.newThread !== undefined) {
    if (request.endpoint.kind !== 'direct' || request.endpoint.id !== config.mailbox) return { kind: 'notDelivered', retry: 'never' };
    recipients = request.newThread.recipients;
  } else {
    const ref = request.replyContext && 'replyToMessageId' in request.replyContext ? request.replyContext.replyToMessageId : undefined;
    if (ref === undefined) return { kind: 'notDelivered', retry: 'never' };
    if (request.endpoint.kind !== 'thread' || request.endpoint.parentId !== config.mailbox) return { kind: 'notDelivered', retry: 'never' };
    const raw = await fetchMail(ref, config, request, transport, context);
    if (raw.kind !== 'raw') return raw.retryAfterMs !== undefined
      ? { kind: 'notDelivered', retry: 'after', retryAfterMs: raw.retryAfterMs }
      : { kind: 'notDelivered', retry: raw.reason === 'network' || raw.reason === 'rateLimited' ? 'safe' : 'never' };
    const mail = await parseProviderEmail(Buffer.from(raw.mimeBase64, 'base64'), { quotedHistory: 'never', stripSignatures: false, bodyFormat: 'text' }, context);
    if (isPluginError(mail)) return { kind: 'notDelivered', retry: 'safe' };
    const trust = evaluateEmailTrust({ ...mail, strategy: config.trustStrategy });
    const actor = classifyEmailActor({ ...mail, mailbox: config.mailbox, trust });
    const candidate = mail.from === null ? null : normalizeEmailAddress(mail.from);
    if (candidate !== null && trust.markersMissing && actor.kind === 'unknown' && !actor.isIntegrationSelf) {
      await reportMissingTrustMarkers(request, context, { endpoint: request.endpoint, principalId: candidate });
    }
    if (!trust.trusted) return { kind: 'notDelivered', retry: 'never' };
    if (actor.isIntegrationSelf) return { kind: 'notDelivered', retry: 'never' };
    if (actor.kind !== 'human') return { kind: 'notDelivered', retry: 'never' };
    if (mail.messageId !== ref) return { kind: 'notDelivered', retry: 'never' };
    if (emailThreadKey(mail) !== request.endpoint.id) return { kind: 'notDelivered', retry: 'never' };
    if (mail.from === null) return { kind: 'notDelivered', retry: 'never' };
    const from = normalizeEmailAddress(mail.from);
    if (from === null) return { kind: 'notDelivered', retry: 'never' };
    recipients = [from];
    reply = { messageId: mail.messageId, references: mail.references, subject: mail.subject, text: mail.text };
  }
  if (recipients.length === 0 || recipients.some(address => normalizeEmailAddress(address) !== address)) return { kind: 'notDelivered', retry: 'never' };
  const composed = await composeEmail({ mailbox: config.mailbox, recipients, content: request.content,
    deliveryKey: request.deliveryKey, ...(request.newThread === undefined ? {} : { subject: request.newThread.subject }),
    ...(reply === undefined ? {} : { reply }) });
  try {
    const { result } = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
      transport.operations.submitRaw, { ...transportInput(config, request), mimeBase64: Buffer.from(composed.mime).toString('base64'),
        messageId: composed.messageId, envelope: composed.envelope }, transportOptions(request, context));
    return result.kind === 'delivered' && request.newThread !== undefined
      ? { ...result, endpoint: { kind: 'thread', audience: 'direct', id: composed.messageId, parentId: config.mailbox } } : result;
  } catch (error) {
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
    // Only this submit invocation's host refusal proves no SMTP effect began.
    // A failed Sent lookup cannot establish that about an earlier submission.
    return isPluginActionHandlerInvocationNotStartedAdvisory(error)
      ? { kind: 'notDelivered', retry: 'safe' }
      : { kind: 'outcomeUnknown' };
  }
}

export async function reconcileEmailDelivery(input: unknown, context: PluginInvocationContext): Promise<ConversationDeliveryResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  const request = ConversationDeliveryReconcileInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return { kind: 'outcomeUnknown' };
  const transport = await readEmailTransport(config.transport, context);
  if (transport.operations.findSent === undefined) return { kind: 'outcomeUnknown' };
  const messageId = emailDeliveryMessageId(request.deliveryKey, config.mailbox);
  const { result } = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    transport.operations.findSent, { ...transportInput(config, request), messageId }, transportOptions(request, context));
  if (result.kind === 'notReady') return { kind: 'outcomeUnknown' };
  if (result.kind !== 'found') return { kind: 'outcomeUnknown' };
  if (result.messageId !== messageId) return { kind: 'outcomeUnknown' };
  return { kind: 'delivered', providerMessageIds: [messageId],
    ...(request.endpoint.kind === 'direct' ? { endpoint: { kind: 'thread', audience: 'direct', id: messageId, parentId: config.mailbox } } : {}) };
}

/** Fetch and parse once for this consuming batch; no provider staging survives the call. */
export async function fetchEmailAttachment(input: unknown, context: PluginInvocationContext): Promise<ConversationAttachmentFetchResultV1> {
  assertConversationChannelsCoreCallerV1(context);
  const request = ConversationAttachmentFetchInputV1Schema.parse(input);
  const config = readConfig(request);
  if ('kind' in config) return config;
  const transport = await readEmailTransport(config.transport, context);
  const raw = await fetchMail(request.messageId, config, request, transport, context);
  if (raw.kind !== 'raw') return raw;
  const mail = await parseProviderEmail(Buffer.from(raw.mimeBase64, 'base64'), { ...config, knownThread: true }, context);
  if (isPluginError(mail)) throw mail;
  const trust = evaluateEmailTrust({ ...mail, strategy: config.trustStrategy });
  const actor = classifyEmailActor({ ...mail, mailbox: config.mailbox, trust });
  if (mail.messageId !== request.messageId || !trust.trusted || actor.kind !== 'human' || actor.isIntegrationSelf) {
    return { kind: 'notReady', reason: 'permissionMissing', diagnostic: 'The referenced email does not authenticate a human sender.' };
  }
  const attachments = request.attachmentIds.map(id => {
    const canonicalId = getConversationAttachmentIdRepresentationsV1(id)[0];
    return mail.attachments.find(file => file.attachmentId === canonicalId);
  });
  if (attachments.some(file => file === undefined)) return { kind: 'notReady', reason: 'unsupported', diagnostic: 'The referenced attachment is unavailable.' };
  context.signal.throwIfAborted();
  return { kind: 'fetched', attachments: attachments.map((file, index) => {
    if (!file) throw new Error('Validated attachment is missing');
    return { attachmentId: request.attachmentIds[index]!, base64: encodeConversationAttachmentBytesV1(file.bytes) };
  }) };
}
