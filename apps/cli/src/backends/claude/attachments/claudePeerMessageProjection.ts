import { formatClaudePeerMessageText, readClaudePeerMessage } from '@happier-dev/protocol';

import { RawJSONLinesSchema, type RawJSONLines } from '../types';
import { parseClaudeQueuedCommandAttachment } from './claudeAttachmentTypes';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readTagAttribute(attributes: string, name: string): string | null {
  const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(attributes);
  return nonBlank(value?.[2]);
}

function readCrossSessionMessage(text: string) {
  const match = /^\s*<cross-session-message\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/cross-session-message>\s*$/i.exec(text);
  if (!match) return null;
  const from = readTagAttribute(match[1], 'from');
  return from ? { from, name: readTagAttribute(match[1], 'from-name'), text: match[2] } : null;
}

// Claude 2.1.296+ wraps teammate and subagent deliveries in <agent-message>, preceded by a
// delivery sentence and followed by harness guidance on user rows. Only native peer origin
// may admit this unanchored wrapper; copied text without that provenance stays ordinary input.
function readAgentMessage(text: string) {
  const match = /<agent-message\b((?:"[^"]*"|'[^']*'|[^'">])*)>\n?([\s\S]*?)\n?<\/agent-message>/i.exec(text);
  if (!match) return null;
  const from = readTagAttribute(match[1], 'from');
  return from ? { from, name: null, text: match[2] } : null;
}

const HANDBACK_FRAME = /^\[Subagent hand-back\][^\n]*\n/;

/** Hand-backs prefix a provenance frame and indent every report line; 2.1.304 also sends the bare report. */
function readHandbackReport(origin: Record<string, unknown>, body: string): string {
  const reportText = nonBlank(origin.handbackReportText);
  if (reportText) return reportText;
  const frame = HANDBACK_FRAME.exec(body);
  if (!frame) return body;
  return body.slice(frame[0].length).split('\n')
    .map(line => line.startsWith('  ') ? line.slice(2) : line.trimEnd()).join('\n').trim();
}

/** Native delivery attachments and SDK peer input share the same conversation projection. */
export function projectClaudePeerMessage(value: unknown): RawJSONLines | null {
  const row = record(value);
  if (!row) return null;
  const attachment = record(row.attachment);
  const nativeOrigin = record(row.origin) ?? record(attachment?.origin);
  const nativePeer = nativeOrigin?.kind === 'peer' ? nativeOrigin : null;
  const command = parseClaudeQueuedCommandAttachment(value);
  if (command && nativeOrigin && !nativePeer) return null;
  const message = record(row.message);
  const content = message?.content;
  const peerInput = row.type === 'user' && nativePeer !== null;
  const peerTextBlocks = peerInput && Array.isArray(content) && content.length > 0
    && content.every(block => record(block)?.type === 'text' && typeof record(block)?.text === 'string')
    ? content.map(block => record(block)?.text).join('\n') : null;
  const prompt = command?.prompt ?? (peerInput && typeof content === 'string' ? content : peerTextBlocks);
  if (prompt === null) return null;
  const wrapped = readCrossSessionMessage(prompt) ?? (nativePeer ? readAgentMessage(prompt) : null);
  // Native peer origin carries the delivered body without its wrapper or harness guidance.
  // Projected rows drop it, so parsing replayed output does not add the sender twice.
  const nativeBody = nonBlank(nativePeer?.body);
  // A queued attachment proves delivery only for a native wrapper. Queue operations,
  // ordinary human prompts and unknown attachment kinds remain internal.
  const plainPeer = peerInput ? readClaudePeerMessage(row) : null;
  if (!wrapped && !nativeBody && peerTextBlocks === null && !plainPeer) return null;
  const from = nonBlank(nativePeer?.from) ?? wrapped?.from;
  if (!from) return null;
  const name = nonBlank(nativePeer?.name) ?? wrapped?.name ?? null;
  const delivered = nativeBody ?? wrapped?.text ?? peerTextBlocks ?? plainPeer?.text ?? null;
  if (delivered === null) return null;
  const body = nativePeer?.handback === true ? readHandbackReport(nativePeer, delivered) : delivered;
  const { attachment: _attachment, rendered: _rendered, isMeta: _isMeta,
    isCompactSummary: _compact, isVisibleInTranscriptOnly: _transcriptOnly, ...base } = row;
  const { body: _body, handbackReportText: _reportText, ...origin } = nativePeer ?? {};
  const projected = RawJSONLinesSchema.safeParse({
    ...base,
    type: 'user',
    origin: { ...origin, kind: 'peer', from, ...(name ? { name } : {}) },
    // The label keeps released clients readable; current clients read it back through the protocol owner.
    message: { ...message, role: 'user', content: formatClaudePeerMessageText(name, body) },
  });
  return projected.success ? projected.data : null;
}
