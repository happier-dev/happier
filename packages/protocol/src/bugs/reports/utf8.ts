function tryCreateTextEncoder(): TextEncoder | null {
  const TeCtor = (globalThis as any).TextEncoder;
  if (typeof TeCtor !== 'function') return null;
  try {
    return new TeCtor();
  } catch {
    return null;
  }
}

function measureUtf8BytesWithoutPlatformEncoder(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (codeUnit <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (
      isLeadSurrogate(codeUnit)
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}

export function utf8ByteLength(value: string): number {
  const normalized = String(value ?? '');
  const encoder = tryCreateTextEncoder();
  if (encoder) {
    return encoder.encode(normalized).byteLength;
  }

  const BufferCtor = (globalThis as any).Buffer;
  if (BufferCtor && typeof BufferCtor.byteLength === 'function') {
    try {
      return BufferCtor.byteLength(normalized, 'utf8');
    } catch {
      // ignore
    }
  }

  return measureUtf8BytesWithoutPlatformEncoder(normalized);
}

export function trimUtf8TextToMaxBytes(input: string, maxBytes: number): string {
  const max = Math.max(1024, Math.floor(maxBytes));
  const normalized = String(input ?? '');

  const encoder = tryCreateTextEncoder();
  const byteLength = encoder
    ? (value: string) => encoder.encode(value).byteLength
    : utf8ByteLength;
  if (byteLength(normalized) <= max) return normalized;

  // Keep the most recent content (tail) while maximizing usage of the byte budget.
  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = normalized.slice(mid);
    if (byteLength(candidate) > max) {
      low = mid + 1;
      continue;
    }
    high = mid;
  }

  const safeStart = low < normalized.length && isTrailSurrogate(normalized.charCodeAt(low))
    ? low + 1
    : low;
  return normalized.slice(safeStart);
}


function isLeadSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isTrailSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Bound text to `maxBytes` by keeping its leading characters.
 *
 * The sibling above keeps the tail, because a captured log artifact's newest
 * lines are the diagnostic ones. A thrown message is the other shape: its
 * opening names the failure, so a bounded cause has to keep the head instead.
 * Either way the bound is a byte bound and the cut has to land on a character
 * boundary — slicing the encoded buffer publishes a replacement character in
 * place of whatever multi-byte character straddled the boundary.
 */
export function trimUtf8TextHeadToMaxBytes(input: string, maxBytes: number): string {
  const max = Math.max(0, Math.floor(maxBytes));
  const normalized = String(input ?? '');
  if (max <= 0) return '';

  const encoder = tryCreateTextEncoder();
  const end = resolveLongestPrefixLengthWithinByteBudget(
    normalized,
    max,
    encoder
      ? (value) => encoder.encode(value).byteLength
      : utf8ByteLength,
  );

  // A prefix must never end on the lead half of a surrogate pair: that half is
  // not a character on its own and encodes to the same replacement sequence a
  // mid-codepoint byte cut produces.
  const safeEnd = end > 0 && isLeadSurrogate(normalized.charCodeAt(end - 1)) ? end - 1 : end;
  return safeEnd >= normalized.length ? normalized : normalized.slice(0, safeEnd);
}

function resolveLongestPrefixLengthWithinByteBudget(
  normalized: string,
  max: number,
  byteLength: (value: string) => number,
): number {
  if (byteLength(normalized) <= max) return normalized.length;

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(normalized.slice(0, mid)) > max) {
      high = mid - 1;
      continue;
    }
    low = mid;
  }
  return low;
}
