import type {
    SessionDraftAddressV1,
    SessionDraftStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { canonicalSessionDraftAddressV1 } from '@happier-dev/protocol';

export function sessionDraftContentMatchesAddress(
    content: SessionDraftStoredContentEnvelopeV1 | null,
    address: SessionDraftAddressV1,
): boolean {
    if (content === null || content.t === 'encrypted') return true;
    return canonicalSessionDraftAddressV1(content.v.address) === canonicalSessionDraftAddressV1(address);
}
