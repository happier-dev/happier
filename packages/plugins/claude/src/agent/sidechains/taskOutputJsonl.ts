import { parseRawJsonLinesLine } from '../transcripts/parseRawJsonLines.js';
import type { RawJSONLines } from '../transcripts/rawJsonLines.js';

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
