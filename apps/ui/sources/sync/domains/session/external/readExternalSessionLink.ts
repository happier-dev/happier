import {
    readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
    type LinkedExternalSessionV1,
} from '@happier-dev/protocol';

export type ExternalSessionLink = LinkedExternalSessionV1;

export function readExternalSessionLink(metadata: unknown): ExternalSessionLink | null {
    return readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata) as ExternalSessionLink | null;
}
