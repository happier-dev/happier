import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { AccountSettingsSavedSecretReference } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

import type { CollectionRowStatus } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

/** What kind of thing holds the reference, in the person's words. */
function savedSecretUsedByKindLabel(owner: AccountSettingsSavedSecretReference['owner']): string {
    switch (owner) {
        case 'provider': return t('settingsProviders.kind.frontier');
        case 'connectedAccountCredential': return t('settingsVoice.realtimeProviders.authentication.account.title');
        case 'connectedAccountConfiguration': return t('secretsSettings.usedByKindConnectedConfiguration');
        case 'profile': return t('secretsSettings.usedByKindProfile');
        case 'voice': return t('secretsSettings.usedByKindVoice');
        case 'mcp': return t('secretsSettings.usedByKindMcp');
        case 'acp': return t('secretsSettings.usedByKindAgent');
        case 'plugin': return t('secretsSettings.usedByKindPlugin');
        case 'remoteHost': return t('secretsSettings.usedByKindRemoteHost');
        case 'notificationChannel': return t('secretsSettings.usedByKindNotificationChannel');
        case 'registrySource': return t('secretsSettings.usedByKindRegistrySource');
        case 'deploymentEnvironment': return t('projects.deployments.review.environment');
        case 'unknown': return t('common.unknown');
    }
}

/**
 * Used-by row copy from the resource owner's identity: its name and kind, or only its kind when the
 * owner supplies no name. Paths are diagnostic metadata only.
 */
export function savedSecretUsedByCopy(reference: AccountSettingsSavedSecretReference): Readonly<{ title: string; subtitle: string }> {
    const kind = savedSecretUsedByKindLabel(reference.referrer?.kind ?? reference.owner);
    const name = reference.referrer?.displayName;
    return name ? { title: name, subtitle: kind } : { title: kind, subtitle: '' };
}

/**
 * A resource's type, read from the catalog's value-free storage fact: a transferred passkey is saved with the
 * generic kind, so its storage says what it is. Content is never opened to label a row.
 */
export function savedSecretEntryKindLabel(entry: SavedSecretCatalogEntryV1): string | null {
    if (entry.storage?.kind === 'passkey') return t('secretsSettings.kindPasskey');
    return entry.kind ? t(`secrets.catalog.kinds.${entry.kind}`) : null;
}

/** Where a vault-linked value lives, named by its admitted declaration; null for a value Happier stores. */
export function savedSecretLinkedStorageLabel(entry: SavedSecretCatalogEntryV1): string | null {
    if (entry.storage?.kind !== 'external') return null;
    const provider = entry.storage.providerLabel ?? null;
    return provider ? t('secretsSettings.storageLinkedTo', { provider }) : t('secretsSettings.storageLinked');
}

/** "Only you", or how many people and Teams can use it beside you. */
export function savedSecretAudienceSummary(entry: SavedSecretCatalogEntryV1): string {
    const audience = entry.audience;
    const count = audience ? audience.accounts.length + audience.teams.length + audience.groups.length : 0;
    return count === 0 ? t('secretsSettings.accessOnlyYou') : t('secretsSettings.accessRecipients', { count });
}

/**
 * One of your secrets in a list: its type, where a linked value lives, and who else can use it. How Happier
 * stores it and "only you" are what every sibling shares, so the list says them once, not on each row.
 */
export function savedSecretOwnedRowSummary(entry: SavedSecretCatalogEntryV1): string {
    const audience = entry.audience;
    const shared = Boolean(audience && audience.accounts.length + audience.teams.length + audience.groups.length > 0);
    return [
        savedSecretEntryKindLabel(entry),
        savedSecretLinkedStorageLabel(entry),
        shared ? savedSecretAudienceSummary(entry) : null,
    ].filter((part): part is string => Boolean(part)).join(' · ');
}

/** The material status of a shared secret, in the owner's or recipient's words. */
export function sharedSecretStatusLabel(status: SavedSecretCatalogEntryV1['materialStatus']): string {
    switch (status) {
        case 'ready': return t('secrets.catalog.status.ready');
        case 'preparing_encrypted_access': return t('secrets.catalog.status.preparing_encrypted_access');
        case 'recipient_mode_unsupported': return t('secrets.catalog.status.recipient_mode_unsupported');
        case 'temporarily_unavailable': return t('secrets.catalog.status.temporarily_unavailable');
        case 'access_removed': return t('secrets.catalog.status.access_removed');
        case 'deleted': return t('secrets.catalog.status.deleted');
        case 'update_required': return t('secrets.catalog.status.update_required');
    }
}

/** The status glyph a secret's material status draws in a collection row; a ready secret draws none. */
export function sharedSecretRowStatus(status: SavedSecretCatalogEntryV1['materialStatus']): CollectionRowStatus | null {
    switch (status) {
        case 'ready': return null;
        case 'preparing_encrypted_access': return 'stale';
        case 'recipient_mode_unsupported': return 'review';
        case 'temporarily_unavailable': return 'offline';
        case 'access_removed': return 'revoked';
        case 'deleted': return 'off';
        case 'update_required': return 'update';
    }
}

/**
 * Where a shared secret came from, in the words the Home already projected.
 *
 * Picking a shared secret decides whose credential a Session spends, so the row
 * states the recipient-safe owner and the access that carries it. Both facts are
 * read straight from the catalog projection — nothing is inferred from the
 * focused Home, the Team the surface happens to sit in, or the secret's name —
 * and an owner row states neither, because it is the person's own secret.
 */
export function sharedSecretProvenanceSegments(entry: SavedSecretCatalogEntryV1): readonly string[] {
    const ownerName = entry.owner ? formatAccountDisplayName(entry.owner) : null;
    return [
        ...(entry.relationship === 'recipient' && ownerName
            ? [t('secrets.catalog.provenance.sharedBy', { owner: ownerName })]
            : []),
        ...entry.accessSources.map((source) => {
            if (source.kind === 'account') return t('secrets.catalog.provenance.direct');
            return t('secrets.catalog.provenance.via', {
                source: source.kind === 'group' ? `${source.teamName} · ${source.name}` : source.name,
            });
        }),
    ];
}
