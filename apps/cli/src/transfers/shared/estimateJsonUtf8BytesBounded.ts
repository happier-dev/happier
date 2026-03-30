function estimateJsonStringUtf8BytesBounded(value: string, maxBytes: number): number {
  // Quotes.
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 /* " */ || codeUnit === 0x5c /* \\ */) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      // JSON escapes control chars as \u00XX.
      bytes += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      // Surrogates are uncommon in our payloads; fail closed by assuming an escaped form.
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) {
      return maxBytes + 1;
    }
  }
  return bytes;
}

export function estimateJsonUtf8BytesBounded(value: unknown, maxBytes: number): number {
  const seenObjects = new Set<object>();

  const estimateValue = (input: unknown): number => {
    if (input === null) return 4;
    if (typeof input === 'string') return estimateJsonStringUtf8BytesBounded(input, maxBytes);
    if (typeof input === 'boolean') return input ? 4 : 5;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return 4; // null
      return Buffer.byteLength(String(input), 'utf8');
    }
    if (typeof input === 'undefined' || typeof input === 'function' || typeof input === 'symbol') {
      // JSON.stringify omits these in objects and turns them into null in arrays. We overestimate
      // by treating them as null so we fail closed for large request bodies.
      return 4;
    }
    if (typeof input === 'bigint') {
      return maxBytes + 1;
    }

    if (Array.isArray(input)) {
      let bytes = 2; // []
      for (let index = 0; index < input.length; index += 1) {
        if (index > 0) bytes += 1; // comma
        bytes += estimateValue(input[index]);
        if (bytes > maxBytes) return maxBytes + 1;
      }
      return bytes;
    }

    if (typeof input === 'object') {
      const obj = input as object;
      if (seenObjects.has(obj)) {
        return maxBytes + 1;
      }
      seenObjects.add(obj);
      try {
        let bytes = 2; // {}
        let wroteAny = false;
        // Avoid `Object.keys(...)` which can allocate a large array for oversized inputs.
        for (const key in obj as Record<string, unknown>) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
          if (wroteAny) bytes += 1; // comma
          wroteAny = true;
          bytes += estimateJsonStringUtf8BytesBounded(key, maxBytes);
          bytes += 1; // colon
          bytes += estimateValue((obj as Record<string, unknown>)[key]);
          if (bytes > maxBytes) return maxBytes + 1;
        }
        return bytes;
      } finally {
        seenObjects.delete(obj);
      }
    }

    return maxBytes + 1;
  };

  return estimateValue(value);
}
