import { createHash } from 'node:crypto';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

export function createPluginWebhookIdentityFingerprintV1(value: unknown): string {
    return createHash('sha256').update(createCanonicalJsonSigningInput(value), 'utf8').digest('hex');
}

/** Index identity only; retain the exact checkId for correspondence and receipt hints. */
export function createPluginWebhookCheckIdDigestV1(checkId: string): string {
    return checkId === '' ? '' : createPluginWebhookIdentityFingerprintV1(checkId);
}
