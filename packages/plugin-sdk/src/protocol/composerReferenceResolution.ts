import {
    ComposerReferenceResolutionV1Schema as canonicalComposerReferenceResolutionV1Schema,
} from '@happier-dev/protocol/plugins/contributions/composer-reference-providers';
import type { ComposerReferenceResolutionV1 } from '@happier-dev/protocol';

/**
 * The executable canonical parser for a complete Composer reference
 * resolution, including Protocol's public 16KiB serialized-value boundary.
 *
 * Providers use this while fitting whole semantic items into a resolution.
 * The SDK aliases the Protocol value by identity and owns no second parser,
 * byte limit, or resolution grammar.
 */
export const ProtocolComposerReferenceResolutionV1Schema: Readonly<{
    parse(value: unknown): ComposerReferenceResolutionV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ComposerReferenceResolutionV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> =
    canonicalComposerReferenceResolutionV1Schema;
