import {
    encryptSessionPayload,
    type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';

/** Socket transcript payload shape; encryption stays owned by the Session codec. */
export function buildOutboundSessionMessagePayload(
    context: SessionStoredContentCryptoContext,
    content: unknown,
): string | { t: 'plain'; v: unknown } {
    return context.mode === 'plain'
        ? { t: 'plain', v: content }
        : encryptSessionPayload({ ctx: context.ctx, payload: content });
}
