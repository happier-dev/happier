import {
    createVoiceProviderRecipientContractFromCredentialsV1,
    type RecipientContractV1,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';

type RecipientPackageSourceKind =
    RecipientContractV1['package']['source']['kind'];

const RECIPIENT_PACKAGE_SOURCE_KINDS = new Set<RecipientPackageSourceKind>([
    'archive',
    'bundled',
    'marketplace',
    'package',
    'path',
]);

function normalizeRecipientPackageSourceKind(
    value: string | undefined,
): RecipientPackageSourceKind {
    return value && RECIPIENT_PACKAGE_SOURCE_KINDS.has(
        value as RecipientPackageSourceKind,
    )
        ? value as RecipientPackageSourceKind
        : 'path';
}

type VoiceProviderRecipientDeclaration = Readonly<{
    pluginId: string;
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: VoiceProviderContribution;
    provenance?: 'first_party' | 'external';
    source?: Readonly<{ kind: string }>;
    sourceSpec?: Readonly<{
        kind: string;
        locator: string;
        trustPolicy?: string;
    }>;
}>;

/**
 * Canonical recipient contract for a resolved Voice provider declaration.
 * Projection and credential materialization both consume this exact owner so
 * the approved digest cannot drift from the daemon's enforcement digest.
 */
export function createVoiceProviderRecipientContract(
    declaration: VoiceProviderRecipientDeclaration,
) {
    const hostMediated = declaration.definition.credentials?.hostMediated;
    if (!hostMediated) return null;
    const bundled = declaration.provenance === 'first_party'
        && declaration.source?.kind === 'bundled';
    const sourceKind = normalizeRecipientPackageSourceKind(
        declaration.sourceSpec?.kind ?? declaration.source?.kind,
    );
    const sourceLocator = declaration.sourceSpec?.locator ?? declaration.pluginId;
    return createVoiceProviderRecipientContractFromCredentialsV1({
        package: {
            pluginId: declaration.pluginId,
            source: { kind: sourceKind, locator: sourceLocator },
        },
        publisher: bundled
            ? { trust: 'bundled', identity: 'happier.dev:first-party-bundle' }
            : {
                trust: 'verified',
                identity: [
                    sourceKind,
                    sourceLocator,
                    declaration.sourceSpec?.trustPolicy ?? 'committed-registry',
                ].join(':'),
            },
        contribution: declaration.identity,
        credentials: {
            slot: declaration.definition.credentials!.slot,
            hostMediated,
        },
        presentation: { title: declaration.definition.title },
    });
}
