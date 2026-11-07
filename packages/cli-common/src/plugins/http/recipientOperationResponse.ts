import type { RecipientOperationV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import { containsProviderRegisteredSensitiveValue } from '@happier-dev/protocol/providers/sensitive-value-redaction';

type ResponseContract = RecipientOperationV1['response'];

/** A zero-byte response declares no representation, so it needs no media type. */
export function acceptsRecipientOperationResponseContentType(
  contract: ResponseContract,
  contentType: string | null,
): boolean {
  return contract.maxBytes === 0 || (contentType !== null && contract.contentTypes.includes(contentType));
}

/** Project only the representation admitted by the recipient declaration. */
export function projectRecipientOperationResponseBody(
  contract: ResponseContract,
  body: Uint8Array,
  sourceCredentials: readonly string[],
): Uint8Array | null {
  if (body.byteLength > contract.maxBytes) return null;
  if (contract.maxBytes === 0) return body;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const projectedText = JSON.stringify(JSON.parse(text));
    if (
      projectedText === undefined
      || containsProviderRegisteredSensitiveValue(projectedText, sourceCredentials)
    ) return null;
    const projected = new TextEncoder().encode(projectedText);
    return projected.byteLength <= contract.maxBytes ? projected : null;
  } catch {
    return null;
  }
}
