import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';

function jsonStringCodePointBytes(codePoint: number, codeUnit: number): number {
  if (codeUnit === 0x22 || codeUnit === 0x5c) return 2;
  if (codeUnit <= 0x1f) {
    return codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a
      || codeUnit === 0x0c || codeUnit === 0x0d ? 2 : 6;
  }
  if (codeUnit >= 0xd800 && codeUnit <= 0xdfff && codePoint === codeUnit) return 6;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function fittingJsonStringPrefixLength(text: string, availableBytes: number): number {
  let usedBytes = 0;
  let end = 0;
  while (end < text.length) {
    const codePoint = text.codePointAt(end) ?? 0;
    const contribution = jsonStringCodePointBytes(codePoint, text.charCodeAt(end));
    if (usedBytes + contribution > availableBytes) break;
    usedBytes += contribution;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end;
}

export function fitActionResultTextV1<TResult>(
  text: string,
  project: (text: string, truncated: boolean) => TResult,
): TResult {
  const complete = project(text, false);
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(complete)) return complete;
  const empty = project('', true);
  const emptyBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(empty);
  if (emptyBytes > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
    throw new RangeError('action_result_base_exceeds_serialized_boundary');
  }

  let end = fittingJsonStringPrefixLength(text, EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - emptyBytes);
  if (end === text.length && end > 0) {
    const last = text.charCodeAt(end - 1);
    end -= last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
  }
  const fitted = project(text.slice(0, end), true);
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(fitted)) return fitted;

  let low = 0;
  let high = end;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(project(text.slice(0, candidate), true))) low = candidate;
    else high = candidate - 1;
  }
  return project(text.slice(0, low), true);
}
