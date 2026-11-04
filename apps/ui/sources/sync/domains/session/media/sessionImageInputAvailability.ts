import type { Metadata } from '@happier-dev/session-core/state';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';

export type SessionImageInputAvailability =
    | Readonly<{ available: true }>
    | Readonly<{ available: false; reason: 'image_input_unsupported' }>;

const AVAILABLE: SessionImageInputAvailability = Object.freeze({ available: true });
const UNSUPPORTED: SessionImageInputAvailability = Object.freeze({ available: false, reason: 'image_input_unsupported' });

function readLeaf(value: unknown, key: string): unknown {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, key) : undefined;
}

export function decideSessionImageInputAvailability(
    metadata: (Pick<Metadata, 'agentRuntimeCapabilitiesV1'> & Readonly<{ imageInputSupported?: boolean }>) | null | undefined,
): SessionImageInputAvailability {
    const backend = readLeaf(metadata?.agentRuntimeCapabilitiesV1, 'backend');
    const session = readLeaf(backend, 'session');
    const media = readLeaf(session, 'media');
    const imageInput = readLeaf(media, 'acceptsImageInput');
    return (metadata?.imageInputSupported ?? readLeaf(imageInput, 'supported')) === false ? UNSUPPORTED : AVAILABLE;
}

/** Compact cross-Home rows retain the owner's decision without keeping private metadata. */
export function readSessionImageInputAvailability(
    session: (Parameters<typeof readSessionOwnerMetadataView>[0] & Readonly<{
        imageInputAvailability?: SessionImageInputAvailability;
    }>) | null | undefined,
): SessionImageInputAvailability {
    if (!session) return AVAILABLE;
    return session.imageInputAvailability ?? decideSessionImageInputAvailability(readSessionOwnerMetadataView(session));
}
