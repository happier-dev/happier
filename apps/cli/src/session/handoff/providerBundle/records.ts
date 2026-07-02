import type { SessionHandoffProviderBundle } from '../types';

import { getSessionHandoffProviderBundleRecordExtractor } from '@/backends/catalog';

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

function readBuiltInProviderBundleRecords(
  providerBundle: SessionHandoffProviderBundle,
): readonly unknown[] {
  switch (providerBundle.providerId) {
    case 'claude':
      return parseJsonLines(decodeBase64Utf8(providerBundle.transcriptBase64));
    case 'codex':
      return providerBundle.files.flatMap((file) => parseJsonLines(decodeBase64Utf8(file.contentBase64)));
    default:
      return [];
  }
}

export async function readSessionHandoffProviderBundleRecords(
  providerBundle: SessionHandoffProviderBundle,
): Promise<readonly unknown[]> {
  const providerExtractor = await getSessionHandoffProviderBundleRecordExtractor(providerBundle.providerId);
  return providerExtractor
    ? providerExtractor(providerBundle)
    : readBuiltInProviderBundleRecords(providerBundle);
}
