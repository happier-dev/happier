import type { RawJSONLines } from '@/backends/claude/types';
import { parseRawJsonLinesLine } from '@/backends/claude/utils/parseRawJsonLines';

export function parseTaskOutputJsonlText(text: string): RawJSONLines[] {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  const out: RawJSONLines[] = [];

  for (const line of lines) {
    const record = parseRawJsonLinesLine(line);
    if (record) out.push(record);
  }

  return out;
}
