import {
    encryptSessionMessagePayload,
    type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';
import { redactTranscriptSecrets } from './transcriptSecretRedaction';

/** Socket transcript payload shape; encryption stays owned by the Session codec. Live host-minted secrets are redacted first. */
export function buildOutboundSessionMessagePayload(
    context: SessionStoredContentCryptoContext,
    content: unknown,
): string | { t: 'plain'; v: unknown } {
    const redacted = redactTranscriptSecrets(content);
    return context.mode === 'plain'
        ? { t: 'plain', v: redacted }
        : encryptSessionMessagePayload({ ctx: context.ctx, payload: redacted });
}
