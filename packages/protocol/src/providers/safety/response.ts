import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from './limits.js';

export type ProviderProbeResponseEncoding = 'identity' | 'gzip' | 'deflate' | 'br';
export type ProviderProbeResponseContentKind = 'json' | 'strict-json-compat';

export type ProviderProbeResponseMetadata = Readonly<{
  compatibilityDiagnostic: boolean;
  contentKind: ProviderProbeResponseContentKind;
  encoding: ProviderProbeResponseEncoding;
}>;

const SUPPORTED_ENCODINGS = new Set<ProviderProbeResponseEncoding>([
  'identity',
  'gzip',
  'deflate',
  'br',
]);

export function validateProviderProbeResponseMetadata(params: Readonly<{
  contentType: string | undefined;
  contentEncoding: string | undefined;
}>): ProviderProbeResponseMetadata {
  const encoding = (params.contentEncoding ?? '').trim().toLowerCase() || 'identity';
  if (!SUPPORTED_ENCODINGS.has(encoding as ProviderProbeResponseEncoding)) {
    throw new Error('Provider probe response uses an unsupported content encoding.');
  }

  const mimeType = (params.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const isJson = mimeType === 'application/json' || mimeType.endsWith('+json');
  const isStrictJsonCompat = mimeType === '' || mimeType === 'text/plain';
  if (!isJson && !isStrictJsonCompat) {
    throw new Error('Provider probe response must be JSON, JSON-compatible text, or an absent content type.');
  }
  return {
    compatibilityDiagnostic: isStrictJsonCompat,
    contentKind: isStrictJsonCompat ? 'strict-json-compat' : 'json',
    encoding: encoding as ProviderProbeResponseEncoding,
  };
}

export function assertProviderDecodedBodyWithinLimit(decodedBodyBytes: number): void {
  if (
    !Number.isSafeInteger(decodedBodyBytes)
    || decodedBodyBytes < 0
    || decodedBodyBytes > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes
  ) {
    throw new Error('Provider probe decoded response exceeds the byte limit.');
  }
}
