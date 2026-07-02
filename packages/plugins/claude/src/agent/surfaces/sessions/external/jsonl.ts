import { open, stat } from 'node:fs/promises';

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_OVERSIZE_LINE_BYTES = 8 * 1024 * 1024;

export type ClaudeJsonlParsedLine = Readonly<{
    value: unknown;
    startOffsetBytes: number;
    endOffsetBytes: number;
}>;

export async function readClaudeJsonlFileSize(filePath: string): Promise<number> {
    try {
        const file = await stat(filePath);
        return file.isFile() ? file.size : 0;
    } catch {
        return 0;
    }
}

function tryParseJsonlLine(lineBytes: Buffer): unknown | null {
    const text = lineBytes.toString('utf8').trim();
    if (!text) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

export async function readClaudeJsonlFileForward(params: Readonly<{
    filePath: string;
    offsetBytes: number;
    maxBytes: number;
    maxItems: number;
    chunkBytes?: number;
    maxOversizeLineBytes?: number;
}>): Promise<Readonly<{
    items: readonly ClaudeJsonlParsedLine[];
    nextOffsetBytes: number;
    truncated: boolean;
    reachedEnd: boolean;
}>> {
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const chunkBytes = Math.max(1024, Math.trunc(params.chunkBytes ?? DEFAULT_CHUNK_BYTES));
    const maxOversizeLineBytes = Math.max(
        maxBytes,
        Math.trunc(params.maxOversizeLineBytes ?? DEFAULT_MAX_OVERSIZE_LINE_BYTES),
    );
    const fileSize = await readClaudeJsonlFileSize(params.filePath);
    const offsetBytes = Math.max(0, Math.trunc(params.offsetBytes));
    if (offsetBytes > fileSize) {
        return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true };
    }

    const file = await open(params.filePath, 'r');
    const items: ClaudeJsonlParsedLine[] = [];
    let bytesReadTotal = 0;
    let carry = Buffer.alloc(0);
    let carryStartOffset = offsetBytes;
    let nextReadOffset = offsetBytes;

    try {
        while (nextReadOffset < fileSize && items.length < maxItems) {
            const remainingBytes = maxBytes - bytesReadTotal;
            const canContinueOversizeFirstLine =
                remainingBytes <= 0
                && items.length === 0
                && carry.length > 0
                && carry.length < maxOversizeLineBytes;
            if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

            const readBudget = canContinueOversizeFirstLine
                ? maxOversizeLineBytes - carry.length
                : remainingBytes;
            const readSize = Math.min(chunkBytes, fileSize - nextReadOffset, readBudget);
            if (readSize <= 0) break;

            const buffer = Buffer.allocUnsafe(readSize);
            const result = await file.read(buffer, 0, readSize, nextReadOffset);
            const chunk = result.bytesRead > 0 ? buffer.subarray(0, result.bytesRead) : Buffer.alloc(0);
            bytesReadTotal += chunk.length;
            nextReadOffset += chunk.length;

            const combinedStartOffset = carryStartOffset;
            const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
            let lineStartIndex = 0;
            for (let index = 0; index < combined.length && items.length < maxItems; index += 1) {
                if (combined[index] !== 0x0a) continue;
                const line = combined.slice(lineStartIndex, index);
                const parsed = tryParseJsonlLine(line);
                if (parsed !== null) {
                    items.push({
                        value: parsed,
                        startOffsetBytes: combinedStartOffset + lineStartIndex,
                        endOffsetBytes: combinedStartOffset + index,
                    });
                }
                lineStartIndex = index + 1;
            }

            carry = combined.slice(lineStartIndex);
            carryStartOffset = combinedStartOffset + lineStartIndex;
        }

        if (items.length < maxItems && nextReadOffset >= fileSize && carry.length > 0) {
            const parsed = tryParseJsonlLine(carry);
            if (parsed !== null) {
                items.push({
                    value: parsed,
                    startOffsetBytes: carryStartOffset,
                    endOffsetBytes: carryStartOffset + carry.length,
                });
                carry = Buffer.alloc(0);
                carryStartOffset = fileSize;
            }
        }
    } finally {
        await file.close();
    }

    const reachedEnd = carry.length === 0 && nextReadOffset >= fileSize;
    return { items, nextOffsetBytes: carryStartOffset, truncated: false, reachedEnd };
}

export async function readClaudeJsonlFileBackwardPage(params: Readonly<{
    filePath: string;
    endOffsetBytes: number | null;
    maxBytes: number;
    maxItems: number;
    chunkBytes?: number;
    maxOversizeLineBytes?: number;
}>): Promise<Readonly<{
    items: readonly ClaudeJsonlParsedLine[];
    nextEndOffsetBytes: number;
    reachedStart: boolean;
}>> {
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const chunkBytes = Math.max(1024, Math.trunc(params.chunkBytes ?? DEFAULT_CHUNK_BYTES));
    const maxOversizeLineBytes = Math.max(
        maxBytes,
        Math.trunc(params.maxOversizeLineBytes ?? DEFAULT_MAX_OVERSIZE_LINE_BYTES),
    );
    const fileSize = await readClaudeJsonlFileSize(params.filePath);
    const initialEnd =
        typeof params.endOffsetBytes === 'number' && Number.isFinite(params.endOffsetBytes)
            ? Math.min(fileSize, Math.max(0, Math.trunc(params.endOffsetBytes)))
            : fileSize;
    if (initialEnd <= 0) {
        return { items: [], nextEndOffsetBytes: 0, reachedStart: true };
    }

    const collectedNewestFirst: ClaudeJsonlParsedLine[] = [];
    let bytesReadTotal = 0;
    let end = initialEnd;
    let carry = Buffer.alloc(0);
    const file = await open(params.filePath, 'r');

    try {
        while (end > 0 && collectedNewestFirst.length < maxItems) {
            const remainingBytes = maxBytes - bytesReadTotal;
            const canContinueOversizeFirstLine =
                remainingBytes <= 0
                && collectedNewestFirst.length === 0
                && carry.length > 0
                && carry.length < maxOversizeLineBytes;
            if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

            const readBudget = canContinueOversizeFirstLine
                ? maxOversizeLineBytes - carry.length
                : remainingBytes;
            const readSize = Math.min(chunkBytes, end, readBudget);
            if (readSize <= 0) break;

            const start = end - readSize;
            const buffer = Buffer.allocUnsafe(readSize);
            const result = await file.read(buffer, 0, readSize, start);
            const chunk = result.bytesRead > 0 ? buffer.subarray(0, result.bytesRead) : Buffer.alloc(0);
            bytesReadTotal += chunk.length;

            const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
            const combinedStartOffset = start;
            const carryStartOffset = end;
            let segmentEndIndex = combined.length;
            for (let index = combined.length - 1; index >= 0 && collectedNewestFirst.length < maxItems; index -= 1) {
                if (combined[index] !== 0x0a) continue;
                const segmentStartIndex = index + 1;
                const segment = combined.slice(segmentStartIndex, segmentEndIndex);
                const parsed = tryParseJsonlLine(segment);
                if (parsed !== null) {
                    const startOffsetAbs =
                        segmentStartIndex < chunk.length
                            ? combinedStartOffset + segmentStartIndex
                            : carryStartOffset + (segmentStartIndex - chunk.length);
                    const endOffsetAbs =
                        segmentEndIndex < chunk.length
                            ? combinedStartOffset + segmentEndIndex
                            : carryStartOffset + (segmentEndIndex - chunk.length);
                    collectedNewestFirst.push({ value: parsed, startOffsetBytes: startOffsetAbs, endOffsetBytes: endOffsetAbs });
                }
                segmentEndIndex = index;
            }

            carry = combined.slice(0, segmentEndIndex);
            end = start;
            if (end === 0 && carry.length > 0 && collectedNewestFirst.length < maxItems) {
                const parsed = tryParseJsonlLine(carry);
                if (parsed !== null) {
                    collectedNewestFirst.push({ value: parsed, startOffsetBytes: 0, endOffsetBytes: carry.length });
                    carry = Buffer.alloc(0);
                }
            }
        }
    } finally {
        await file.close();
    }

    const items = collectedNewestFirst.reverse();
    const firstItem = items[0];
    const nextEndOffsetBytes = firstItem ? firstItem.startOffsetBytes : initialEnd;
    return { items, nextEndOffsetBytes, reachedStart: nextEndOffsetBytes <= 0 };
}
