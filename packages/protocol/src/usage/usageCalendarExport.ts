import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { encodeBase64 } from '../crypto/base64.js';
import { UsageQuerySchema } from '../inputs/usageQuery.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import type { ConnectedServiceQuotaGetResultV1 } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { UsageFileResultSchema, type UsageFileResult } from './usageExport.js';

export const UsageCalendarExportInputSchema = lazyZodSchema(() => z.object({
  query: UsageQuerySchema,
  selectedEvents: z.array(z.discriminatedUnion('kind', [
    z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), kind: z.literal('reset'), meterId: z.string().min(1) }).strict(),
    z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), kind: z.literal('renewal') }).strict(),
  ])).min(1),
}).strict());
export type UsageCalendarExportInput = z.infer<typeof UsageCalendarExportInputSchema>;
type CalendarAccount = UsageCalendarExportInput['selectedEvents'][number]['account'];
export type UsageScheduledEvent = Readonly<{ key: string; account: CalendarAccount; kind: 'reset' | 'renewal' | 'ending' | 'credit_expiry';
  atMs: number; observedAtMs: number; label?: string; meterId?: string }>;
const accountKey = (account: CalendarAccount) => JSON.stringify([account.service.pluginId, account.service.localId, account.accountId]);

/** Date facts have one owner shared by Plans and export; unknown renewal dates are never inferred. */
export function projectUsageScheduledEvents(reads: readonly ConnectedServiceQuotaGetResultV1[]): readonly UsageScheduledEvent[] {
  const events = new Map<string, UsageScheduledEvent>();
  for (const read of reads) {
    const snapshot = read.current;
    if (!snapshot) continue;
    const account = read.source.ref;
    const add = (kind: UsageScheduledEvent['kind'], atMs: number, observedAtMs: number, label?: string, meterId?: string) => {
      const identity = JSON.stringify([accountKey(account), snapshot.recordId, kind, meterId ?? null, atMs]);
      const key = encodeBase64(sha256(new TextEncoder().encode(identity))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      events.set(key, { key, account, kind, atMs, observedAtMs, ...(label ? { label } : {}), ...(meterId ? { meterId } : {}) });
    };
    for (const meter of snapshot.meters) {
      const atMs = meter.resetAtMs ?? meter.resetsAt;
      if (atMs != null) add('reset', atMs, snapshot.observedAtMs, meter.label, meter.meterId);
    }
    const subscription = snapshot.subscription;
    if (subscription?.status === 'subscribed' && subscription.currentPeriodEndAtMs != null && subscription.renewal !== 'unknown') {
      add(subscription.renewal === 'on' ? 'renewal' : 'ending', subscription.currentPeriodEndAtMs, subscription.observedAtMs);
    }
    const credits = snapshot.recoveryCredits;
    if (credits?.nextExpiresAtMs != null && credits.availableCount > 0) add('credit_expiry', credits.nextExpiresAtMs, snapshot.observedAtMs);
  }
  return [...events.values()].sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
}
const escapeText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const instant = (atMs: number) => new Date(atMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** RFC 5545's 75-octet content-line limit, without splitting a UTF-8 code point. */
function foldLine(line: string): string {
  let output = '', bytes = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 75) { output += '\r\n '; bytes = 1; }
    output += char; bytes += size;
  }
  return output;
}
export function buildUsageCalendarFileResult(input: UsageCalendarExportInput, reads: readonly ConnectedServiceQuotaGetResultV1[]): UsageFileResult | null {
  const request = UsageCalendarExportInputSchema.parse(input);
  const facts = projectUsageScheduledEvents(reads);
  const selected = new Map<string, UsageScheduledEvent>();
  for (const selection of request.selectedEvents) {
    const matches = facts.filter(fact => accountKey(fact.account) === accountKey(selection.account) && fact.kind === selection.kind &&
      (selection.kind !== 'reset' || fact.meterId === selection.meterId));
    if (matches.length !== 1) return null;
    selected.set(matches[0]!.key, matches[0]!);
  }
  const ordered = [...selected.values()].sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
  // RFC 5545 DATE-TIME uses a four-digit year, unlike JavaScript's extended ISO dates.
  if (ordered.some(fact => [fact.atMs, fact.observedAtMs].some(atMs => {
    const date = new Date(atMs);
    return !Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999;
  }))) return null;
  // Newlines are escaped above; other controls have no RFC 5545 TEXT representation.
  if (ordered.some(fact => fact.label && /[\u0000-\u0008\u000A-\u001F\u007F]/.test(escapeText(fact.label)))) return null;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Happier//Usage//EN', 'CALSCALE:GREGORIAN'];
  for (const fact of ordered) lines.push('BEGIN:VEVENT', `UID:${fact.key}@happier`, `DTSTAMP:${instant(fact.observedAtMs)}`,
    `DTSTART:${instant(fact.atMs)}`, `SUMMARY:${escapeText(fact.kind === 'reset' ? `Usage reset${fact.label ? `: ${fact.label}` : ''}` : 'Subscription renewal')}`, 'END:VEVENT');
  lines.push('END:VCALENDAR');
  return UsageFileResultSchema.parse({ v: 1, mediaType: 'text/calendar', fileName: 'usage-calendar.ics',
    base64: encodeBase64(new TextEncoder().encode(`${lines.map(foldLine).join('\r\n')}\r\n`)),
    fields: [...new Set(ordered.map(fact => fact.kind === 'reset' ? 'resets' : 'renewals'))], asOfMs: Math.min(...ordered.map(fact => fact.observedAtMs)) });
}
