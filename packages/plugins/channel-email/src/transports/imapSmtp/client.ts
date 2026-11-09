import type { ConnectionOptions } from 'node:tls';
import type { ImapFlow } from 'imapflow';
import type SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import type { ConversationDeliveryResultV1 } from '@happier-dev/channels-protocol/v1';
import type { EmailTransportListSinceResultV1 } from '@happier-dev/email-transports-protocol/v1';

export type ImapSmtpAccount = Readonly<{
  mailbox: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number;
  inboxFolder: string; sentFolder?: string; smtpSecurity?: 'starttls' | 'tls'; tlsCaPem?: string;
  auth: Readonly<{ user: string; pass: string }> | Readonly<{ user: string; accessToken: string }>;
}>;
export type ImapCheckpoint = Readonly<{ uidValidity: string; lastUid: number }>;

function checkpoint(value: unknown): ImapCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  // RFC 3501 UIDs and UIDVALIDITY are nonzero unsigned 32-bit integers.
  if (typeof row.uidValidity !== 'string' || !/^[1-9][0-9]*$/.test(row.uidValidity)
    || BigInt(row.uidValidity) > 0xffffffffn || typeof row.lastUid !== 'number'
    || !Number.isInteger(row.lastUid) || row.lastUid < 0 || row.lastUid > 0xffffffff) return null;
  return { uidValidity: row.uidValidity, lastUid: row.lastUid };
}

function smtpResponseCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'responseCode' in error && typeof error.responseCode === 'number') return error.responseCode;
  return undefined;
}

export function createImapSmtpTransport(account: ImapSmtpAccount, tls?: ConnectionOptions, onSentCopyFailure?: () => void) {
  const tlsOptions = account.tlsCaPem ? { ...tls, ca: account.tlsCaPem } : tls;
  async function withImap<T>(work: (client: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const { ImapFlow: ImapClient } = await import('imapflow');
    signal?.throwIfAborted();
    const client = new ImapClient({ host: account.imapHost, port: account.imapPort,
      secure: true, auth: account.auth, tls: tlsOptions, logger: false, disableAutoIdle: true,
      socketTimeout: 0 }); // The containing poll's waitMs/signal owns IDLE lifetime.
    const abort = () => client.close();
    client.on('error', () => { /* Command promises and the IDLE waiter report network failures. */ });
    signal?.addEventListener('abort', abort, { once: true });
    try { await client.connect(); return await work(client); }
    catch (error) { signal?.throwIfAborted(); throw error; }
    finally { signal?.removeEventListener('abort', abort); client.close(); }
  }

  async function withSmtp<T>(work: (client: SMTPConnection) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const [{ default: SmtpClient }, { default: XOAuth2 }] = await Promise.all([
      import('nodemailer/lib/smtp-connection/index.js'),
      import('nodemailer/lib/xoauth2/index.js'),
    ]);
    signal?.throwIfAborted();
    const secure = account.smtpSecurity ? account.smtpSecurity === 'tls' : account.smtpPort === 465;
    const client = new SmtpClient({ host: account.smtpHost, port: account.smtpPort, secure,
      requireTLS: !secure, tls: tlsOptions, logger: false, debug: false });
    let rejectOperation: (error: unknown) => void = () => {};
    const abort = () => { rejectOperation(signal?.reason ?? new Error('Email operation cancelled')); client.close(); };
    const run = new Promise<T>((resolve, reject) => {
      rejectOperation = reject;
      client.on('error', reject);
      client.on('end', () => reject(new Error('SMTP connection ended before its receipt')));
      signal?.addEventListener('abort', abort, { once: true });
      client.connect((error) => {
        if (error) { reject(error); return; }
        const auth = 'pass' in account.auth ? { ...account.auth } : {
          // Nodemailer's public SMTP Connection API expects the XOAuth2 generator;
          // its declaration incorrectly describes that property as generator options.
          oauth2: new XOAuth2({ user: account.auth.user, accessToken: account.auth.accessToken,
            provisionCallback(_user, _renew, done) { done(new Error('Reconnect to refresh the application token'), '', 0); } }),
        } as unknown as SMTPConnection.AuthenticationOAuth2;
        client.login(auth, (loginError) => {
          if (loginError) reject(loginError);
          else if (signal?.aborted) reject(signal.reason);
          else work(client).then(resolve, reject);
        });
      });
    });
    try { return await run; } finally { signal?.removeEventListener('abort', abort); client.close(); }
  }

  async function sentFolder(client: ImapFlow): Promise<string> {
    if (account.sentFolder) return account.sentFolder;
    const folder = (await client.list()).find((entry) => entry.specialUse === '\\Sent');
    if (!folder) throw new Error('Configure the mailbox Sent folder');
    return folder.path;
  }

  async function messageUid(client: ImapFlow, folder: string, messageId: string): Promise<number | null> {
    await client.mailboxOpen(folder, { readOnly: true });
    const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (!uids) throw new Error('Sent lookup did not complete');
    // IMAP HEADER SEARCH is a substring match: verify the full RFC Message-ID.
    for (const uid of uids) {
      const message = await client.fetchOne(uid, { envelope: true }, { uid: true });
      if (message && message.envelope?.messageId === messageId) return uid;
    }
    return null;
  }

  async function fetchMessage(client: ImapFlow, uid: number) {
    const message = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
    if (!message || !message.source) throw new Error('IMAP message is no longer available');
    const receivedAtMs = message.internalDate instanceof Date ? message.internalDate.getTime()
      : typeof message.internalDate === 'string' ? new Date(message.internalDate).getTime() : NaN;
    if (!Number.isInteger(receivedAtMs) || receivedAtMs < 0) throw new Error('IMAP message receipt time is unavailable');
    return { mime: message.source, receivedAtMs };
  }

  async function waitForInbox(client: ImapFlow, waitMs: number, signal?: AbortSignal) {
    if (waitMs <= 0) return;
    let dispose = () => {};
    const changed = new Promise<void>((resolve, reject) => {
      const wake = () => resolve();
      const failed = (error: Error) => reject(error);
      const closed = () => reject(new Error('IMAP closed during IDLE'));
      const aborted = () => reject(signal?.reason ?? new Error('Email poll cancelled'));
      const timer = setTimeout(wake, waitMs);
      client.on('exists', wake); client.on('error', failed); client.on('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
      dispose = () => { clearTimeout(timer); client.off('exists', wake); client.off('error', failed); client.off('close', closed); signal?.removeEventListener('abort', aborted); };
    });
    const idle = client.idle();
    // Surface an IDLE refusal/close even when the server sends no EXISTS.
    void idle.catch(() => client.close());
    try { await changed; signal?.throwIfAborted(); await client.noop(); await idle; }
    finally { dispose(); }
  }

  return {
    async connectionTest(signal?: AbortSignal) {
      await withImap(async (client) => { await client.mailboxOpen(account.inboxFolder, { readOnly: true }); }, signal);
      await withSmtp(async () => {}, signal);
      return { kind: 'ready' as const, mailbox: account.mailbox };
    },
    async listSince(value: unknown, waitMs: number, limit: number, signal?: AbortSignal): Promise<EmailTransportListSinceResultV1> {
      const previous = value === null ? null : checkpoint(value);
      const historyGap = { kind: 'historyGap', reason: 'providerHistoryUnavailable' } as const;
      if (value !== null && !previous) return historyGap;
      const started = Date.now();
      return withImap(async (client) => {
        const box = await client.mailboxOpen(account.inboxFolder, { readOnly: true });
        const uidValidity = box.uidValidity.toString();
        if (previous && uidValidity !== previous.uidValidity) return historyGap;
        // UIDNEXT cannot move behind a saved UID within one UIDVALIDITY
        // (RFC 3501 §2.3.1.1). A restored/replaced server may violate that
        // contract; surface lost continuity rather than silently skipping mail.
        if (previous && box.uidNext <= previous.lastUid) return historyGap;
        if (previous === null) return { kind: 'batch', refs: [],
          checkpointAfterBatch: { uidValidity, lastUid: box.uidNext - 1 } };
        const lastUid = previous.lastUid;
        const readUids = async () => {
          if (lastUid === 0xffffffff) return [];
          const uids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
          if (!uids) throw new Error('Inbox lookup did not complete');
          // RFC sequence-set x:* includes the current maximum when x is larger.
          return uids.filter((uid) => uid > lastUid).sort((a, b) => a - b).slice(0, limit);
        };
        let uids = await readUids();
        if (!uids.length) { await waitForInbox(client, Math.max(0, waitMs - (Date.now() - started)), signal); uids = await readUids(); }
        return { kind: 'batch', refs: uids.map((uid) => JSON.stringify({ uidValidity, uid })),
          checkpointAfterBatch: { uidValidity, lastUid: uids.at(-1) ?? lastUid } };
      }, signal);
    },
    async fetchRaw(ref: string, signal?: AbortSignal): Promise<{ mime: Buffer; receivedAtMs: number }> {
      if (ref.startsWith('<') && ref.endsWith('>') && !/[\r\n\x00]/.test(ref)) {
        return withImap(async (client) => {
          let uid = await messageUid(client, account.inboxFolder, ref);
          if (uid === null) uid = await messageUid(client, await sentFolder(client), ref);
          if (uid === null) throw new Error('IMAP message is no longer available');
          return await fetchMessage(client, uid);
        }, signal);
      }
      const value: unknown = JSON.parse(ref);
      if (!value || typeof value !== 'object' || !('uid' in value) || !('uidValidity' in value)) throw new Error('Invalid IMAP message reference');
      const position = checkpoint({ uidValidity: value.uidValidity, lastUid: value.uid });
      if (!position || position.lastUid === 0) throw new Error('Invalid IMAP message reference');
      return withImap(async (client) => {
        const box = await client.mailboxOpen(account.inboxFolder, { readOnly: true });
        if (box.uidValidity.toString() !== position.uidValidity) throw new Error('IMAP message history is no longer available');
        return await fetchMessage(client, position.lastUid);
      }, signal);
    },
    async submitRaw(mime: Uint8Array, envelope: Readonly<{ from: string; to: readonly string[] }>, messageId: string, signal?: AbortSignal): Promise<ConversationDeliveryResultV1> {
      let submissionStarted = false;
      let acceptedResult: ConversationDeliveryResultV1 | undefined;
      try {
        const info = await withSmtp((client) => new Promise<SMTPConnection.SentMessageInfo>((resolve, reject) => {
          submissionStarted = true;
          client.send({ from: envelope.from, to: [...envelope.to] }, Buffer.from(mime), (error, result) => error ? reject(error) : resolve(result));
        }), signal);
        if (info.accepted.length === 0) return { kind: 'notDelivered', retry: 'never' };
        acceptedResult = info.rejected.length
          ? { kind: 'partial', providerMessageIds: [messageId], failedChunk: 0 }
          : { kind: 'delivered', providerMessageIds: [messageId] };
        // Observe the server's actual Sent copy for this delivery; no vendor-name rule.
        await withImap(async (client) => {
          const folder = await sentFolder(client);
          if (await messageUid(client, folder, messageId) === null) {
            const appended = await client.append(folder, Buffer.from(mime), ['\\Seen']);
            if (!appended) throw new Error('Sent append did not complete');
          }
        }, signal);
        return acceptedResult;
      } catch (error) {
        // SMTP acceptance remains authoritative when best-effort Sent work
        // fails or is cancelled. A failed copy never authorizes another send.
        if (acceptedResult !== undefined) {
          onSentCopyFailure?.();
          return acceptedResult;
        }
        signal?.throwIfAborted();
        const code = smtpResponseCode(error);
        if (code !== undefined && code >= 400 && code < 600) return { kind: 'notDelivered', retry: code < 500 ? 'safe' : 'never' };
        return submissionStarted ? { kind: 'outcomeUnknown' }
          : { kind: 'notDelivered', retry: 'safe' };
      }
    },
    async findSent(messageId: string, signal?: AbortSignal): Promise<boolean> {
      return withImap(async (client) => await messageUid(client, await sentFolder(client), messageId) !== null, signal);
    },
  };
}
