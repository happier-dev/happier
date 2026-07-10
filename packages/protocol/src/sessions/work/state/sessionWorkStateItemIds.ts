import type { SessionWorkStateItemKindV1 } from './sessionWorkStateV1.js';

function normalizeIdPart(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildVendorSessionWorkStateItemId(
  kind: SessionWorkStateItemKindV1,
  vendorRef: string,
): string {
  const normalized = normalizeIdPart(vendorRef);
  if (!normalized) {
    throw new Error('vendorRef is required');
  }
  return `${kind}:${normalized}`;
}

export function buildDeterministicSessionWorkStateItemId(params: Readonly<{
  kind: SessionWorkStateItemKindV1;
  sourceFamily: string;
  stableParts: readonly unknown[];
}>): string {
  const sourceFamily = normalizeIdPart(params.sourceFamily);
  const stableParts = params.stableParts.map(normalizeIdPart).filter((part): part is string => Boolean(part));
  if (!sourceFamily || stableParts.length === 0) {
    throw new Error('sourceFamily and stableParts are required');
  }
  return `${params.kind}:derived:${encodeIdPart(sourceFamily)}:${encodeIdPart(stableParts.join('|'))}`;
}
