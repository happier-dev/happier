import {
    ComposerReferenceResolutionV1Schema as canonicalComposerReferenceResolutionV1Schema,
} from '@happier-dev/protocol/plugins/contributions/composer-reference-providers';

/**
 * The executable canonical parser for a complete Composer reference
 * resolution, including Protocol's public 16KiB serialized-value boundary.
 *
 * Providers use this while fitting whole semantic items into a resolution.
 * The SDK keeps the declaration structural while aliasing Protocol's runtime
 * parser, and owns no second parser, byte limit, or resolution grammar.
 */
export const ProtocolComposerReferenceResolutionV1Schema: Readonly<{
    parse(value: unknown): Readonly<{
        id: string;
        label: string;
        description?: string;
        context: string;
    }>;
    safeParse(value: unknown):
        | Readonly<{
            success: true;
            data: Readonly<{
                id: string;
                label: string;
                description?: string;
                context: string;
            }>;
        }>
        | Readonly<{ success: false; error: unknown }>;
}> =
    canonicalComposerReferenceResolutionV1Schema;
