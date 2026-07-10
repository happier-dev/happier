import type { SessionHandoffAgentBundle } from '../types';

import { getSessionHandoffAgentBundleRecordExtractor } from './catalogHooks';

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseJsonLines(text: string): readonly unknown[] {
  const records: unknown[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Provider transcript bundles can include diagnostics or partial lines.
    }
  }
  return records;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readJsonLinesFromBase64(value: unknown): readonly unknown[] {
  const encoded = readString(value);
  return encoded ? parseJsonLines(decodeBase64Utf8(encoded)) : [];
}

function readGenericJsonLinesAgentBundleRecords(
  agentBundle: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  const records = [
    ...readJsonLinesFromBase64(agentBundle.transcriptBase64),
  ];

  const files = Array.isArray(agentBundle.files) ? agentBundle.files : [];
  for (const file of files) {
    const fileRecord = asRecord(file);
    if (!fileRecord) continue;
    records.push(...readJsonLinesFromBase64(fileRecord.contentBase64));
  }

  return records;
}

export async function readSessionHandoffAgentBundleRecords(
  agentBundle: SessionHandoffAgentBundle,
): Promise<readonly unknown[]> {
  const providerExtractor = await getSessionHandoffAgentBundleRecordExtractor(agentBundle.agentId);
  return providerExtractor
    ? providerExtractor(agentBundle)
    : readGenericJsonLinesAgentBundleRecords(agentBundle);
}
