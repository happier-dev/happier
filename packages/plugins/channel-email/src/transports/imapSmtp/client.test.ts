import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import imapkit, { type IMAPServer } from 'imapkit';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { ImapFlow } from 'imapflow';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError, type JsonValue, type PluginInvocationContext, type PluginServices } from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import type { SessionHandle, SessionSendRequest, SessionSummary } from '@happier-dev/plugin-sdk/sessions';
import type { ActionHandler, SessionTranscriptGetExternalShareableResultV1 } from '@happier-dev/plugin-sdk/actions';
// These fixtures implement the external Session host boundary, which validates
// the canonical host schemas including the public plugin surface binding.
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ComposerAttachmentKeyV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { PluginSessionInputSourceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginActionHandlerUnavailableFixture } from '@happier-dev/plugin-sdk/testing';

import { createImapSmtpTransport, type ImapSmtpAccount } from './client';
import { IMAP_SMTP_CONNECTED_ACCOUNT_ID } from './connectedAccount';
import { imapSmtpActions } from './index';
import { emailPlugin } from '../../plugin';
import { EMAIL_CHANNEL_ACTION_IDS } from '../../constants';
import { ConversationPollResultV1Schema, CONVERSATION_MANAGEMENT_ACTION_IDS_V1, type ConversationPollResultV1 } from '@happier-dev/channels-protocol/v1';
import { EmailTransportFetchRawResultV1Schema, EmailTransportSubmitRawInputV1Schema, type EmailTransportSubmitRawInputV1 } from '../../transports';
import { channelsOperationOnlyTargetedContributionsFixture } from '../../../../channels/src/testkit/operationOnlyTargetedContributionsFixture';
import { createChannelsJourneyFixture } from '../../../../channels/src/testkit/channelsJourney';
import { createCurrentConversationConnectionFixture } from '../../../../channels/src/testkit/currentConnectionFixture';
import { createConversationSessionProjectionFrontierRow } from '../../../../channels/src/sessionProjection';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION, CHANNEL_DELIVERIES_FIELD } from '../../../../channels/src/collections';
import { EMAIL_CONFIG_SCHEMA } from '../../config';
import { textPdf } from '../../../../channels/src/testkit/textPdf';
import { ChannelFileValueV1Schema } from '../../../../channels/src/channelAttachment';

const mailbox = 'wilson@test.local';
const raw = (id: string) => Buffer.from(`From: sales@example.com\r\nTo: ${mailbox}\r\nMessage-ID: <${id}@example.com>\r\nSubject: Meubles\r\n\r\nBonjour.\r\n`);

describe('IMAP/SMTP transport against real TLS protocol servers', () => {
  let imap: IMAPServer;
  let smtp: SMTPServer;
  let account: ImapSmtpAccount;
  let submitted: Buffer[];
  let rejection: number | undefined;
  let saveSent: boolean;
  let loseReceipt: boolean;
  let holdReceipt: boolean;
  let onSubmitted: (() => void) | undefined;
  let transport: ReturnType<typeof createImapSmtpTransport>;
  let originalCertificates: string[];
  let registeredPlugin: PluginTestkit | undefined;

  beforeEach(async () => {
    submitted = []; rejection = undefined; saveSent = false;
    loseReceipt = false; holdReceipt = false; onSubmitted = undefined;
    registeredPlugin = undefined;
    imap = imapkit({
      secureConnection: true, plugins: ['IDLE', 'SPECIAL-USE', 'UIDPLUS', 'SASL-IR', 'XOAUTH2'],
      users: { [mailbox]: { password: 'testpass', xoauth2: { accessToken: 'testtoken' } } },
      storage: { INBOX: {}, '': { folders: { Sent: { 'special-use': '\\Sent' } } } },
    });
    const imapPort = await imap.start(0, '127.0.0.1');
    originalCertificates = getCACertificates('default');
    setDefaultCACertificates([...originalCertificates, imap.getCredentials().cert.toString()]);
    smtp = new SMTPServer({
      ...imap.getCredentials(), secure: false, logger: false,
      authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
      onAuth(auth, _session, callback) {
        if (auth.username === mailbox && (auth.password === 'testpass' || auth.accessToken === 'testtoken')) callback(null, { user: mailbox });
        else callback(new Error('Invalid credentials'));
      },
      onRcptTo(address, _session, callback) {
        callback(address.address === 'rejected@example.com'
          ? Object.assign(new Error('Recipient refused'), { responseCode: 550 }) : null);
      },
      onData(stream, _session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          if (rejection) { callback(Object.assign(new Error('Test refusal'), { responseCode: rejection })); return; }
          const bytes = Buffer.concat(chunks); submitted.push(bytes);
          if (saveSent) imap.control.addMessage('Sent', { raw: bytes, flags: ['\\Seen'] });
          onSubmitted?.();
          if (holdReceipt) return;
          if (loseReceipt) {
            // smtp-server's connections set is an untyped OS/network boundary.
            for (const connection of smtp.connections as Set<{ close(): void }>) connection.close();
            return;
          }
          callback(null, 'Accepted');
        });
      },
    });
    smtp.listen(0, '127.0.0.1'); await once(smtp.server, 'listening');
    const smtpAddress = smtp.server.address();
    if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('Missing SMTP listener');
    account = { mailbox, imapHost: 'localhost', imapPort, smtpHost: 'localhost', smtpPort: smtpAddress.port,
      inboxFolder: 'INBOX', auth: { user: mailbox, pass: 'testpass' } };
    transport = createImapSmtpTransport(account, { ca: imap.getCredentials().cert });
  });

  afterEach(async () => {
    vi.doUnmock('marked');
    await registeredPlugin?.dispose();
    await imap?.stop();
    if (smtp) await new Promise<void>((resolve) => smtp.close(() => resolve()));
    if (originalCertificates) setDefaultCACertificates(originalCertificates);
  });

  it.each(['ready', 'wrong-transport', 'transport-unavailable', 'fetch-unavailable', 'renderer-unavailable', 'submit-handler-not-started', 'submit-result-lost', 'sent-copy-failed', 'smtp-refused', 'fresh-root'] as const)('composes trusted mail through registered Channels ingress and reply custody (%s)', async (scenario) => {
    const wrongTransport = scenario === 'wrong-transport';
    let refuseSubmission = scenario === 'submit-handler-not-started';
    let failPreparation = false;
    const freshRoot = scenario === 'fresh-root';
    const credentialRef = { service: { pluginId: emailPlugin.manifest.id, localId: IMAP_SMTP_CONNECTED_ACCOUNT_ID }, accountId: mailbox };
    const config = EMAIL_CONFIG_SCHEMA.parse({ mailbox, transport: { pluginId: emailPlugin.manifest.id, contributionId: 'imap-smtp' },
      transportConfig: {}, trustStrategy: { kind: 'authenticationResults', authservId: freshRoot ? 'mx.seed1.test.local' : 'mx.example.com' },
      allowedDomains: [freshRoot ? 'test.local' : 'example.com'] });
    const nativeSubmissions: EmailTransportSubmitRawInputV1[] = [];
    const polls: ConversationPollResultV1[] = [];
    const refusals: unknown[] = [];
    const logger = { debug() {}, info: vi.fn<PluginServices['logger']['info']>(),
      warn: vi.fn<PluginServices['logger']['warn']>(), error() {}, diagnostic() {} };
    let journey: Awaited<ReturnType<typeof createChannelsJourneyFixture>>;
    // Only the Connected Account store and host catalog are substituted. The
    // real plugin registers both its provider and its own TCP transport once.
    const connectedAccounts = { async materialize(_purpose: string, _request: unknown, options: { expectedAccount: unknown }) {
      expect(options.expectedAccount).toEqual(credentialRef);
      return { kind: 'environment', env: { HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT: JSON.stringify(account) } };
    } } as unknown as PluginServices['connectedAccounts'];
    const providerMaterialization = { pluginId: emailPlugin.manifest.id, machineId: 'email-seam-machine', materializationId: 'email-seam' };
    registeredPlugin = await createPluginTestkit({ manifest: emailPlugin.manifest,
      resolveCurrentPluginMaterializationRef: () => providerMaterialization,
      services: { connectedAccounts, logger },
      module: { activate(api) {
        return emailPlugin.activate({ ...api, actions: { ...api.actions,
          register<I extends JsonValue, O extends JsonValue | void>(id: string, run: ActionHandler<I, O>) {
          const wrapped: ActionHandler<I, O> = async (input, context) => {
            const fixtureCatalog = channelsOperationOnlyTargetedContributionsFixture(registeredPlugin!, emailPlugin.contributionPoints.transports);
            // Cross-plugin host dispatch is the boundary; the target handler,
            // canonical schema and Account lifecycle remain real.
            const executeCore = async (action: { pluginId: string; localId: string }, value: unknown) => {
              return journey.executeProviderCoreAction(action, value, context);
            };
            const actions = new Proxy({ ...context.services.actions, execute: executeCore as PluginServices['actions']['execute'] }, {
              get(target, property, receiver) {
                if (property !== 'executeAdmittedTargetedOperationWithExecutionOrigin') return Reflect.get(target, property, receiver);
                return (...args: Parameters<typeof target.executeAdmittedTargetedOperationWithExecutionOrigin>) => {
                  if (failPreparation && scenario === 'fetch-unavailable' && args[0].identity.role === 'fetchRaw') {
                    throw new Error('Host transport cannot fetch the original');
                  }
                  // The host refuses dispatch before entering the real TCP
                  // adapter; this is no evidence about a prior SMTP attempt.
                  if (refuseSubmission && args[0].identity.role === 'submitRaw') {
                    throw createPluginActionHandlerUnavailableFixture();
                  }
                  if (scenario === 'submit-result-lost' && args[0].identity.role === 'submitRaw') {
                    return target.executeAdmittedTargetedOperationWithExecutionOrigin(...args).then(() => {
                      throw new Error('Host lost the submission result after SMTP acceptance');
                    });
                  }
                  return target.executeAdmittedTargetedOperationWithExecutionOrigin(...args);
                };
              },
            });
            const invocation = { ...context, services: { ...context.services, targetedContributions: {
              ...fixtureCatalog, observeForSelf: <T>(point: TargetedContributionPointRef<T>, options: { onInvalidated: () => void }) => {
                if (failPreparation && scenario === 'transport-unavailable') throw new Error('Host transport catalog unavailable');
                return fixtureCatalog.observeForSelf(point, options);
              },
            }, actions } };
            if (id === 'transport/imap-smtp/submit-raw-v1') nativeSubmissions.push(EmailTransportSubmitRawInputV1Schema.parse(input));
            // The negative control deliberately misbinds a host Action; its
            // declared generic input/result stay unchanged at this boundary.
            const handler = wrongTransport && id === 'transport/imap-smtp/fetch-raw-v1'
              ? imapSmtpActions['transport/imap-smtp/connection-test-v1'].run as unknown as ActionHandler<I, O> : run;
            try {
              const result = await handler(input, invocation);
              if (id === EMAIL_CHANNEL_ACTION_IDS.observationsPoll) polls.push(ConversationPollResultV1Schema.parse(result));
              return result;
            } catch (error) { refusals.push(error); throw error; }
          };
          return api.actions.register(id, wrapped);
        } } });
      } } });
    const baseConnection = createCurrentConversationConnectionFixture({ connectionId: 'email-seam-connection', authority: {
      providerPluginId: emailPlugin.manifest.id, providerContributionSelection: { contributionId: 'email-provider' },
      providerSetupInput: { ...config, credentialRef }, credentialRef,
      transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: providerMaterialization },
      providerConnectionKey: `email:${mailbox}`, providerConfig: config,
      routingIdentityKey: 'e'.repeat(43), integrationPrincipal: { id: mailbox }, authorityEpoch: 1,
    } });
    const { outboundTextLimit: _fixtureDefault, ...connectionPayload } = baseConnection.payload;
    const connection = { ...baseConnection, payload: connectionPayload };
    const endpoint = { kind: 'thread', audience: 'direct', id: freshRoot ? '<fresh-root@test.local>' : '<root@example.com>', parentId: mailbox };
    const binding = { id: 'email-seam-binding', 'record-kind': 'binding', v: 1, 'connection-id': connection.id,
      'binding-id': 'email-seam-binding', 'created-at': 1, 'updated-at': 1, payload: { endpoint,
        target: { kind: 'session', sessionId: 'email-seam-session', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: [freshRoot ? 'owner@test.local' : 'sales@example.com'], allowBotSenders: false, inputMode: 'allAllowedMessages',
        inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none' } };
    const admitted: Extract<SessionSendRequest, { kind: 'userText' }>[] = [];
    const transcript: SessionTranscriptGetExternalShareableResultV1['items'][number][] = [];
    const sessionId = 'email-seam-session';
    const summary = { id: sessionId, machineId: 'email-seam-machine', state: 'idle', runtimeAvailability: { status: 'available' },
      storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 } satisfies SessionSummary;
    // The Session host is an external boundary for the plugin. The separate
    // CLI-owned Channels journey runs real admission; this boundary validates
    // its wire request and returns schema-produced transcript pages.
    const materializedBytes: Buffer[] = [];
    const stagedPaths: string[] = [];
    const sessions = { async get(id: string) {
      if (id !== sessionId) return null;
      return { async summary() { return summary; }, async materializeAttachment(request: Parameters<SessionHandle['materializeAttachment']>[0]) {
        stagedPaths.push(request.sourcePath);
        const bytes = await readFile(request.sourcePath);
        materializedBytes.push(bytes);
        return { path: `.happier/uploads/${request.name}`, bytes };
      }, async send(request: SessionSendRequest) {
        if (request.kind !== 'userText') throw new Error('Email ingress must send user text');
        const { kind: _kind, text, ...fields } = request;
        const sendSpec = getActionSpec('session.message.send');
        const sendSchema = sendSpec.surfaceBindings?.plugin?.inputSchema ?? sendSpec.inputSchema;
        sendSchema.parse({ sessionId, message: text, ...fields });
        admitted.push(request);
        const localId = `email-local-${admitted.length}`;
        const source = PluginSessionInputSourceV1Schema.parse(request.source);
        transcript.push({ kind: 'userText', sessionId, seq: transcript.length + 1, itemId: localId, localId, text,
          origin: { v: 1, producer: 'pluginSession', actor: 'collaborator', sourceAuthority: {
            mediatorPluginId: 'happier.channels', sourceRef: source.sourceRef, sourceRevisionOrEpoch: source.sourceRevisionOrEpoch,
          } } });
        const resultSchema = sendSpec.surfaceBindings?.plugin?.outputSchema ?? sendSpec.outputSchema;
        if (!resultSchema) throw new Error('Missing Session send result schema');
        return resultSchema.parse({ status: 'accepted', localId });
      } } as unknown as SessionHandle;
    } } as unknown as PluginServices['sessions'];
    const actions = { async execute(action: string, input: unknown) {
      const spec = getActionSpec(action as 'session.transcript.get' | 'session.permission.remote.pending.list');
      spec.inputSchema.parse(input);
      if (!spec.outputSchema) throw new Error(`Missing output schema for ${action}`);
      if (action === 'session.permission.remote.pending.list') return spec.outputSchema.parse({ requests: [], truncated: false });
      if (action !== 'session.transcript.get') throw new Error(`Unexpected host Action ${action}`);
      const request = input as { cursor?: string | null; limit?: number };
      const cursor = Number(request.cursor ?? 0);
      const items = request.limit === 0 ? [] : transcript.filter(item => item.seq > cursor);
      return spec.outputSchema.parse({ ok: true, projection: 'externalShareableV1', sessionId,
        scannedThroughSeq: transcript.length, nextCursor: String(transcript.length), hasMore: false, items });
    } } as unknown as PluginServices['actions'];
    journey = await createChannelsJourneyFixture({ provider: registeredPlugin, connection, binding, sessions, actions, logger,
      resolveCurrentProviderExecutionOrigin: () => ({ serverIdentityId: 'srv_plugin_testkit', materializationRef: providerMaterialization }) });
    try {
      await journey.state.put(createConversationSessionProjectionFrontierRow({ bindingId: binding.id, targetSessionId: sessionId,
        transcriptCursor: '0', lastScannedSeq: 0, revision: 1, now: 1 }), { expectedRevision: 'absent' });
      const trusted = 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com';
      const incoming = (id: string, from: string, authentication: readonly string[], headers: readonly string[] = []) => Buffer.from([
        `From: ${from}`, `To: ${mailbox}`, `Message-ID: <${id}@example.com>`, 'References: <root@example.com>',
        'Reply-To: attacker@outside.com', 'Cc: other@example.com', 'Subject: Re: Meubles', ...authentication, ...headers,
        'Content-Type: text/html; charset=utf-8', '', '<p>Bonjour, avez-vous ce modèle ?</p><div style="display:none">HIDDEN</div>',
        '<div class="gmail_signature">SIGNATURE</div><div class="gmail_quote">HISTORY</div>',
      ].join('\r\n'));
      imap.control.addMessage('INBOX', { raw: incoming('historic', 'sales@example.com', [trusted]) });
      const initialPoll = await journey.poll();
      expect((await journey.state.get(connection.id))?.value.payload).toMatchObject({ pollFailure: null });
      expect(initialPoll).toMatchObject({ kind: 'committed' });
      expect(polls).toEqual([{ kind: 'checkpointOnly', checkpointAfterBatch: {
        uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: 1,
      } }]);
      expect(admitted).toEqual([]);
      if (scenario === 'ready') {
        const baseline = await journey.state.get(connection.id);
        expect(baseline?.value.payload).toMatchObject({ historyGap: { reason: 'providerHistoryUnavailable' } });
        const revision = baseline?.value.payload;
        if (!revision || typeof revision !== 'object' || Array.isArray(revision)
          || typeof revision.configurationRevision !== 'number') throw new Error('Missing baseline notice revision');
        await journey.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss, {
          connectionId: connection.id, expectedRevision: revision.configurationRevision,
        });
        await journey.poll();
        expect((await journey.state.get(connection.id))?.value.payload).toMatchObject({ historyGap: null });
      }
      if (freshRoot) {
        // Reload34b P's public topology: a fresh root, no References/Sender,
        // one allowed owner and an aligned receiving-MTA authentication result.
        imap.control.addMessage('INBOX', { raw: Buffer.from([
          'From: owner@test.local', `To: ${mailbox}`, 'Message-ID: <fresh-root@test.local>',
          'Authentication-Results: mx.seed1.test.local; dmarc=pass header.from=test.local',
          'Subject: Plain control', '', 'Bonjour.',
        ].join('\r\n')) });
        await journey.poll();
        expect(admitted).toHaveLength(1);
        const origin = transcript[0];
        if (origin?.kind !== 'userText') throw new Error('Expected fresh-root admission');
        transcript.push({ kind: 'assistantText', sessionId, seq: 2, itemId: 'root-answer', turnId: 'root-turn', final: 'completed',
          text: 'Reçu.', consumedInputs: [{ localId: origin.localId, origin: origin.origin }] });
        await journey.outward();
        expect(nativeSubmissions[0]?.envelope).toEqual({ from: mailbox, to: ['owner@test.local'] });
        expect(submitted).toHaveLength(1);
        const reply = await simpleParser(submitted[0]!);
        expect(reply.inReplyTo).toBe('<fresh-root@test.local>');
        expect(reply.references).toBe('<fresh-root@test.local>');
        expect([...journey.deliveries.rows.values()].map(row => row.value.payload))
          .toContainEqual(expect.objectContaining({ state: 'delivered', attemptCount: 1 }));
        await journey.outward();
        expect(submitted).toHaveLength(1);
        return;
      }
      imap.control.addMessage('INBOX', { raw: incoming('incoming', 'sales@example.com', [trusted]) });
      imap.control.addMessage('INBOX', { raw: incoming('spoof', 'sales@example.com', ['Authentication-Results: attacker.invalid; dmarc=pass header.from=example.com', trusted]) });
      imap.control.addMessage('INBOX', { raw: incoming('outsider', 'other@example.com', [trusted]) });
      imap.control.addMessage('INBOX', { raw: incoming('automatic', 'sales@example.com', [trusted], ['Auto-Submitted: auto-replied']) });
      imap.control.addMessage('INBOX', { raw: incoming('external-no-markers', 'external@outside.com', []) });
      await journey.poll();
      if (wrongTransport) {
        expect(refusals.length).toBeGreaterThan(0);
        expect(admitted).toEqual([]);
        expect(submitted).toEqual([]);
        expect(nativeSubmissions).toEqual([]);
        return;
      }
      expect(refusals).toEqual([]);
      expect(polls.find(result => result.kind === 'batch')).toMatchObject({ kind: 'batch', observations: [
        { observation: { observation: { actor: { kind: 'human', principalId: 'sales@example.com' } } } },
        { observation: { observation: { actor: { kind: 'unknown', principalId: null } } } },
        { observation: { observation: { actor: { kind: 'human', principalId: 'other@example.com' } } } },
        { observation: { observation: { actor: { kind: 'bot' } } } },
        { observation: { observation: { actor: { kind: 'unknown', principalId: null } } } },
      ] });
      expect((await journey.state.get(connection.id))?.value.payload).toMatchObject({ providerReadiness: null });
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toMatchObject({ text: 'Bonjour, avez-vous ce modèle ?', source: {
        sourceRef: `channels:binding:${binding.id}`, sourceRevisionOrEpoch: '1:1', contentProvenance: 'original',
        requestedPermissionCeiling: 'read-only', remoteApprovalMaxScope: 'off', externalActor: { kind: 'human' },
      } });
      const origin = transcript[0]!;
      if (origin.kind !== 'userText') throw new Error('Expected the admitted user transcript input');
      transcript.push({ kind: 'assistantText', sessionId, seq: 2, itemId: 'email-answer', turnId: 'email-turn', final: 'completed',
        text: 'Oui, **disponible**.', consumedInputs: [{ localId: origin.localId, origin: origin.origin }] });
      failPreparation = ['transport-unavailable', 'fetch-unavailable', 'renderer-unavailable'].includes(scenario);
      if (scenario === 'renderer-unavailable') {
        // Only the external module loader is faulted; composition stays real.
        vi.doMock('marked', () => { throw new Error('Renderer module unavailable'); });
      }
      if (scenario === 'sent-copy-failed') account = { ...account, sentFolder: 'Unavailable' };
      if (scenario === 'smtp-refused') {
        rejection = 550;
        await journey.outward();
        expect(submitted).toHaveLength(0);
        expect(nativeSubmissions).toHaveLength(1);
        expect([...journey.deliveries.rows.values()].map(row => row.value.payload))
          .toContainEqual(expect.objectContaining({ state: 'notSent', reason: 'providerRefused', attemptCount: 1 }));
        const records = [...logger.info.mock.calls, ...logger.warn.mock.calls].map(call => call[1]);
        expect(records).toContainEqual(expect.objectContaining({ code: 'channels_projection_notSent',
          providerResultKind: 'notDelivered', providerRetry: 'never', settledState: 'notSent', retryable: false }));
        await journey.outward();
        expect(nativeSubmissions).toHaveLength(1);
        return;
      }
      if (refuseSubmission || failPreparation) {
        await journey.outward();
        expect(submitted).toHaveLength(0);
        expect(nativeSubmissions).toHaveLength(0);
        const pending = [...journey.deliveries.rows.values()].find(row => row.value[CHANNEL_DELIVERIES_FIELD.bindingId] === binding.id);
        expect(pending?.value.payload).toMatchObject({ state: 'retryDue', attemptCount: 1 });
        expect([...logger.info.mock.calls, ...logger.warn.mock.calls].map(call => call[1]))
          .toContainEqual(expect.objectContaining({ code: 'channels_projection_retryDue',
            providerResultKind: 'notDelivered', providerRetry: 'safe', settledState: 'retryDue', retryable: true }));
        const retryAt = pending?.value[CHANNEL_DELIVERIES_FIELD.retryNotBefore];
        if (!pending || typeof retryAt !== 'number') throw new Error('Expected the custody owner retry deadline');
        refuseSubmission = false;
        failPreparation = false;
        vi.doUnmock('marked');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(retryAt);
        try { await journey.outward(); } finally { clock.mockRestore(); }
        expect((await journey.deliveries.get(pending.rowId))?.value.payload).toMatchObject({ state: 'delivered', attemptCount: 2 });
      } else {
        await journey.outward();
      }
      expect(submitted).toHaveLength(1);
      if (scenario === 'submit-result-lost') {
        expect([...logger.info.mock.calls, ...logger.warn.mock.calls].map(call => call[1]))
          .toContainEqual(expect.objectContaining({ code: 'channels_projection_outcomeUnknown',
            providerResultKind: 'outcomeUnknown', settledState: 'outcomeUnknown', retryable: false }));
      }
      expect(nativeSubmissions[0]?.envelope).toEqual({ from: mailbox, to: ['sales@example.com'] });
      const reply = await simpleParser(submitted[0]!);
      expect(reply.inReplyTo).toBe('<incoming@example.com>');
      expect(reply.references).toEqual(['<root@example.com>', '<incoming@example.com>']);
      expect(reply.to).toMatchObject({ value: [{ address: 'sales@example.com' }] });
      expect(reply.cc).toBeUndefined();
      expect(reply.headers.get('auto-submitted')).toBe('auto-replied');
      expect(reply.text).toContain('disponible');
      expect(reply.text).toContain('Bonjour');
      expect(reply.html).toContain('<strong>disponible</strong>');
      expect(imap.control.listMessages('Sent')).toHaveLength(scenario === 'sent-copy-failed' ? 0 : 1);
      expect([...journey.deliveries.rows.values()].map(row => row.value.payload)).toContainEqual(expect.objectContaining({
        state: scenario === 'submit-result-lost' ? 'outcomeUnknown' : 'delivered',
      }));
      if (scenario === 'sent-copy-failed') {
        expect(logger.warn.mock.calls.map(call => call[1])).toContainEqual({ code: 'sentCopyUnconfirmed' });
      }
      for (const [collection, definition] of [[journey.state, CHANNEL_STATE_COLLECTION], [journey.deliveries, CHANNEL_DELIVERIES_COLLECTION]] as const) {
        const schema = compilePluginJsonSchema(definition.schema);
        for (const row of collection.rows.values()) expect(isValidPluginJsonSchemaValue(schema, row.value),
          `${definition.id}/${row.rowId}`).toBe(true);
      }
      await journey.poll(); await journey.outward();
      expect(admitted).toHaveLength(1);
      expect(submitted).toHaveLength(1);
      imap.control.resetUidValidity('INBOX');
      if (scenario === 'ready') {
        // Historical development failures stay parked until the person's Retry
        // Action; mailbox replacement then uses the ordinary recovery path.
        const retained = await journey.state.get(connection.id);
        if (!retained) throw new Error('Missing retained connection');
        const payload = retained.value.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Missing retained lifecycle');
        await journey.state.put({ ...retained.value, payload: { ...payload,
          pollFailure: { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null,
            evidence: { kind: 'action', code: 'channels_checkpointed_poll_action_failed',
              message: "Cannot read properties of undefined (reading 'targetPluginId')" } },
        } }, { expectedRevision: retained.revision });
        expect(await journey.poll()).toMatchObject({ kind: 'ineligible' });
        expect(await journey.invoke('connection/poll-retry-v1', {
          connectionId: connection.id,
        })).toMatchObject({ kind: 'retryScheduled' });
      }
      expect(await journey.poll()).toMatchObject({ kind: 'committed' });
      expect(polls.at(-2)).toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
      const interrupted = await journey.state.get(connection.id);
      if (!interrupted) throw new Error('Missing history-gap connection');
      expect(interrupted.value.payload).toMatchObject({ pollFailure: null,
        historyGap: { reason: 'providerHistoryUnavailable' } });
      if (scenario === 'ready') {
        const revision = interrupted.value.payload;
        if (!revision || typeof revision !== 'object' || Array.isArray(revision)
          || typeof revision.configurationRevision !== 'number') throw new Error('Missing UIDVALIDITY notice revision');
        await journey.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss, {
          connectionId: connection.id, expectedRevision: revision.configurationRevision,
        });
        await journey.poll();
        expect((await journey.state.get(connection.id))?.value.payload).toMatchObject({ historyGap: null });
      }
      expect(polls.at(-1)).toEqual({ kind: 'checkpointOnly', checkpointAfterBatch: {
        uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: imap.control.getMailbox('INBOX').uidnext - 1,
      } });
      expect(admitted).toHaveLength(1);
      imap.control.addMessage('INBOX', { raw: incoming('after-reset', 'sales@example.com', [trusted]) });
      await journey.poll();
      expect(admitted).toHaveLength(2);
      imap.control.addMessage('INBOX', { raw: incoming('allowed-no-markers', 'sales@example.com', []) });
      await journey.poll();
      expect(admitted).toHaveLength(2);
      expect((await journey.state.get(connection.id))?.value.payload).toMatchObject({ providerReadiness: {
        code: 'providerPermissionMissing',
      } });
      expect(imap.control.listMessages('INBOX').every(message => !message.flags.includes('\\Seen'))).toBe(true);
      const pdfs = ['First lead', 'Second lead', 'Third lead'].map(textPdf);
      const mime = Buffer.from([
        'From: sales@example.com', `To: ${mailbox}`, 'Message-ID: <pdf-batch@example.com>', 'References: <root@example.com>', trusted,
        'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=pdfs', '', '--pdfs', 'Content-Type: text/plain', '', 'Three leads',
        ...pdfs.flatMap((bytes, index) => ['--pdfs', 'Content-Type: application/pdf', `Content-Disposition: attachment; filename=lead-${index}.pdf`,
          'Content-Transfer-Encoding: base64', '', Buffer.from(bytes).toString('base64')]), '--pdfs--', '',
      ].join('\r\n'));
      imap.control.addMessage('INBOX', { raw: mime });
      const pdfUid = imap.control.getMailbox('INBOX').uidnext - 1;
      const fetchOne = vi.spyOn(ImapFlow.prototype, 'fetchOne');
      try {
        await journey.poll();
        expect(admitted).toHaveLength(3);
        expect(fetchOne.mock.calls.filter(call => call[0] === pdfUid && call[1].source)).toHaveLength(1);
        const attachments = admitted[2]!.attachments!;
        expect(attachments).toHaveLength(3);
        const dispatch = { sessionId, localId: 'email-local-3', attachments: attachments.map((attachment, index) => ({
          instanceId: `pdf-${index}`, key: ComposerAttachmentKeyV1Schema.parse(attachment.value.key), value: ChannelFileValueV1Schema.parse(attachment.value.value),
        })) };
        fetchOne.mockClear();
        const resolved = await journey.resolveAttachments(dispatch);
        expect(fetchOne.mock.calls.filter(call => call[1].source)).toHaveLength(1);
        for (const text of ['First lead', 'Second lead', 'Third lead']) expect(JSON.stringify(resolved)).toContain(text);
        expect(materializedBytes).toEqual(pdfs.map(bytes => Buffer.from(bytes)));
        for (const path of stagedPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        fetchOne.mockClear();
        await journey.resolveAttachments(dispatch);
        expect(fetchOne.mock.calls.filter(call => call[1].source)).toHaveLength(1);
        for (const path of stagedPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { fetchOne.mockRestore(); }
      // Replacing a fixture server can reuse its epoch as well as low UIDs.
      // Exercise the same provider registration and durable core attention
      // owner as a real UIDVALIDITY change, without resetting its checkpoint.
      const priorValidity = imap.control.getMailbox('INBOX').uidvalidity;
      await imap.stop();
      imap = imapkit({ secureConnection: true,
        users: { [mailbox]: { password: 'testpass' } },
        storage: { INBOX: { uidvalidity: priorValidity } },
      });
      const replacementPort = await imap.start(0, '127.0.0.1');
      setDefaultCACertificates([...getCACertificates('default'), imap.getCredentials().cert.toString()]);
      account = { ...account, imapPort: replacementPort };
      imap.control.addMessage('INBOX', { raw: incoming('replacement', 'sales@example.com', [trusted]) });
      await journey.poll();
      expect(polls.at(-2)).toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
      expect(polls.at(-1)).toEqual({ kind: 'checkpointOnly', checkpointAfterBatch: {
        uidValidity: String(priorValidity), lastUid: imap.control.getMailbox('INBOX').uidnext - 1,
      } });
      expect((await journey.state.get(connection.id))?.value.payload).toMatchObject({
        historyGap: { reason: 'providerHistoryUnavailable' },
      });
      expect(admitted).toHaveLength(3);
      imap.control.addMessage('INBOX', { raw: incoming('replacement-new', 'sales@example.com', [trusted]) });
      await journey.poll();
      expect(admitted).toHaveLength(4);
      expect(submitted).toHaveLength(1);
    } finally { await journey.dispose(); }
    // This composed protocol journey opens real TLS connections for baseline,
    // ingress, SMTP, replay and UIDVALIDITY recovery; it exceeds Vitest's 5s unit
    // default without imposing any shorter timeout on the transport itself.
  }, 30_000);

  it('receives raw bytes, pages UIDs without replay, reads only INBOX and never marks Seen', async () => {
    const receivedAt = new Date('2026-10-12T07:00:00Z');
    imap.control.addMessage('INBOX', { raw: raw('first'), internaldate: receivedAt });
    imap.control.addMessage('INBOX', { raw: raw('second'), internaldate: receivedAt });
    imap.control.addMessage('Sent', { raw: raw('outgoing') });
    const first = await transport.listSince({ uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: 0, futureField: 'ignored' }, 0, 1);
    expect(first.kind).toBe('batch');
    if (first.kind !== 'batch') throw new Error('Expected first batch');
    expect(first.refs).toHaveLength(1);
    expect(await transport.fetchRaw(first.refs[0])).toEqual({ mime: raw('first'), receivedAtMs: receivedAt.getTime() });
    expect(await transport.fetchRaw(first.refs[0])).toEqual({ mime: raw('first'), receivedAtMs: receivedAt.getTime() });
    const second = await transport.listSince(first.checkpointAfterBatch, 0, 1);
    if (second.kind !== 'batch') throw new Error('Expected second batch');
    expect(second.refs).toHaveLength(1);
    expect(await transport.fetchRaw(second.refs[0])).toEqual({ mime: raw('second'), receivedAtMs: receivedAt.getTime() });
    const empty = await transport.listSince(second.checkpointAfterBatch, 0, 10);
    expect(empty).toMatchObject({ kind: 'batch', refs: [] });
    expect(imap.control.listMessages('INBOX').every((message) => !message.flags.includes('\\Seen'))).toBe(true);
  });

  it.each([false, true])('preserves first-mail shaping across child creation and compacted replay, while stripping held replies (placement failure: %s)', async (placementFailure) => {
    const credentialRef = { service: { pluginId: emailPlugin.manifest.id, localId: IMAP_SMTP_CONNECTED_ACCOUNT_ID }, accountId: mailbox };
    const config = EMAIL_CONFIG_SCHEMA.parse({ mailbox, transport: { pluginId: emailPlugin.manifest.id, contributionId: 'imap-smtp' },
      transportConfig: {}, trustStrategy: { kind: 'authenticationResults', authservId: 'mx.example.com' } });
    const materialization = { pluginId: emailPlugin.manifest.id, machineId: 'email-seam-machine', materializationId: 'email-replay' };
    const polls: ConversationPollResultV1[] = [];
    let journey: Awaited<ReturnType<typeof createChannelsJourneyFixture>>;
    let blockNextPoll = false;
    // Credential persistence and Session Actions are external host boundaries;
    // the email plugin, TCP transport, routing, census and custody stay real.
    const connectedAccounts = { async materialize() {
      return { kind: 'environment', env: { HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT: JSON.stringify(account) } };
    } } as unknown as PluginServices['connectedAccounts'];
    registeredPlugin = await createPluginTestkit({ manifest: emailPlugin.manifest,
      resolveCurrentPluginMaterializationRef: () => materialization, services: { connectedAccounts },
      module: { activate(api) { return emailPlugin.activate({ ...api, actions: { ...api.actions,
        register<I extends JsonValue, O extends JsonValue | void>(id: string, run: ActionHandler<I, O>) {
        const wrapped: ActionHandler<I, O> = async (input, context) => {
          if (id === EMAIL_CHANNEL_ACTION_IDS.observationsPoll && blockNextPoll) {
            blockNextPoll = false;
            throw new PluginError({ code: 'email_fixture_poll_blocked', message: 'Fixture host refusal' });
          }
          const catalog = channelsOperationOnlyTargetedContributionsFixture(registeredPlugin!, emailPlugin.contributionPoints.transports);
          const executeCore = (action: { pluginId: string; localId: string }, value: unknown) => {
            if (placementFailure) throw new PluginError({ code: 'plugin_action_execution_placement_unavailable', message: 'Unavailable placement' });
            return journey.executeProviderCoreAction(action, value, context);
          };
          const result = await run(input, { ...context, services: { ...context.services, targetedContributions: catalog,
            actions: { ...context.services.actions, execute: executeCore as PluginServices['actions']['execute'] } } });
          if (id === EMAIL_CHANNEL_ACTION_IDS.observationsPoll) polls.push(ConversationPollResultV1Schema.parse(result));
          return result;
        };
        return api.actions.register(id, wrapped);
      } } }); } } });
    const base = createCurrentConversationConnectionFixture({ connectionId: 'email-replay-connection', authority: {
      providerPluginId: emailPlugin.manifest.id, providerContributionSelection: { contributionId: 'email-provider' },
      providerSetupInput: { ...config, credentialRef }, credentialRef,
      transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: materialization },
      providerConnectionKey: `email:${mailbox}`, providerConfig: config, routingIdentityKey: 'e'.repeat(43),
      integrationPrincipal: { id: mailbox }, authorityEpoch: 1,
    } });
    const { outboundTextLimit: _limit, ...payload } = base.payload;
    const connection = { ...base, payload };
    const sessionId = 'email-replay-session';
    const policy = { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } };
    const binding = { id: 'email-replay-router', 'record-kind': 'binding', v: 1, 'connection-id': connection.id,
      'binding-id': 'email-replay-router', 'created-at': 1, 'updated-at': 1, payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: mailbox }, target: { kind: 'threadRouter',
          principalGroups: [{ id: 'sales', principalIds: ['sales@example.com'] }], routes: [{ id: 'intake',
            when: { group: 'sales', forwarded: 'any' }, policy, recipe: {
              executionTarget: { serverId: 'server-1', machineId: 'email-seam-machine' },
              directory: { kind: 'path', path: '/workspace/email' },
              organizationPlacement: { folderId: null, tagIds: [] },
              agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            } }] }, allowedPrincipalIds: ['sales@example.com'], allowBotSenders: false, inputMode: 'allAllowedMessages',
        inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none',
      } };
    const admitted: Extract<SessionSendRequest, { kind: 'userText' }>[] = [];
    const transcript: SessionTranscriptGetExternalShareableResultV1['items'][number][] = [];
    const summary = { id: sessionId, machineId: 'email-seam-machine', state: 'idle', runtimeAvailability: { status: 'available' }, storagePolicy: 'optional',
      encryptionMode: 'plain', updatedAtMs: 1 } satisfies SessionSummary;
    const materializedBytes: Uint8Array[] = [];
    const sessions = { async get(id: string) {
      if (id !== sessionId) return null;
      return { async summary() { return summary; }, async materializeAttachment(request: Parameters<SessionHandle['materializeAttachment']>[0]) {
        const bytes = await readFile(request.sourcePath);
        materializedBytes.push(bytes);
        return { path: `.happier/uploads/${request.name}`, bytes };
      }, async send(request: SessionSendRequest) {
        if (request.kind !== 'userText') throw new Error('Expected email text');
        const { kind: _kind, text, ...fields } = request;
        const spec = getActionSpec('session.message.send');
        (spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema).parse({ sessionId, message: text, ...fields });
        admitted.push(request);
        const localId = `email-replay-local-${admitted.length}`;
        const source = PluginSessionInputSourceV1Schema.parse(request.source);
        transcript.push({ kind: 'userText', sessionId, seq: transcript.length + 1, itemId: localId, localId, text,
          origin: { v: 1, producer: 'pluginSession', actor: 'collaborator', sourceAuthority: {
            mediatorPluginId: 'happier.channels', sourceRef: source.sourceRef, sourceRevisionOrEpoch: source.sourceRevisionOrEpoch,
          } } });
        return { status: 'accepted', localId };
      } } as unknown as SessionHandle;
    } } as unknown as PluginServices['sessions'];
    let spawns = 0;
    const actions = { async execute(action: string, input: unknown) {
      const spec = getActionSpec(action as 'session.spawn_new' | 'session.transcript.get' | 'session.permission.remote.pending.list');
      const request = spec.inputSchema.parse(input);
      if (action === 'session.spawn_new') {
        spawns += 1;
        expect(request).toMatchObject({ creationKey: 'channel-thread:email-replay-router:<first@example.com>',
          organizationPlacement: { sectionId: null, tagIds: [] },
          attestedContext: { externalPrincipalId: 'sales@example.com', sourceMessageId: '<first@example.com>' } });
        return { type: 'success', disposition: 'created', sessionId,
          attestedContext: { externalPrincipalId: 'sales@example.com', sourceMessageId: '<first@example.com>' },
          executionTarget: { serverId: 'server-1', machineId: 'email-seam-machine' },
          organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
      }
      if (!spec.outputSchema) throw new Error('Expected Session result schema');
      if (action === 'session.permission.remote.pending.list') return spec.outputSchema.parse({ requests: [], truncated: false });
      const page = input as { cursor?: string | null; limit?: number };
      return spec.outputSchema.parse({ ok: true, projection: 'externalShareableV1', sessionId,
        scannedThroughSeq: transcript.length, nextCursor: String(transcript.length), hasMore: false,
        items: page.limit === 0 ? [] : transcript.filter(item => item.seq > Number(page.cursor ?? 0)) });
    } } as unknown as PluginServices['actions'];
    journey = await createChannelsJourneyFixture({ provider: registeredPlugin, connection, binding, sessions, actions,
      resolveCurrentProviderExecutionOrigin: () => ({ serverIdentityId: 'srv_plugin_testkit', materializationRef: materialization }) });
    const mime = (id: string, answer: string, reply = false) => Buffer.from([
      `From: sales@example.com`, `To: ${mailbox}`, `Message-ID: <${id}@example.com>`,
      ...(reply ? ['References: <first@example.com>', 'In-Reply-To: <first@example.com>'] : []),
      'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com', 'Subject: Question',
      'Content-Type: text/plain; charset=utf-8', '', answer, 'On Monday, Alice wrote:', '> HISTORY',
    ].join('\r\n'));
    try {
      expect(await journey.poll()).toMatchObject({ kind: 'committed' });
      if (placementFailure) {
        const checkpointBeforeBlock = [...journey.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint');
        blockNextPoll = true;
        expect(await journey.poll()).toMatchObject({ kind: 'blocked' });
        const embedded = Buffer.from('From: lead@outside.test\r\nMessage-ID: <embedded@outside.test>\r\nSubject: Forwarded lead\r\n\r\nA forwarded fixture lead.');
        const pdf = Buffer.from(textPdf('Fixture proposal'));
        const forwarded = Buffer.from([
          'From: sales@example.com', `To: ${mailbox}`, 'Message-ID: <first@example.com>',
          'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com', 'Subject: Forwarded lead',
          'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="ingest-fixture"', '',
          '--ingest-fixture', 'Content-Type: text/plain; charset=utf-8', '', 'Please process the attached lead.',
          '--ingest-fixture', 'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="lead.eml"',
          'Content-Transfer-Encoding: base64', '', embedded.toString('base64'),
          '--ingest-fixture', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="proposal.pdf"',
          'Content-Transfer-Encoding: base64', '', pdf.toString('base64'), '--ingest-fixture--', '',
        ].join('\r\n'));
        imap.control.addMessage('INBOX', { raw: forwarded, internaldate: new Date() });
        expect(await journey.poll()).toMatchObject({ kind: 'ineligible' });
        expect([...journey.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint')).toEqual(checkpointBeforeBlock);
        expect(await journey.invoke('connection/poll-retry-v1', {
          connectionId: connection.id,
        })).toMatchObject({ kind: 'retryScheduled' });
        expect(await journey.poll()).toMatchObject({ kind: 'committed' });
        expect(spawns).toBe(1);
        expect(admitted).toHaveLength(1);
        const attachments = admitted[0]!.attachments!;
        expect(attachments).toHaveLength(2);
        await journey.resolveAttachments({ sessionId, localId: 'email-replay-local-1', attachments: attachments.map((attachment, index) => ({
          instanceId: `ingest-${index}`, key: ComposerAttachmentKeyV1Schema.parse(attachment.value.key),
          value: ChannelFileValueV1Schema.parse(attachment.value.value),
        })) });
        expect(materializedBytes).toHaveLength(2);
        expect(materializedBytes.map(bytes => Buffer.from(bytes).toString('base64'))).toEqual(expect.arrayContaining([
          embedded.toString('base64'), pdf.toString('base64'),
        ]));
        expect([...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'binding')).toHaveLength(2);
        imap.control.addMessage('INBOX', { raw: Buffer.from([
          'From: sales@example.com', `To: ${mailbox}`, 'Message-ID: <followup@example.com>',
          'References: <first@example.com>', 'In-Reply-To: <first@example.com>',
          'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
          'Subject: Re: Forwarded lead', '', 'Additional fixture detail.',
        ].join('\r\n')), internaldate: new Date() });
        expect(await journey.poll()).toMatchObject({ kind: 'committed' });
        expect(admitted).toHaveLength(2);
        expect(spawns).toBe(1);
        expect(transcript.filter(item => item.kind === 'userText').map(item => item.sessionId)).toEqual([sessionId, sessionId]);
        return;
      }
      const checkpoint = [...journey.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint');
      if (!checkpoint) throw new Error('Expected the IMAP baseline');
      const nativeBatch = journey.state.batch.bind(journey.state);
      let failCensus = true;
      let failCheckpoint = true;
      journey.state.batch = async operations => {
        if (failCensus && operations.some(operation => operation.kind === 'put'
          && operation.value !== null && typeof operation.value === 'object'
          && 'record-kind' in operation.value && operation.value['record-kind'] === 'ingress-census')) {
          failCensus = false;
          throw new Error('Lost first census commit after child creation');
        }
        if (failCheckpoint && operations.some(operation => operation.kind === 'put'
          && operation.value !== null && typeof operation.value === 'object'
          && 'record-kind' in operation.value && operation.value['record-kind'] === 'checkpoint')) {
          failCheckpoint = false;
          throw new Error('Lost checkpoint commit after admission');
        }
        return nativeBatch(operations);
      };
      const receipt = new Date();
      imap.control.addMessage('INBOX', { raw: mime('first', 'FIRST'), internaldate: receipt });
      await expect(journey.poll()).rejects.toThrow('Lost first census commit');
      const first = polls.at(-1);
      expect(spawns).toBe(1);
      expect(admitted).toHaveLength(0);
      expect([...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census')).toHaveLength(0);
      await expect(journey.poll()).rejects.toThrow('Lost checkpoint commit');
      expect(polls.at(-1)).toEqual(first);
      expect(admitted.map(message => message.text)).toEqual(['FIRST\nOn Monday, Alice wrote:\n> HISTORY']);
      await journey.poll();
      expect(polls.at(-1)).toEqual(first);
      expect(admitted).toHaveLength(1);
      expect(spawns).toBe(1);
      const user = transcript[0]!;
      if (user.kind !== 'userText') throw new Error('Expected first user input');
      transcript.push({ kind: 'assistantText', sessionId, seq: 2, itemId: 'first-answer', turnId: 'first-turn', final: 'completed',
        text: 'Answer', consumedInputs: [{ localId: user.localId, origin: user.origin }] });
      await journey.outward();
      await journey.retention();
      const census = [...journey.state.rows.values()].find(row => row.value['record-kind'] === 'ingress-census');
      expect(census?.value.payload).toMatchObject({ normalizedIngress: null,
        compacted: { shell: { message: { id: '<first@example.com>' } } } });
      // Re-present the real mailbox UID after a host checkpoint recovery. The
      // current binding's birth-message exclusion keeps its full history.
      const restoreBaseline = async () => {
        const current = await journey.state.get(checkpoint.rowId);
        if (!current) throw new Error('Missing checkpoint');
        await journey.state.put(checkpoint.value, { expectedRevision: current.revision });
      };
      await restoreBaseline();
      await journey.poll();
      expect(polls.at(-1)).toEqual(first);
      expect(admitted).toHaveLength(1);
      if (!census) throw new Error('Missing compacted census');
      const historicPayload = census.value.payload as Record<string, unknown>;
      // A retained shaping fact may disagree; it must have no authority now.
      await journey.state.put({ ...census.value, payload: { ...historicPayload, endpointWasRetainedAtPoll: true } },
        { expectedRevision: census.revision });
      await restoreBaseline();
      await journey.poll();
      expect(polls.at(-1)).toEqual(first);
      expect(admitted).toHaveLength(1);
      imap.control.addMessage('INBOX', { raw: mime('followup', 'FOLLOWUP', true), internaldate: receipt });
      await journey.poll();
      expect(admitted.map(message => message.text)).toEqual(['FIRST\nOn Monday, Alice wrote:\n> HISTORY', 'FOLLOWUP']);
      expect(spawns).toBe(1);
      // Once compacted, only native identity remains authoritative. Changed
      // text for that processed mail cannot create a new conflict or admission.
      imap.control.addMessage('INBOX', { raw: mime('first', 'CHANGED'), internaldate: receipt });
      expect(await journey.poll()).toMatchObject({ kind: 'committed' });
      expect(admitted).toHaveLength(2);
      const conflicts = [...journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census'
        && row.value.attention === true);
      expect(conflicts).toHaveLength(0);
      imap.control.addMessage('INBOX', { raw: mime('after-replay', 'STILL LIVE', true), internaldate: receipt });
      expect(await journey.poll()).toMatchObject({ kind: 'committed' });
      expect(admitted.map(message => message.text)).toEqual(['FIRST\nOn Monday, Alice wrote:\n> HISTORY', 'FOLLOWUP', 'STILL LIVE']);
      expect(spawns).toBe(1);
    } finally { await journey.dispose(); }
  }, 30_000);

  it('establishes the null baseline at UIDNEXT without replaying existing or expunged mail', async () => {
    imap.control.addMessage('INBOX', { raw: raw('historic') });
    const expunged = imap.control.addMessage('INBOX', { raw: raw('expunged') });
    imap.control.expungeMessages('INBOX', [expunged.uid]);
    const initial = await transport.listSince(null, 10_000, 10);
    expect(initial).toEqual({ kind: 'batch', refs: [], checkpointAfterBatch: {
      uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: expunged.uid,
    } });
    if (initial.kind !== 'batch') throw new Error('Expected baseline');
    imap.control.addMessage('INBOX', { raw: raw('new') });
    const next = await transport.listSince(initial.checkpointAfterBatch, 0, 10);
    expect(next).toMatchObject({ kind: 'batch', refs: [expect.any(String)] });
    if (next.kind !== 'batch') throw new Error('Expected new arrival');
    expect((await transport.fetchRaw(next.refs[0])).mime).toEqual(raw('new'));
  });

  it('establishes an empty baseline without entering IDLE before its checkpoint is committed', async () => {
    const abort = new AbortController();
    imap.on('session', (event: { type: string; command?: string }) => {
      if (event.type === 'waiting' && event.command === 'IDLE') abort.abort(new Error('Baseline entered IDLE'));
    });
    expect(await transport.listSince(null, 10_000, 10, abort.signal)).toEqual({ kind: 'batch', refs: [],
      checkpointAfterBatch: { uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: 0 } });
  });

  it('wakes IDLE on arrival within the containing waitMs', async () => {
    const initial = await transport.listSince(null, 0, 10);
    if (initial.kind !== 'batch') throw new Error('Expected initial batch');
    const idling = new Promise<void>((resolve) => imap.on('session', (event: { type: string; command?: string }) => {
      if (event.type === 'waiting' && event.command === 'IDLE') resolve();
    }));
    const pending = transport.listSince(initial.checkpointAfterBatch, 10_000, 10);
    await idling;
    imap.control.addMessage('INBOX', { raw: raw('wake') });
    const result = await pending;
    expect(result).toMatchObject({ kind: 'batch', refs: [expect.any(String)] });
  });

  it('reports UIDVALIDITY replacement rather than confusing a reused UID with the old message', async () => {
    imap.control.addMessage('INBOX', { raw: raw('old') });
    const first = await transport.listSince(null, 0, 10);
    if (first.kind !== 'batch') throw new Error('Expected batch');
    const oldRef = JSON.stringify({ uidValidity: imap.control.getMailbox('INBOX').uidvalidity.toString(), uid: 1 });
    imap.control.resetUidValidity('INBOX');
    expect(await transport.listSince(first.checkpointAfterBatch, 0, 10)).toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
    await expect(transport.fetchRaw(oldRef)).rejects.toThrow();
    const baseline = await transport.listSince(null, 10_000, 10);
    expect(baseline).toEqual({ kind: 'batch', refs: [], checkpointAfterBatch: {
      uidValidity: String(imap.control.getMailbox('INBOX').uidvalidity), lastUid: imap.control.getMailbox('INBOX').uidnext - 1,
    } });
    if (baseline.kind !== 'batch') throw new Error('Expected recovery baseline');
    imap.control.addMessage('INBOX', { raw: raw('after-reset') });
    const next = await transport.listSince(baseline.checkpointAfterBatch, 0, 10);
    if (next.kind !== 'batch') throw new Error('Expected arrival after reset');
    expect(next.refs).toHaveLength(1);
    expect((await transport.fetchRaw(next.refs[0])).mime).toEqual(raw('after-reset'));
  });

  it('fetches the email core RFC Message-ID from Inbox or Sent for reply context and lazy attachments', async () => {
    const receivedAt = new Date('2026-10-12T08:00:00Z');
    imap.control.addMessage('INBOX', { raw: raw('incoming-reference'), internaldate: receivedAt });
    imap.control.addMessage('Sent', { raw: raw('outgoing-reference'), internaldate: receivedAt });
    expect(await transport.fetchRaw('<incoming-reference@example.com>')).toEqual({ mime: raw('incoming-reference'), receivedAtMs: receivedAt.getTime() });
    expect(await transport.fetchRaw('<outgoing-reference@example.com>')).toEqual({ mime: raw('outgoing-reference'), receivedAtMs: receivedAt.getTime() });
  });

  it.each([false, true])('submits raw reply and start MIME; saves exactly one Sent copy (server saves=%s)', async (serverSaves) => {
    saveSent = serverSaves;
    const start = raw('start');
    const reply = Buffer.from(raw('reply').toString().replace('Subject:', 'In-Reply-To: <start@example.com>\r\nReferences: <start@example.com>\r\nSubject:'));
    for (const [bytes, id] of [[start, 'start'], [reply, 'reply']] as const) {
      expect(await transport.submitRaw(bytes, { from: mailbox, to: ['sales@example.com'] }, `<${id}@example.com>`))
        .toEqual({ kind: 'delivered', providerMessageIds: [`<${id}@example.com>`] });
      expect(await transport.findSent(`<${id}@example.com>`)).toBe(true);
    }
    expect(submitted).toEqual([start, reply]);
    expect(imap.control.listMessages('Sent')).toHaveLength(2);
    expect(await transport.findSent('<missing@example.com>')).toBe(false);
  });

  it.each([false, true])('preserves known SMTP acceptance when Sent maintenance fails (partial=%s)', async partial => {
    const copyUnavailable = createImapSmtpTransport({ ...account, sentFolder: 'Unavailable' }, { ca: imap.getCredentials().cert });
    const result = await copyUnavailable.submitRaw(raw('accepted'), {
      from: mailbox, to: partial ? ['sales@example.com', 'rejected@example.com'] : ['sales@example.com'],
    }, '<accepted@example.com>');
    expect(result).toEqual(partial
      ? { kind: 'partial', providerMessageIds: ['<accepted@example.com>'], failedChunk: 0 }
      : { kind: 'delivered', providerMessageIds: ['<accepted@example.com>'] });
    expect(submitted).toHaveLength(1);
    expect(imap.control.listMessages('Sent')).toHaveLength(0);
  });

  it.each([[451, 'safe'], [550, 'never']] as const)('maps SMTP %i to %s without a Sent copy', async (code, retry) => {
    rejection = code;
    expect(await transport.submitRaw(raw('refused'), { from: mailbox, to: ['sales@example.com'] }, '<refused@example.com>'))
      .toEqual({ kind: 'notDelivered', retry });
    expect(imap.control.listMessages('Sent')).toHaveLength(0);
  });

  it('authenticates both real servers with XOAUTH2 access tokens', async () => {
    transport = createImapSmtpTransport({ ...account, auth: { user: mailbox, accessToken: 'testtoken' } }, { ca: imap.getCredentials().cert });
    expect(await transport.connectionTest()).toEqual({ kind: 'ready', mailbox });
    expect(await transport.submitRaw(raw('oauth'), { from: mailbox, to: ['sales@example.com'] }, '<oauth@example.com>')).toMatchObject({ kind: 'delivered' });
  });

  it.each(['password', 'oauth2'] as const)('authenticates with %s through the development plugin loader', async (mode) => {
    // Bootstrap the real CLI loader from its package, then let that owner load
    // the transport. Keep both TLS protocol servers real.
    const { createJiti } = createRequire(new URL('../../../../../../apps/cli/package.json', import.meta.url))('jiti') as {
      createJiti: (filename: string, options: { alias: Record<string, string>; interopDefault: boolean }) => {
        import: (filename: string) => Promise<{
          createPluginTypeScriptCandidateScope(options: { rootPath: string }): Promise<object>;
          loadVerifiedPluginModule(options: { entryPath: string; loadMode: 'source-ts'; generationScope: object }): Promise<{ createImapSmtpTransport: typeof createImapSmtpTransport }>;
        }>;
      };
    };
    const cliSource = fileURLToPath(new URL('../../../../../../apps/cli/src/', import.meta.url));
    const bootstrap = createJiti(fileURLToPath(import.meta.url), { alias: { '@': cliSource }, interopDefault: false });
    const loader = await bootstrap.import(fileURLToPath(new URL('../../../../../../apps/cli/src/plugins/runtime/loadPluginModule.ts', import.meta.url)));
    const loaded = await loader.loadVerifiedPluginModule({
      entryPath: fileURLToPath(new URL('./client.ts', import.meta.url)), loadMode: 'source-ts',
      generationScope: await loader.createPluginTypeScriptCandidateScope({ rootPath: fileURLToPath(new URL('../../../', import.meta.url)) }),
    });
    const auth = mode === 'password' ? account.auth : { user: mailbox, accessToken: 'testtoken' };
    await expect(loaded.createImapSmtpTransport({ ...account, auth, tlsCaPem: imap.getCredentials().cert.toString() }).connectionTest())
      .resolves.toEqual({ kind: 'ready', mailbox });
  });

  it('authenticates through the compiled CommonJS transport with both SMTP constructors bundled', async () => {
    // Execute the real compiler output in memory; the CLI owns this bundler.
    const { build } = createRequire(new URL('../../../../../../apps/cli/package.json', import.meta.url))('esbuild') as typeof import('esbuild');
    const result = await build({ entryPoints: [fileURLToPath(new URL('./client.ts', import.meta.url))],
      platform: 'node', format: 'cjs', bundle: true, write: false, logLevel: 'silent' });
    const module: { exports: { createImapSmtpTransport?: typeof createImapSmtpTransport } } = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    const factory = module.exports.createImapSmtpTransport;
    if (!factory) throw new Error('Compiled transport export is missing');
    await expect(factory({ ...account, auth: { user: mailbox, accessToken: 'testtoken' },
      tlsCaPem: imap.getCredentials().cert.toString() }).connectionTest()).resolves.toEqual({ kind: 'ready', mailbox });
  });

  it('rejects a private TLS certificate by default and accepts its configured CA for both protocols', async () => {
    setDefaultCACertificates(originalCertificates);
    await expect(createImapSmtpTransport(account).connectionTest()).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const configuredAccount = { ...account, tlsCaPem: imap.getCredentials().cert.toString() };
    expect(await createImapSmtpTransport(configuredAccount).connectionTest()).toEqual({ kind: 'ready', mailbox });
    const unrelatedCa = originalCertificates[0];
    if (!unrelatedCa) throw new Error('Expected a standard trusted CA for the negative control');
    await expect(createImapSmtpTransport({ ...account, tlsCaPem: unrelatedCa }).connectionTest())
      .rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it('submits over implicit TLS as used by port 465, with certificate verification', async () => {
    const options = smtp.options;
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    smtp = new SMTPServer({ ...options, secure: true });
    smtp.listen(0, '127.0.0.1'); await once(smtp.server, 'listening');
    const address = smtp.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing implicit TLS listener');
    transport = createImapSmtpTransport({ ...account, smtpPort: address.port, smtpSecurity: 'tls' }, { ca: imap.getCredentials().cert });
    expect(await transport.submitRaw(raw('implicit-tls'), { from: mailbox, to: ['sales@example.com'] }, '<implicit-tls@example.com>'))
      .toEqual({ kind: 'delivered', providerMessageIds: ['<implicit-tls@example.com>'] });
  });

  it('keeps a lost SMTP DATA receipt ambiguous and reconciles the server-saved Sent identity without resending', async () => {
    loseReceipt = true; saveSent = true;
    expect(await transport.submitRaw(raw('lost'), { from: mailbox, to: ['sales@example.com'] }, '<lost@example.com>'))
      .toMatchObject({ kind: 'outcomeUnknown' });
    expect(await transport.findSent('<lost@example.com>')).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  it('cancels a pending SMTP receipt and closes the connection rather than leaving a send behind', async () => {
    holdReceipt = true;
    const received = new Promise<void>((resolve) => { onSubmitted = resolve; });
    const abort = new AbortController();
    const pending = transport.submitRaw(raw('cancel'), { from: mailbox, to: ['sales@example.com'] }, '<cancel@example.com>', abort.signal);
    const assertion = expect(pending).rejects.toThrow();
    await received; abort.abort(); await assertion;
    await expect.poll(() => smtp.connections.size).toBe(0);
  });

  it('cancels IDLE and closes its socket without waiting for the poll duration', async () => {
    const initial = await transport.listSince(null, 0, 10);
    if (initial.kind !== 'batch') throw new Error('Expected batch');
    const abort = new AbortController();
    const idling = new Promise<void>((resolve) => imap.on('session', (event: { type: string; command?: string }) => {
      if (event.type === 'waiting' && event.command === 'IDLE') resolve();
    }));
    const pending = transport.listSince(initial.checkpointAfterBatch, 10_000, 10, abort.signal);
    const rejectionAssertion = expect(pending).rejects.toThrow();
    await idling; abort.abort(); await rejectionAssertion;
    await expect.poll(() => imap.control.sessions()).toHaveLength(0);
  });

  it.each(['password', 'microsoft-app-only'])('completes %s only after live IMAP and SMTP login, and materializes no application secret', async (modeId) => {
    setDefaultCACertificates(originalCertificates);
    const tlsCaPem = imap.getCredentials().cert.toString();
    registeredPlugin = await createPluginTestkit({ manifest: emailPlugin.manifest, module: emailPlugin });
    const runtime = registeredPlugin.registration('connectedAccountDescriptors', IMAP_SMTP_CONNECTED_ACCOUNT_ID);
    if (!runtime) throw new Error('Missing registered Connected Account runtime');
    const mode = runtime.authentication.modes[modeId];
    if (!mode || mode.kind !== 'manual') throw new Error('Missing manual mode');
    const stored = new Map<string, string>();
    const credentials: ConnectedAccountCredentialStore = {
      async get(key) { return stored.get(key) ?? null; },
      async set(key, value) { stored.set(key, value); },
      async delete(key) { stored.delete(key); },
    };
    // Host and credential-store adapters are genuine boundaries; the runtime
    // consumes only configuration, signal, HTTP and these credential members.
    const context = {
      configuration: { target: { kind: 'attempt', modeId }, values: { mailbox, imapHost: 'localhost', imapPort: account.imapPort, smtpHost: 'localhost', smtpPort: account.smtpPort, tlsCaPem }, getSecret: async () => null },
      signal: new AbortController().signal, attemptCredentials: credentials,
      services: { http: { async request() { return { status: 200, finalUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token', headers: {}, body: Buffer.from(JSON.stringify({ access_token: 'testtoken', token_type: 'Bearer' })) }; } } },
    } as unknown as ConnectedAccountAuthenticationContext;
    const fields: Record<string, string> = modeId === 'password' ? { password: 'testpass' } : { tenantId: 'tenant', clientId: 'app', clientSecret: 'application-secret' };
    const result = await mode.complete({ fields }, context);
    expect(result).toMatchObject({ status: 'connected', accountId: mailbox });
    expect(imap.sessionCounter).toBeGreaterThan(0);
    const readContext = { ...context, credentials } as unknown as ConnectedAccountReadContext;
    const materialized = await runtime.materialize({ kind: 'environment', keys: ['HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT', 'UNRELATED'] }, readContext);
    expect(materialized.kind).toBe('environment');
    if (materialized.kind !== 'environment') throw new Error('Missing environment');
    expect(Object.keys(materialized.env)).toEqual(['HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT']);
    expect(JSON.parse(materialized.env.HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT)).toMatchObject({ mailbox, tlsCaPem, auth: modeId === 'password' ? { pass: 'testpass' } : { accessToken: 'testtoken' } });
    expect(JSON.stringify(materialized)).not.toContain('application-secret');
    const bad: Record<string, string> = modeId === 'password' ? { password: 'wrong' } : { tenantId: 'tenant', clientId: 'app', clientSecret: 'application-secret' };
    if (modeId === 'microsoft-app-only') imap.control.updateUser(mailbox, { xoauth2: { accessToken: 'revoked' } });
    const rejectedStore = new Map<string, string>();
    const rejectedContext = { ...context, attemptCredentials: { ...credentials, async set(key: string, value: string) { rejectedStore.set(key, value); } } };
    expect(await mode.complete({ fields: bad }, rejectedContext)).toMatchObject({ status: 'rejected' });
    expect(rejectedStore.size).toBe(0);
  });

  it('invokes the declared transport connection Action with exact Connected Account materialization and rejects other callers', async () => {
    setDefaultCACertificates(originalCertificates);
    let configuredAccount = { ...account, tlsCaPem: imap.getCredentials().cert.toString() };
    const test = imapSmtpActions['transport/imap-smtp/connection-test-v1'].run;
    const credentialRef = { service: { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' }, accountId: mailbox };
    const input = { credentialRef, config: {} };
    const context = {
      surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.channel.email' }, signal: new AbortController().signal,
      services: { connectedAccounts: { async materialize(purpose: string, request: unknown, options: { expectedAccount: unknown }) {
        expect(purpose).toBe('email-mailbox');
        expect(request).toEqual({ kind: 'environment', keys: ['HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT'] });
        expect(options.expectedAccount).toEqual(credentialRef);
        return { kind: 'environment', env: { HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT: JSON.stringify(configuredAccount) } };
      } } },
    } as unknown as PluginInvocationContext;
    expect(await test(input, context)).toEqual({ kind: 'ready', mailbox });
    const receivedAt = new Date('2026-10-12T07:00:00Z');
    imap.control.addMessage('INBOX', { raw: raw('action-contract'), internaldate: receivedAt });
    const fetched = await imapSmtpActions['transport/imap-smtp/fetch-raw-v1'].run({ ...input, ref: '<action-contract@example.com>' }, context);
    expect(EmailTransportFetchRawResultV1Schema.parse(fetched)).toEqual({ kind: 'raw', mimeBase64: raw('action-contract').toString('base64'),
      receivedAtMs: receivedAt.getTime() });
    // Replacing configuration keeps the Account identity and re-materializes
    // its current endpoint for Test and the next poll, with no retained client.
    await imap.stop();
    imap = imapkit({
      secureConnection: true, plugins: ['IDLE', 'SPECIAL-USE', 'UIDPLUS', 'SASL-IR'],
      users: { [mailbox]: { password: 'testpass' } },
      storage: { INBOX: {}, '': { folders: { Sent: { 'special-use': '\\Sent' } } } },
    });
    const replacementPort = await imap.start(0, '127.0.0.1');
    configuredAccount = { ...configuredAccount, imapPort: replacementPort, tlsCaPem: configuredAccount.tlsCaPem + '\n' + imap.getCredentials().cert.toString() };
    expect(await test(input, context)).toEqual({ kind: 'ready', mailbox });
    const polled = await imapSmtpActions['transport/imap-smtp/list-since-v1'].run({ ...input, checkpoint: null, waitMs: 0, limit: 1 }, context);
    expect(polled).toMatchObject({ kind: 'batch', refs: [] });
    if (context.caller?.kind !== 'plugin') throw new Error('Missing plugin caller fixture');
    await expect(test(input, { ...context, caller: { ...context.caller, pluginId: 'other.plugin' } })).rejects.toThrow();
    expect(await test({ ...input, credentialRef: null }, context)).toMatchObject({ kind: 'notReady', reason: 'credentialInvalid' });
  });
});
