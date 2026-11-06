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
  budget?: Readonly<{ maxSerializedBytes: number; measureSerializedBytes(result: TResult): number }>,
): TResult {
  const maximum = budget?.maxSerializedBytes ?? EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES;
  const measure = budget?.measureSerializedBytes ?? measureExternalActionResultResponseEnvelopeUtf8BytesV1;
  const fits = budget === undefined ? isExternalActionResultWithinResponseEnvelopeLimitV1 : (value: TResult) => measure(value) <= maximum;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError('invalid_serialized_boundary');
  const complete = project(text, false);
  if (fits(complete)) return complete;
  const empty = project('', true);
  const emptyBytes = measure(empty);
  if (emptyBytes > maximum) {
    throw new RangeError('action_result_base_exceeds_serialized_boundary');
  }

  let end = fittingJsonStringPrefixLength(text, maximum - emptyBytes);
  if (end === text.length && end > 0) {
    const last = text.charCodeAt(end - 1);
    end -= last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
  }
  const fitted = project(text.slice(0, end), true);
  if (fits(fitted)) return fitted;

  let low = 0;
  let high = end;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const wholePoint = candidate > 0 && candidate < text.length
      && text.charCodeAt(candidate - 1) >= 0xd800 && text.charCodeAt(candidate - 1) <= 0xdbff
      && text.charCodeAt(candidate) >= 0xdc00 && text.charCodeAt(candidate) <= 0xdfff ? candidate - 1 : candidate;
    if (fits(project(text.slice(0, wholePoint), true))) low = candidate;
    else high = candidate - 1;
  }
  const wholePoint = low > 0 && low < text.length && text.charCodeAt(low - 1) >= 0xd800 && text.charCodeAt(low - 1) <= 0xdbff
    && text.charCodeAt(low) >= 0xdc00 && text.charCodeAt(low) <= 0xdfff ? low - 1 : low;
  return project(text.slice(0, wholePoint), true);
}
