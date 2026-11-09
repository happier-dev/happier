import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getConversationAttachmentIdRepresentationsV1, readConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';
import { simpleParser } from 'mailparser';
import { PluginError } from '@happier-dev/plugin-sdk';
import { EMAIL_CHANNEL_ACTION_IDS as ids } from './constants.js';
import { ConversationAttachmentFetchResultV1Schema, ConversationPollResultV1Schema,
  MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
  ConversationPrincipalResolveResultV1Schema } from '@happier-dev/channels-protocol/v1';

import { createEmailTransportFixture as fixture, mailbox, incoming, config, connection, thread, delivery } from '../testkit/emailTransportFixture.js';

describe('email core with an external contributed raw transport', () => {
  it('shapes a retained-thread replay from current bindings without reverse host reads', async () => {
    const f = await fixture();
    try {
      f.setMessages([['retained-message', Buffer.from([
        'From: alice@example.com', `To: ${mailbox}`, 'Message-ID: <retained@example.com>', `References: ${thread.id}`,
        'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
        'Content-Type: text/plain; charset=utf-8', '', 'NEW', 'On Monday, Alice wrote:', '> HISTORY',
      ].join('\r\n'))]]);
      const result = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, {
        ...connection, checkpoint: { position: 0 }, limit: 10, waitMs: 0, bindings: [{ endpoint: thread }],
      }));
      if (result.kind !== 'batch') throw new Error('Expected a retained-thread Email batch.');
      const entry = result.observations[0];
      if (entry?.observation.kind !== 'fullText') throw new Error('Expected retained Email text.');
      expect(entry.observation.observation.message.text).toContain('NEW');
      expect(entry.observation.observation.message.text).not.toContain('HISTORY');
      expect(entry.observation.observation.actor).toMatchObject({ kind: 'human', principalId: 'alice@example.com' });
      expect(result.checkpointAfterBatch).toEqual({ position: 1 });
      expect(f.connectionReadRequests).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it('rethrows generation retirement during reply preparation without submitting', async () => {
    const f = await fixture();
    try {
      f.setFetchFailure(new PluginError({ code: 'plugin_final_generation_retired', message: 'Retired fixture generation' }));
      await expect(f.invoke(ids.messageDeliver, delivery)).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
      expect(f.submissions).toHaveLength(0);
    } finally { await f.dispose(); }
  });
  it('keeps parser-rejected content terminal while advancing the successful batch', async () => {
    const f = await fixture();
    try {
      // mailparser 3.9.38 / mailsplit rejects headers over its own 1 MiB boundary
      // with EMAXLEN; this exercises real content rejection, not an invented cap.
      f.setMessages([['oversized-header', Buffer.from(`X-Invalid: ${'x'.repeat(1024 * 1024)}\r\n\r\nbody`)]]);
      await expect(f.invoke(ids.observationsPoll, { ...connection, checkpoint: { position: 0 }, limit: 10, waitMs: 0 }))
        .resolves.toMatchObject({ kind: 'batch', checkpointAfterBatch: { position: 1 }, observations: [{
          observation: { kind: 'routableNonAdmission', reason: 'unsupportedContent', shell: { actor: { principalId: null } } },
        }] });
    } finally { await f.dispose(); }
  });

  it('never resubmits accepted Email custody when a restart cannot start the Sent reconciliation handler, while a new answer still sends', async () => {
    const f = await fixture();
    try {
      f.setInvocationTime(1_792_000_000_000);
      f.loseNextSettlement();
      const initial = await f.custody('answer-1');
      expect(f.submissions).toHaveLength(1);
      expect(initial).toEqual(expect.objectContaining({ kind: 'settlementPending' }));
      const firstMessageId = f.submissions[0]!.messageId;
      f.setInvocationTime(1_792_000_100_000);
      f.setReconciliationHandlerMissing(true);
      const recovery = await f.custody('answer-1', true);
      // Recovering the host transport cannot turn an unobserved Sent lookup
      // into evidence that the original SMTP submission never happened.
      f.setReconciliationHandlerMissing(false);
      f.setInvocationTime(1_792_001_000_000);
      await f.custody('answer-1');
      expect(f.submissions.map(request => request.messageId)).toEqual([firstMessageId]);
      expect(recovery).toMatchObject({ kind: 'settled', custody: { state: 'outcomeUnknown' } });
      await expect(f.custody('answer-2')).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
      expect(f.submissions).toHaveLength(2);
      expect(f.submissions[1]!.messageId).not.toBe(firstMessageId);
      // An available Sent lookup still settles an accepted-but-unsettled send.
      f.loseNextSettlement();
      await expect(f.custody('answer-3')).resolves.toMatchObject({ kind: 'settlementPending' });
      await expect(f.custody('answer-3', true)).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
      await f.custody('answer-3');
      expect(f.submissions).toHaveLength(3);
    } finally { await f.dispose(); }
  });

  it('keeps retained seed1 attachment evidence stable across the portable attachment codec extraction', async () => {
    // Original retained harness 3-wilson.eml, read-only from nl3 on 2026-10-21.
    // Store with LF; reconstruct its original RFC5322 CRLF bytes at the boundary.
    const raw = Buffer.from((await readFile(new URL('./email/fixtures/seed1-forwarded-attachments.eml', import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
    const native = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true });
    const messageId = native.messageId;
    if (!messageId) throw new Error('Retained fixture has no Message-ID');
    // Exact pre-change derivation: dd247000f8^:channel-email/src/email/parse.ts.
    // mailparser flattens this 8bit inline message/rfc822; only its PDF is
    // returned as a file, under the native third MIME part.
    const retained = native.attachments.map((file, index) => ({
      attachmentId: `mime:${file.partId ?? index + 1}`,
      name: file.filename!, mediaType: file.contentType, byteLength: file.content.byteLength,
    }));
    expect(retained.map(file => file.attachmentId)).toEqual(['mime:3']);
    const retainedConfig = { ...config, mailbox: 'wilson@test.local', allowedDomains: ['test.local'],
      trustStrategy: { kind: 'authenticationResults', authservId: 'mx.seed1.test.local' } };
    const f = await fixture({ providerConfig: retainedConfig });
    try {
      f.setMessages([['retained-seed1', raw]]);
      const polled = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, {
        ...connection, providerConnectionKey: 'email:wilson@test.local',
        providerConfig: retainedConfig,
        checkpoint: null, limit: 10, waitMs: 0,
      }));
      if (polled.kind !== 'batch' || polled.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected retained email');
      const message = polled.observations[0].observation.observation.message;
      expect(message.id).toBe(native.messageId);
      // Keep FIX-LIVE42's historical PDF evidence check when a missing EML is restored.
      expect(message.attachments).toEqual(expect.arrayContaining(retained.map(file => ({
        ...file, attachmentId: getConversationAttachmentIdRepresentationsV1(file.attachmentId)[0],
      }))));
      const eml = Buffer.from(['From: client@example.invalid', 'To: sales1@test.local',
        'Subject: QA LIVE13 lead', 'Message-ID: <qa-live13-inner@example.invalid>',
        'Content-Type: text/plain; charset=utf-8', '',
        'Atelier Delta souhaite six chaises ergonomiques.', ''].join('\r\n'));
      expect(message.attachments).toEqual([
        { attachmentId: getConversationAttachmentIdRepresentationsV1('mime:2')[0],
          name: 'qa-live13-lead.eml', mediaType: 'message/rfc822', byteLength: eml.byteLength },
        ...retained.map(file => ({ ...file, attachmentId: getConversationAttachmentIdRepresentationsV1(file.attachmentId)[0] })),
      ]);
      expect(message.text).toContain('Forwarded email (untrusted)');
      expect(message.text).toContain('Atelier Delta souhaite six chaises ergonomiques.');
      f.addMessage(messageId, raw);
      const fetched = ConversationAttachmentFetchResultV1Schema.parse(await f.invoke(ids.attachmentFetch, {
        ...connection, providerConnectionKey: 'email:wilson@test.local',
        providerConfig: retainedConfig,
        messageId, attachmentIds: message.attachments!.map(file => file.attachmentId),
      }));
      if (fetched.kind !== 'fetched') throw new Error('Expected both retained attachments');
      expect(fetched.attachments.map(file => Buffer.from(file.base64, 'base64'))).toEqual([eml, native.attachments[0]!.content]);
    } finally { await f.dispose(); }
  });

  it.each([null, 'Mon, 12 Oct 2020 07:00:00 +0000', 'Mon, 12 Oct 2032 07:00:00 +0000'])(
    'uses immutable receipt time for admission while preserving authored Date (%s)', async authoredDate => {
      const f = await fixture();
      try {
        const dated = Buffer.from([...(authoredDate === null ? [] : [`Date: ${authoredDate}`]), incoming.toString()].join('\r\n'));
        f.setMessages([['opaque-incoming', dated]]);
        const poll = { ...connection, checkpoint: { position: 0 }, limit: 10, waitMs: 0 };
        f.setInvocationTime(1_792_100_000_000);
        const first = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, poll));
        f.setInvocationTime(1_792_100_100_000);
        const replay = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, poll));
        expect(replay).toEqual(first);
        if (first.kind !== 'batch' || first.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected a full email observation');
        expect(first.observations[0].observation.observation).toMatchObject({ occurredAt: f.receivedAtMs,
          message: { providerTimestamp: authoredDate === null ? f.receivedAtMs : Date.parse(authoredDate) } });
      } finally { await f.dispose(); }
    },
  );
  it('authenticates the selected contributed mailbox during setup without inventing an outbound cap', async () => {
    const f = await fixture();
    try {
      await expect(f.invoke(ids.setup, { ...config, credentialRef: { service: { pluginId: 'acme.email.fixture', localId: 'mail' }, accountId: mailbox } }))
        .resolves.toMatchObject({ providerConnectionKey: `email:${mailbox}`, setupGuidance: { steps: [
          { title: expect.any(String) },
          { title: expect.any(String), copyableValues: [
            { label: expect.any(String), value: '993' },
            { label: expect.any(String), value: '587' },
            { label: expect.any(String), value: '465' },
          ] },
          { title: expect.any(String) },
          { title: expect.any(String), copyableValues: [
            { label: expect.any(String), value: 'authenticationResults' },
            { label: expect.any(String), value: 'exchangeOrganization' },
          ] },
          { title: expect.any(String), externalUrl: 'https://www.rfc-editor.org/rfc/rfc8601.html' },
        ] } });
    } finally { await f.dispose(); }
  });

  it.each([
    { name: 'ordinary subject', subject: 'Re: Question', label: 'Re: Question' },
    { name: 'empty subject', subject: '', label: undefined },
    { name: 'long subject', subject: 'A'.repeat(MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS + 1),
      label: 'A'.repeat(MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS) },
  ])('receives a trusted thread with $name and strips only history already held by a binding', async ({ subject, label }) => {
    const f = await fixture();
    try {
      f.replaceFetched(Buffer.from(incoming.toString().replace('Subject: Re: Question', `Subject: ${subject}`)));
      const poll = { ...connection, checkpoint: null, limit: 10, waitMs: 0 };
      const first = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, poll));
      expect(first).toMatchObject({ kind: 'batch', observations: [{ observation: {
        kind: 'fullText', observation: { endpoint: thread, actor: { principalId: 'alice@example.com', kind: 'human' },
          message: { id: '<incoming@example.com>', text: expect.stringContaining('HISTORY') } },
      } }] });
      if (first.kind !== 'batch' || first.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected a full email observation');
      expect(first.observations[0].observation.observation.endpoint.label).toBe(label);
      await expect(f.invoke(ids.observationsPoll, { ...poll, bindings: [{ endpoint: thread }] })).resolves.toMatchObject({
        observations: [{ observation: { observation: { message: { text: 'ANSWER' } } } }], checkpointAfterBatch: { position: 1 },
      });
    } finally { await f.dispose(); }
  });

  it('replies only to the authenticated author and refuses a mismatched Message-ID lookup', async () => {
    const f = await fixture();
    try {
      await expect(f.invoke(ids.messageDeliver, delivery)).resolves.toMatchObject({ kind: 'delivered' });
      const raw = [...f.sent.values()][0]!;
      const parsed = await simpleParser(Buffer.from(raw));
      expect(parsed.inReplyTo).toBe('<incoming@example.com>');
      expect(parsed.references).toEqual(['<root@example.com>', '<incoming@example.com>']);
      expect(parsed.to).toMatchObject({ value: [{ address: 'alice@example.com' }] });
      expect(parsed.cc).toBeUndefined();
      f.replaceFetched(Buffer.from(incoming.toString().replace('<incoming@example.com>', '<different@example.com>')));
      await expect(f.invoke(ids.messageDeliver, delivery)).resolves.toMatchObject({ kind: 'notDelivered', retry: 'never' });
      expect(f.sent.size).toBe(1);
    } finally { await f.dispose(); }
  });

  it('starts with HTML and reconciles an ambiguous submit through the same deterministic identity', async () => {
    const f = await fixture();
    try {
      f.setAmbiguous(true);
      const resolved = ConversationPrincipalResolveResultV1Schema.parse(await f.invoke(ids.principalResolve, {
        ...connection, endpoint: { kind: 'direct', audience: 'direct', id: mailbox }, query: 'Owner@Example.com',
      }));
      expect(resolved.kind).toBe('resolved');
      if (resolved.kind !== 'resolved') return;
      const html = `<h1>${'a'.repeat(120_000)}</h1>`;
      const start = { ...connection, endpoint: { kind: 'direct', audience: 'direct', id: mailbox },
        content: { text: 'Brief', html }, deliveryKey: 'fixture-start',
        newThread: { recipients: resolved.candidates.map(principal => principal.id), subject: 'Brief' },  linkPreviewPolicy: 'providerDefault' };
      await expect(f.invoke(ids.messageDeliver, start)).resolves.toMatchObject({ kind: 'outcomeUnknown' });
      const [messageId, raw] = [...f.sent.entries()][0]!;
      expect((await simpleParser(Buffer.from(raw))).html).toBe(html);
      expect(f.submissions[0]!.envelope.to).toEqual(['owner@example.com']);
      await expect(f.invoke(ids.deliveryReconcile, { ...connection, endpoint: start.endpoint, deliveryKey: start.deliveryKey }))
        .resolves.toMatchObject({ kind: 'delivered', providerMessageIds: [messageId], endpoint: { kind: 'thread', id: messageId, parentId: mailbox } });
      expect(f.sent.size).toBe(1);
      expect(f.submissions).toHaveLength(1);
      f.setAmbiguous(false);
      await expect(f.invoke(ids.messageDeliver, { ...start, deliveryKey: 'confirmed-start' }))
        .resolves.toMatchObject({ kind: 'delivered', endpoint: { kind: 'thread', audience: 'direct', parentId: mailbox } });
      f.setNotFound();
      await expect(f.invoke(ids.deliveryReconcile, { ...connection, endpoint: start.endpoint, deliveryKey: start.deliveryKey }))
        .resolves.toEqual({ kind: 'outcomeUnknown' });
      expect(f.submissions).toHaveLength(2);
    } finally { await f.dispose(); }
  });

  it('projects unknown senders, noise and self while recording content-free trust attention and malformed mail', async () => {
    const f = await fixture();
    const makeMail = (id: string | null, from: string, headers: readonly string[]) => Buffer.from([
      `From: ${from}`, ...(id === null ? [] : [`Message-ID: ${id}`]), 'References: <root@example.com>', ...headers, 'Content-Type: text/plain', '', 'Question',
    ].join('\r\n'));
    const trustedHeader = 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com';
    try {
      f.setMessages([
        ['spoof', makeMail('<spoof@example.com>', 'alice@example.com', [
          'Authentication-Results: attacker.invalid; dmarc=pass header.from=example.com', trustedHeader])],
        ['missing', makeMail('<missing@example.com>', 'alice@example.com', [])],
        ['noise', makeMail('<noise@example.com>', 'alice@example.com', [trustedHeader, 'Auto-Submitted: auto-replied'])],
        ['self', makeMail('<self@example.com>', mailbox, [trustedHeader])],
        ['malformed', makeMail(null, 'alice@example.com', [trustedHeader])],
      ]);
      const polled = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, { ...connection, checkpoint: null, limit: 10, waitMs: 0 }));
      expect(polled.kind).toBe('batch');
      if (polled.kind !== 'batch') return;
      const entries = polled.observations.map(entry => entry.observation);
      for (const index of [0, 1]) expect(entries[index]).toMatchObject({ observation: { actor: { kind: 'unknown', principalId: null } } });
      expect(entries[2]).toMatchObject({ observation: { actor: { kind: 'bot' } } });
      expect(entries[3]).toMatchObject({ observation: { actor: { isIntegrationSelf: true } } });
      expect(entries[4]).toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
      expect(entries[4]).not.toHaveProperty('shell.message.text');
      expect(polled.checkpointAfterBatch).toEqual({ position: 1 });
      expect(f.facts).toContainEqual(expect.objectContaining({ authorityEpoch: 1,
        fact: expect.objectContaining({ kind: 'providerReadiness', status: 'attention', code: 'providerPermissionMissing' }) }));
      expect(JSON.stringify(f.facts)).not.toContain('alice@example.com');
    } finally { await f.dispose(); }
  });

  it.each([
    ['external@example.com', [], false],
    ['alice@example.com', [], true],
    ['alice@example.com', ['Auto-Submitted: auto-replied'], false],
    [mailbox, [], false],
  ] as const)('scopes missing-marker readiness through the registered core for %s', async (from, headers, attention) => {
    const f = await fixture();
    try {
      f.setMessages([['missing', Buffer.from([`From: ${from}`, 'Message-ID: <missing@example.com>',
        'References: <root@example.com>', ...headers, 'Content-Type: text/plain', '', 'Question'].join('\r\n'))]]);
      const result = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, {
        ...connection, checkpoint: { position: 0 }, limit: 10, waitMs: 0,
      }));
      expect(result.kind).toBe('batch');
      expect(f.facts.length > 0).toBe(attention);
      expect(JSON.stringify(f.facts)).not.toContain(from);
    } finally { await f.dispose(); }
  });

  it('fetches stable nested and retained MIME attachment ids without trusting embedded authentication headers', async () => {
    const f = await fixture();
    const auth = 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com';
    const inner = ['From: client@outside.com', 'Message-ID: <inner@outside.com>', auth, 'Subject: Lead',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=inner', '', '--inner', 'Content-Type: text/html', '',
      '<p>Lead details</p><div class="gmail_signature"><img src="cid:logo"></div>', '--inner',
      'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Disposition: inline; filename=logo.png',
      'Content-Transfer-Encoding: base64', '', 'eA==', '--inner', 'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="../../lead.txt"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('nested lead file').toString('base64'), '--inner--', ''].join('\r\n');
    const outer = Buffer.from(['From: alice@example.com', 'Message-ID: <forward@example.com>', auth, 'Subject: Fwd: Lead',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=outer', '', '--outer', 'Content-Type: text/html', '',
      '<p>Process the lead.</p><div class="gmail_signature"><img src="cid:forwarder-logo"></div>', '--outer',
      'Content-Type: image/png', 'Content-ID: <forwarder-logo>', 'Content-Disposition: inline; filename=forwarder-logo.png',
      'Content-Transfer-Encoding: base64', '', 'eA==', '--outer', 'Content-Type: text/plain',
      'Content-Disposition: attachment; filename=outer.txt', '', 'Outer file', '--outer',
      'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename=lead.eml',
      'Content-Transfer-Encoding: base64', '', Buffer.from(inner).toString('base64'), '--outer--', ''].join('\r\n'));
    try {
      f.setMessages([['forward-ref', outer]]);
      f.addMessage('<forward@example.com>', outer);
      const pollInput = { ...connection, checkpoint: null, limit: 10, waitMs: 0 };
      const polled = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, pollInput));
      expect(polled.kind).toBe('batch');
      if (polled.kind !== 'batch') return;
      const entry = polled.observations[0]!.observation;
      expect(entry.kind).toBe('fullText');
      if (entry.kind !== 'fullText') return;
      expect(entry.observation.actor.principalId).toBe('alice@example.com');
      expect(entry.observation.message.contentProvenance).toBe('forwarded');
      expect(entry.observation.message.text).toContain('Lead details');
      const attachments = entry.observation.message.attachments!;
      expect(attachments.map(file => file.name)).not.toContain('forwarder-logo.png');
      expect(attachments.map(file => file.name)).toContain('logo.png');
      const attachment = attachments.find(file => file.name.endsWith('lead.txt'))!;
      expect(readConversationAttachmentIdV1(attachment.attachmentId, 'email')).toHaveLength(2);
      const fetched = ConversationAttachmentFetchResultV1Schema.parse(await f.invoke(ids.attachmentFetch, {
        ...connection, messageId: '<forward@example.com>', attachmentIds: [attachment.attachmentId],
      }));
      expect(fetched.kind).toBe('fetched');
      if (fetched.kind !== 'fetched') throw new Error('Expected an attachment batch');
      expect(Buffer.from(fetched.attachments[0]!.base64, 'base64').toString()).toBe('nested lead file');
      // The pre-extraction writer (5033889b2db, email/parse.ts) joined these
      // native MIME part references with '/'. Retained Session inputs keep it.
      const retainedId = readConversationAttachmentIdV1(attachment.attachmentId, 'email')!.join('/');
      await expect(f.invoke(ids.attachmentFetch, {
        ...connection, messageId: '<forward@example.com>', attachmentIds: [retainedId],
      })).resolves.toEqual({ kind: 'fetched', attachments: [{ attachmentId: retainedId, base64: fetched.attachments[0]!.base64 }] });
      f.replaceFetched(outer);
      await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<different@example.com>', attachmentIds: [attachment.attachmentId] }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
      f.replaceFetched(Buffer.from(outer.toString().replace('dmarc=pass', 'dmarc=fail')));
      await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<forward@example.com>', attachmentIds: [attachment.attachmentId] }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
      const untrusted = Buffer.from(outer.toString().replace(`${auth}\r\n`, '').replace('<forward@example.com>', '<untrusted-forward@example.com>'));
      f.setMessages([['untrusted-ref', untrusted]]);
      f.addMessage('<untrusted-forward@example.com>', untrusted);
      f.replaceFetched(untrusted);
      await expect(f.invoke(ids.observationsPoll, pollInput)).resolves.toMatchObject({ observations: [{ observation: {
        observation: { actor: { kind: 'unknown', principalId: null } },
      } }] });
      await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<untrusted-forward@example.com>', attachmentIds: [attachment.attachmentId] }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
    } finally { await f.dispose(); }
  });

  it('keeps reconciliation unknown without findSent and rejects original handles from a retired contributor', async () => {
    const f = await fixture({ findSent: false });
    try {
      await expect(f.invoke(ids.deliveryReconcile, { ...connection, endpoint: thread, deliveryKey: 'unknown' }))
        .resolves.toEqual({ kind: 'outcomeUnknown' });
      const snapshot = f.retainCatalog();
      expect(snapshot.contributions[0]!.operations.connectionTest!.identity.contributor.pluginId).toBe('acme.email.fixture');
      await expect(f.invoke(ids.connectionTest, { ...connection, selectedTransport: 'checkpointedPull' })).resolves.toMatchObject({ kind: 'ready' });
      await f.retireTransport();
      await expect(f.invoke(ids.connectionTest, { ...connection, selectedTransport: 'checkpointedPull' }))
        .rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
      f.releaseCatalog();
      await expect(f.invoke(ids.observationsPoll, { ...connection, checkpoint: null, limit: 10, waitMs: 0 }))
        .rejects.toMatchObject({ code: 'email_transport_unavailable' });
    } finally { await f.dispose(); }
  });
});
