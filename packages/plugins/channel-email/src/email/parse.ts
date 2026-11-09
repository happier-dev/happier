import type { HeaderValue } from 'mailparser';
import { createConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';

export interface EmailContentOptions {
  quotedHistory?: 'stripKnown' | 'always' | 'never';
  stripSignatures?: boolean;
  bodyFormat?: 'markdown' | 'text';
  knownThread?: boolean | ((identity: EmailThreadIdentity) => boolean);
}

export interface ParsedEmail {
  headers: ReadonlyMap<string, readonly string[]>;
  messageId: string | null;
  references: string[];
  inReplyTo: string | null;
  from: string | null;
  sender: string | null;
  subject: string;
  text: string;
  forwarded: boolean;
  attachments: { attachmentId: string; name: string; mediaType: string; bytes: Uint8Array }[];
  authoredAtMs: number | null;
}

export type EmailThreadIdentity = Pick<ParsedEmail, 'references' | 'inReplyTo' | 'messageId'>;

export function emailThreadKey(identity: EmailThreadIdentity): string | null {
  return identity.references[0] ?? identity.inReplyTo ?? identity.messageId;
}

function singleAddress(value: HeaderValue | undefined) {
  if (!value || typeof value !== 'object' || !('value' in value) || !Array.isArray(value.value) || value.value.length !== 1) return null;
  return value.value[0]?.address ?? null;
}

export async function parseEmail(raw: Uint8Array, options: EmailContentOptions = {}): Promise<ParsedEmail> {
  return (await prepareEmailForShaping(raw)).shape(options);
}

function parserContentRejection(error: unknown): ParsedEmail {
  // Mailparser's MIME splitter explicitly tags content-limit rejections.
  // Unknown exceptions are runtime failures, never invalid sender evidence.
  if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EMAXLEN') throw error;
  return { headers: new Map(), messageId: null, references: [], inReplyTo: null, from: null, sender: null,
    subject: '', text: '', forwarded: false, attachments: [], authoredAtMs: null };
}

/** Decode once; the poll owner can resolve a batch's frozen context before shaping. */
export async function prepareEmailForShaping(raw: Uint8Array): Promise<Readonly<{
  identity: EmailThreadIdentity;
  shape(options: EmailContentOptions): Promise<ParsedEmail>;
}>> {
  try {
    const parsed = await readEmailParts(raw);
    return { identity: parsed.identity, async shape(options) {
      try { return await shapeEmailParts(parsed, options, []); }
      catch (error) { return parserContentRejection(error); }
    } };
  } catch (error) {
    const rejected = parserContentRejection(error);
    return { identity: rejected, shape: async () => rejected };
  }
}

async function parseEmailParts(raw: Uint8Array, options: EmailContentOptions, parentParts: readonly string[], inlinePartPrefix = ''): Promise<ParsedEmail> {
  return shapeEmailParts(await readEmailParts(raw), options, parentParts, inlinePartPrefix);
}

async function readEmailParts(raw: Uint8Array) {
  const [mailparser, { shapeEmailBody }] = await Promise.all([
    import('mailparser'),
    import('./shape.js'),
  ]);
  const { simpleParser } = { ...mailparser.default, ...mailparser };
  // Mailparser forwards ignoreEmbedded to its MIME splitter. Keep original
  // message bytes here; this owner already shapes forwarded content recursively.
  const parserOptions = { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true, ignoreEmbedded: true };
  const mail = await simpleParser(Buffer.from(raw), parserOptions);
  const headers = new Map<string, string[]>();
  for (const { key, line } of mail.headerLines) {
    const values = headers.get(key) ?? [];
    values.push(line.slice(line.indexOf(':') + 1).replace(/\r?\n[\t ]+/g, ' ').trim());
    headers.set(key, values);
  }
  const identity: EmailThreadIdentity = {
    messageId: mail.messageId ?? null,
    references: typeof mail.references === 'string' ? [mail.references] : mail.references ?? [],
    inReplyTo: mail.inReplyTo ?? null,
  };
  return { mail, headers, identity, shapeEmailBody };
}

async function shapeEmailParts(parsed: Awaited<ReturnType<typeof readEmailParts>>, options: EmailContentOptions,
  parentParts: readonly string[], inlinePartPrefix = ''): Promise<ParsedEmail> {
  const { mail, headers, identity, shapeEmailBody } = parsed;
  const contentOptions = {
    ...options,
    knownThread: typeof options.knownThread === 'function' ? options.knownThread(identity) : options.knownThread,
  };
  const shaped = shapeEmailBody({ html: typeof mail.html === 'string' ? mail.html : null, text: mail.text ?? '', subject: mail.subject ?? '' }, contentOptions);
  const attachments: ParsedEmail['attachments'] = [];
  let text = shaped.text;
  let forwarded = shaped.forwarded;
  for (const [index, attachment] of mail.attachments.entries()) {
    if (attachment.contentType.startsWith('image/') && attachment.contentDisposition !== 'attachment' &&
      attachment.cid && shaped.signatureOnlyCids.has(attachment.cid)) continue;
    const partId = `${inlinePartPrefix}${attachment.partId ?? index + 1}`;
    const parts = [...parentParts, `mime:${partId}`];
    const attachmentId = createConversationAttachmentIdV1('email', parts);
    const isMessage = attachment.contentType === 'message/rfc822';
    const encoding = attachment.headers.get('content-transfer-encoding');
    // These inline messages were formerly expanded by Mailparser. Preserve
    // their descendants' native dotted part IDs rather than renaming files.
    const wasInlineMessage = isMessage && attachment.contentDisposition === 'inline' &&
      (encoding === undefined || (typeof encoding === 'string' && ['', '7bit', '8bit', 'binary'].includes(encoding.trim().toLowerCase())));
    const name = attachment.filename ?? (isMessage ? `attachment-${index + 1}.eml`
      : attachment.contentType === 'text/calendar' ? 'invite.ics' : `attachment-${index + 1}`);
    const bytes = new Uint8Array(attachment.content);
    if (!wasInlineMessage || attachment.filename) attachments.push({ attachmentId, name, mediaType: attachment.contentType, bytes });
    if (isMessage || /\.eml$/i.test(name)) {
      const nested = await parseEmailParts(bytes, { ...options, quotedHistory: 'never', stripSignatures: false, knownThread: false },
        wasInlineMessage ? parentParts : parts, wasInlineMessage ? `${partId}.` : '');
      forwarded = true;
      text = [text, `--- Forwarded email (untrusted): ${name} ---\nFrom: ${nested.from ?? 'unknown'}\nSubject: ${nested.subject}\n\n${nested.text}\n--- End forwarded email ---`].filter(Boolean).join('\n\n');
      attachments.push(...nested.attachments);
    }
  }
  return {
    headers,
    ...identity,
    from: headers.get('from')?.length === 1 ? singleAddress(mail.from) : null,
    sender: headers.get('sender')?.length === 1 ? singleAddress(mail.headers.get('sender')) : null,
    subject: mail.subject ?? '',
    text,
    forwarded,
    attachments,
    authoredAtMs: mail.date && Number.isFinite(mail.date.getTime()) ? mail.date.getTime() : null,
  };
}
