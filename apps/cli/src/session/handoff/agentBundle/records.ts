import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { SessionHandoffAgentBundle } from '../types';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

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

function readFileSlice(value: unknown): Readonly<{
  filePath: string;
  offsetBytes: number;
  sizeBytes: number;
}> | null {
  const record = asRecord(value);
  if (
    record?.t !== 'happier.handoff.file.v1'
    || typeof record.filePath !== 'string'
    || !Number.isSafeInteger(record.offsetBytes)
    || Number(record.offsetBytes) < 0
    || !Number.isSafeInteger(record.sizeBytes)
    || Number(record.sizeBytes) < 0
  ) return null;
  return {
    filePath: record.filePath,
    offsetBytes: Number(record.offsetBytes),
    sizeBytes: Number(record.sizeBytes),
  };
}

async function readJsonLinesFromFile(value: unknown): Promise<readonly unknown[]> {
  const file = readFileSlice(value);
  if (!file || file.sizeBytes === 0) return [];
  const lines = createInterface({
    input: createReadStream(file.filePath, {
      start: file.offsetBytes,
      end: file.offsetBytes + file.sizeBytes - 1,
    }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const records: unknown[] = [];
  for await (const line of lines) {
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

async function readGenericJsonLinesAgentBundleRecords(
  agentBundle: Readonly<Record<string, unknown>>,
): Promise<readonly unknown[]> {
  const records = [
    ...readJsonLinesFromBase64(agentBundle.transcriptBase64),
    ...await readJsonLinesFromFile(agentBundle.transcriptFile),
  ];

  const files = Array.isArray(agentBundle.files) ? agentBundle.files : [];
  for (const file of files) {
    const fileRecord = asRecord(file);
    if (!fileRecord) continue;
    records.push(...readJsonLinesFromBase64(fileRecord.contentBase64));
    records.push(...await readJsonLinesFromFile(fileRecord.contentFile));
  }

  return records;
}

export async function readSessionHandoffAgentBundleRecords(
  agentBundle: SessionHandoffAgentBundle,
): Promise<readonly unknown[]> {
  const currentRuntime = await getSessionHostBridge()
    .resolveCurrentExecutionSurfacesForCatalogAgent(agentBundle.agentId);
  const extractMediaScannableRecords = currentRuntime
    ?.executionSurfaces.handoff
    ?.extractMediaScannableRecords;
  return extractMediaScannableRecords
    ? await extractMediaScannableRecords({ bundle: agentBundle })
    : await readGenericJsonLinesAgentBundleRecords(agentBundle);
}
