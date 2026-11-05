import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SavedSecretCatalogCorruptEntryV1, SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    fetchAccountEncryptionMode,
    getAccountEncryptionModeCacheRevision,
    getAccountEncryptionModeScopeKey,
    subscribeAccountEncryptionModeCacheInvalidation,
} from '@/sync/api/account/apiAccountEncryptionMode';
import type { AccountSettingsSavedSecretReference } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { savedSecretUsedByCopy, sharedSecretProvenanceSegments, sharedSecretRowStatus, sharedSecretStatusLabel } from '@/components/secrets/savedSecretRowCopy';
import { useSavedSecretUsedBy, useSavedSecretUsedBySourcesDemand } from '@/components/secrets/useSavedSecretUsedBy';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { providerConnectionDetailRoute } from '@/components/settings/providers/collection/providerCollectionModel';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import type { ScopedSnapshotStatus } from '@/sync/domains/scope/scopedSnapshotFacts';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SharedSavedSecretHistory } from '@/components/secrets/SharedSavedSecretHistory';
import { SharedSavedSecretValueItem } from '@/components/secrets/SharedSavedSecretValueItem';
import { isSavedSecretVaultExportCandidate } from '@/components/secrets/vault/SavedSecretVaultExportSheet';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { CollectionStatusGlyph, type CollectionRowStatus } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';

type CorruptOwnerEntry = Extract<SavedSecretCatalogCorruptEntryV1, { relationship: 'owner' }>;

export type SecretsSettingsPageProps = Readonly<{
    /** The Account the shared rows belong to; their person-only Reveal and history run in it. Absent: no Reveal. */
    scope?: ServerAccountScope | null;
    personalSecrets: readonly SavedSecret[];
    sharedEntries: readonly SavedSecretCatalogEntryV1[];
    /** Settings-only repair projection: rows the Home cannot read, with the owner's delete. */
    corruptEntries: readonly SavedSecretCatalogCorruptEntryV1[];
    resolveSharedReference: (ref: string) => SavedSecretReferenceResolution;
    /** The shared catalog is showing last-known rows because a refresh failed. */
    sharedCatalogStale: boolean;
    sharedCatalogStatus: ScopedSnapshotStatus;
    onRetrySharedCatalog?: () => void;

    onRenamePersonal: (secret: SavedSecret, name: string) => Promise<boolean>;
    onRotatePersonal: (secret: SavedSecret, value: string) => Promise<boolean>;
    onDeletePersonal: (secret: SavedSecret) => Promise<boolean>;
    /** Opens the access editor for a still-personal secret; absent where sharing is unavailable. */
    onSharePersonal?: (secret: SavedSecret) => void;
    /** Retires the screen's clean create/access editor before a name or value editor opens. */
    onBeginEdit?: () => void;

    onRenameShared?: (entry: SavedSecretCatalogEntryV1, name: string) => boolean | void | Promise<boolean | void>;
    onRotateShared?: (entry: SavedSecretCatalogEntryV1, value: string) => boolean | void | Promise<boolean | void>;
    /** Converts an owned end-to-end encrypted resource to Home-managed storage; absent where not allowed. */
    onMakeSharedHomeManaged?: (entry: SavedSecretCatalogEntryV1) => void;
    /** Converts an owned Home-managed resource to end-to-end encrypted storage; absent where not allowed. */
    onEncryptShared?: (entry: SavedSecretCatalogEntryV1) => void;
    onManageAccessShared?: (entry: SavedSecretCatalogEntryV1) => void;
    onDeleteShared?: (entry: SavedSecretCatalogEntryV1) => void;
    onDeleteCorruptShared?: (entry: CorruptOwnerEntry) => void;
    /** Moves a private value into a vault source ("Move to 1Password"); absent where no source can store. */
    moveToVault?: Readonly<{ label: string; onMove: (entry: SavedSecretCatalogEntryV1) => void }>;
    sharedMutationsDisabled: boolean;

    approvalId: string | null;
    onOpenApproval?: () => void;

    /** Opens the draft row at the top of the collection. */
    onAdd: () => void;
    onCancelAdd: () => void;
    /** The one create editor, rendered in the draft row while adding. */
    createEditor: React.ReactNode | null;
    /** The one secret whose recipients are being chosen, with its editor, shown inside its row. */
    accessEditor: Readonly<{ key: string; element: React.ReactNode }> | null;
    /** The secret the Credentials rail selected (route `secret`): the page becomes that secret's page. */
    selectedRef?: string | null;
    /** Opens one of your secrets as its own page (the route's `secret`), from this list. */
    onOpenSecret?: (ref: string) => void;
    /** Opens what uses a secret, from its Used by section. */
    onOpenUsedBy?: (route: string) => void;
}>;

/** A secret's type; shared rows the Home cannot fully read may not carry one. */
function kindLabel(kind: SavedSecret['kind'] | null): string | null {
    return kind ? t(`secrets.catalog.kinds.${kind}`) : null;
}

/**
 * A resource's type, read from the catalog's value-free storage fact: a transferred passkey is saved
 * with the generic kind, so its storage says what it is. Content is never opened to label a row.
 */
function entryKindLabel(entry: SavedSecretCatalogEntryV1): string | null {
    return entry.storage?.kind === 'passkey' ? t('secretsSettings.kindPasskey') : kindLabel(entry.kind);
}

/** The installed source a linked resource reads from, named by its admitted declaration; null when unknown. */
function linkedProvider(entry: SavedSecretCatalogEntryV1): string | null {
    return entry.storage?.kind === 'external' ? entry.storage.providerLabel ?? null : null;
}

/** Where the value lives: a vault-linked resource keeps only which field to read, under the Account's mode. */
function entryStorageLabel(entry: SavedSecretCatalogEntryV1): string | null {
    if (entry.storage?.kind !== 'external') return storageLabel(entry.encryptionMode);
    const provider = linkedProvider(entry);
    return provider ? t('secretsSettings.storageLinkedTo', { provider }) : t('secretsSettings.storageLinked');
}

function sharedRowStatus(resolution: SavedSecretReferenceResolution, entry: SavedSecretCatalogEntryV1) {
    return resolution.displayStatus ?? resolution.status ?? entry.materialStatus;
}

function audienceSummary(entry: SavedSecretCatalogEntryV1): string {
    const audience = entry.audience;
    const count = audience ? audience.accounts.length + audience.teams.length + audience.groups.length : 0;
    return count === 0 ? t('secretsSettings.accessOnlyYou') : t('secretsSettings.accessRecipients', { count });
}

function storageLabel(mode: SavedSecretCatalogEntryV1['encryptionMode']): string | null {
    if (mode === 'e2ee') return t('secretsSettings.storageE2ee');
    if (mode === 'plain') return t('secretsSettings.storagePlain');
    return null;
}

/** Observe the mode reader, without treating device-local SecretString sealing as Account E2EE. */
function usePersonalSecretStorageMode(enabled: boolean): SavedSecretCatalogEntryV1['encryptionMode'] {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const snapshot = useActiveServerSnapshot(enabled && credentials !== null);
    const serverId = snapshot.serverId;
    const subscribe = React.useCallback((listener: () => void) =>
        subscribeAccountEncryptionModeCacheInvalidation(listener, serverId), [serverId]);
    const getRevision = React.useCallback(() => getAccountEncryptionModeCacheRevision(serverId), [serverId]);
    const revision = React.useSyncExternalStore(
        subscribe,
        getRevision,
        getRevision,
    );
    const scopeKey = enabled && credentials ? getAccountEncryptionModeScopeKey(credentials, snapshot) : null;
    const [read, setRead] = React.useState<Readonly<{
        scopeKey: string;
        revision: number;
        mode: 'plain' | 'e2ee';
    }> | null>(null);
    React.useEffect(() => {
        if (!scopeKey || !credentials) return;
        let retired = false;
        void fetchAccountEncryptionMode(credentials).then(
            ({ mode }) => { if (!retired) setRead({ scopeKey, revision, mode }); },
            () => { if (!retired) setRead(null); },
        );
        return () => { retired = true; };
    }, [credentials, scopeKey, revision]);
    // Withdraw old disclosures immediately on Account/Home changes or owner invalidation.
    return read && read.scopeKey === scopeKey && read.revision === revision ? read.mode : null;
}

/** The storage explanation is shared by personal and owned resource rows. */
function SecretStorageRow(props: Readonly<{
    mode: SavedSecretCatalogEntryV1['encryptionMode'];
    /** A linked resource's source: its declared name, or null while that is unknown. */
    linked?: Readonly<{ provider: string | null }>;
    action?: React.ReactNode;
}>) {
    const provider = props.linked?.provider ?? null;
    const storage = props.linked
        ? provider ? t('secretsSettings.storageLinkedTo', { provider }) : t('secretsSettings.storageLinked')
        : storageLabel(props.mode);
    if (!storage) return null;
    const linkedDescription = provider ? t('secretsSettings.storageLinkedToDescription', { provider })
        : t('secretsSettings.storageLinkedDescription');
    return <Item
        title={t('secretsSettings.storageTitle')}
        subtitle={`${storage}. ${props.linked ? linkedDescription : props.mode === 'e2ee'
            ? t('secretsSettings.storageE2eeDescription')
            : t('secretsSettings.storagePlainDescription')}`}
        subtitleLines={0}
        accessoryLayout="adaptive"
        showChevron={false}
        showDivider={false}
        rightElement={props.action}
    />;
}

/**
 * Settings → Secrets: the Account's Saved Secrets as a shallow collection. Each secret expands in
 * place to show its value (masked; a person who manages a shared secret can reveal and copy it, and
 * sees who did), where it is kept and who can use it, with the actions its capabilities allow.
 * Adding opens a draft row at the top with the one create editor; choosing recipients opens the
 * access editor inside the secret's own row.
 */
export const SecretsSettingsPage = React.memo(function SecretsSettingsPage(props: SecretsSettingsPageProps) {
    const personalStorageMode = usePersonalSecretStorageMode(props.personalSecrets.length > 0);
    const [expandedKey, setExpandedKey] = React.useState<string | null>(props.selectedRef ?? null);
    const selectedRef = props.selectedRef ?? null;
    React.useEffect(() => { if (selectedRef) setExpandedKey(selectedRef); }, [selectedRef]);
    const adding = props.createEditor !== null;
    const accessKey = props.accessEditor?.key ?? null;
    const isExpanded = (key: string) => key === accessKey || key === expandedKey;
    const toggle = React.useCallback((key: string, next: boolean) => {
        void runGuardedNavigation(() => setExpandedKey((current) => (next ? key : current === key ? null : current)));
    }, []);

    const ownerShared = props.sharedEntries.filter((entry) => entry.relationship === 'owner');
    const recipientShared = props.sharedEntries.filter((entry) => entry.relationship === 'recipient');
    const ownerCorrupt = props.corruptEntries.filter((entry): entry is CorruptOwnerEntry => entry.relationship === 'owner');
    const recipientCorrupt = props.corruptEntries.filter((entry) => entry.relationship === 'recipient');
    const yoursEmpty = props.personalSecrets.length === 0 && ownerShared.length === 0 && ownerCorrupt.length === 0;
    const openEntry = selectedRef ? ownerShared.find((entry) => entry.ref === selectedRef) ?? null : null;
    const pageNotices = (
        <>
            {props.approvalId && props.onOpenApproval ? (
                <ItemGroup>
                    <Item
                        testID="saved-secret-approval"
                        icon={<Icon name="shield-check" />}
                        title={t('approvals.title')}
                        subtitle={t('secrets.catalog.approvalPending')}
                        subtitleLines={0}
                        accessibilityLiveRegion="polite"
                        onPress={props.onOpenApproval}
                    />
                </ItemGroup>
            ) : null}
            {props.sharedCatalogStale && props.onRetrySharedCatalog ? (
                // Last-known rows stay at full strength; one quiet line says they are stale, with Retry.
                <SurfaceFreshnessLine
                    testID="saved-secret-catalog-retry"
                    reason={t('secretsSettings.staleTitle')}
                    action={{ label: t('common.retry'), testID: 'saved-secret-catalog-retry-button', onPress: props.onRetrySharedCatalog }}
                />
            ) : null}
        </>
    );

    // A selected secret is its own page (lab `crDetail-secret`), beside the Credentials rail.
    if (openEntry) {
        return (
            <ItemList keyboardShouldPersistTaps="handled">
                <OwnedSecretPage
                    key={openEntry.ref}
                    scope={props.scope ?? null}
                    entry={openEntry}
                    status={sharedRowStatus(props.resolveSharedReference(openEntry.ref), openEntry)}
                    notices={pageNotices}
                    accessEditor={accessKey === openEntry.ref ? props.accessEditor?.element ?? null : null}
                    disabled={props.sharedMutationsDisabled}
                    onRename={props.onRenameShared}
                    onRotate={props.onRotateShared}
                    onBeginEdit={props.onBeginEdit}
                    onMakeHomeManaged={props.onMakeSharedHomeManaged}
                    onEncrypt={props.onEncryptShared}
                    onManageAccess={props.onManageAccessShared}
                    onDelete={props.onDeleteShared}
                    onOpenUsedBy={props.onOpenUsedBy}
                    moveToVault={props.moveToVault && isSavedSecretVaultExportCandidate(openEntry) ? props.moveToVault : undefined}
                />
            </ItemList>
        );
    }

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <SettingsPageHeader description={t('secretsSettings.purpose')} />
            {pageNotices}

            <ItemGroup
                title={t('secretsSettings.yoursTitle')}
                description={t('secretsSettings.yoursDescription')}
                actionLayout="adaptive"
                action={<AddSecretAction disabled={adding} onPress={props.onAdd} />}
            >
                {adding ? (
                    <ExpandableItem
                        testID="saved-secret-draft"
                        expanded
                        onExpandedChange={(next) => { if (!next) props.onCancelAdd(); }}
                        header={({ headerProps }) => (
                            <Item {...headerProps} title={t('secretsSettings.newSecret')} />
                        )}
                    >
                        {props.createEditor}
                    </ExpandableItem>
                ) : null}
                {props.sharedCatalogStatus === 'loading' ? (
                    <SectionContentRow>
                        <SurfaceStateCard
                            testID="saved-secret-catalog-loading"
                            kind="loading"
                            size="line"
                            title={t('common.loading')}
                            accessibilitySemantics="status"
                            action={props.onRetrySharedCatalog ? {
                                label: t('common.retry'),
                                testID: 'saved-secret-catalog-retry-button',
                                onPress: props.onRetrySharedCatalog,
                            } : undefined}
                        />
                    </SectionContentRow>
                ) : null}
                {yoursEmpty && !adding && props.sharedCatalogStatus === 'ready' ? (
                    <EmptyState
                        testID="saved-secret:empty"
                        layout="line"
                        title={t('secretsSettings.emptyTitle')}
                        subtitle={t('secretsSettings.emptyDescription')}
                    />
                ) : null}
                {props.personalSecrets.map((secret) => (
                    <PersonalSecretRow
                        key={secret.id}
                        secret={secret}
                        storageMode={personalStorageMode}
                        expanded={isExpanded(secret.id)}
                        onExpandedChange={(next) => toggle(secret.id, next)}
                        accessEditor={accessKey === secret.id ? props.accessEditor?.element ?? null : null}
                        onRename={props.onRenamePersonal}
                        onRotate={props.onRotatePersonal}
                        onDelete={props.onDeletePersonal}
                        onShare={props.onSharePersonal}
                        onBeginEdit={props.onBeginEdit}
                        shareDisabled={accessKey !== null}
                    />
                ))}
                {ownerShared.map((entry) => (
                    <OwnedSecretRow
                        key={entry.ref}
                        entry={entry}
                        status={sharedRowStatus(props.resolveSharedReference(entry.ref), entry)}
                        onOpen={props.onOpenSecret}
                    />
                ))}
                {ownerCorrupt.map((entry, idx) => (
                    <CorruptSecretRow
                        key={`owner:${entry.repair.resourceId}`}
                        testID={`saved-secret-corrupt:owner:${idx}`}
                        relationship="owner"
                        onDelete={props.onDeleteCorruptShared ? () => props.onDeleteCorruptShared?.(entry) : undefined}
                        deleteTestID={`saved-secret-corrupt:owner:${idx}:delete`}
                        disabled={props.sharedMutationsDisabled}
                    />
                ))}
            </ItemGroup>

            {recipientShared.length + recipientCorrupt.length > 0 ? (
                <ItemGroup
                    title={t('secretsSettings.sharedWithYouTitle')}
                    description={t('secretsSettings.sharedWithYouDescription')}
                >
                    {recipientShared.map((entry) => (
                        <RecipientSecretRow
                            key={entry.ref}
                            entry={entry}
                            status={sharedRowStatus(props.resolveSharedReference(entry.ref), entry)}
                        />
                    ))}
                    {recipientCorrupt.map((_entry, idx) => (
                        <CorruptSecretRow
                            key={`recipient:${idx}`}
                            testID={`saved-secret-corrupt:recipient:${idx}`}
                            relationship="recipient"
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

function AddSecretAction(props: Readonly<{ disabled: boolean; onPress: () => void }>) {
    return (
        <SectionActionButton
            testID="saved-secret-add"
            icon="plus"
            title={t('secretsSettings.add')}
            disabled={props.disabled}
            onPress={props.onPress}
        />
    );
}

/** The value row every secret shares: saved, never shown, replaceable when the capability allows. */
function SecretValueRow(props: Readonly<{ replaceTestID: string; onReplace?: () => void; disabled?: boolean; subtitle?: string }>) {
    return (
        <Item
            title={t('secretsSettings.valueTitle')}
            subtitle={props.subtitle ?? t('secretsSettings.valueSaved')}
            subtitleLines={0}
            showChevron={false}
            showDivider={false}
            rightElement={props.onReplace ? (
                <RoundButton
                    testID={props.replaceTestID}
                    size="small"
                    display="secondary"
                    title={t('secrets.actions.replace')}
                    disabled={props.disabled}
                    onPress={props.onReplace}
                />
            ) : undefined}
        />
    );
}

/** Names and replacement values share this row-local input; saved values are never read into it. */
function SecretFieldEditor(props: Readonly<{
    testID: string;
    mode: 'rename' | 'rotate';
    name: string;
    disabled?: boolean;
    onSave: (value: string) => boolean | void | Promise<boolean | void>;
    onCancel: () => void;
}>) {
    const navigation = useNavigation();
    const [value, setValue] = React.useState(props.mode === 'rename' ? props.name : '');
    const [pending, setPending] = React.useState(false);
    const label = t(props.mode === 'rename' ? 'secrets.fields.name' : 'secrets.fields.value');
    useUnsavedDraftNavigationGuard({ navigation, isDirty: value !== (props.mode === 'rename' ? props.name : ''),
        onDiscard: props.onCancel, tag: 'saved-secret-field-draft' });
    return <>
        <Item title={label} showChevron={false} accessoryLayout="adaptive"
            rightElement={<FieldTextInput testID={`${props.testID}:edit-input`} accessibilityLabel={label}
                value={value} onChangeText={setValue} secureTextEntry={props.mode === 'rotate'}
                autoCapitalize="none" autoFocus editable={!pending && !props.disabled} />} />
        <SectionContentRow><SectionButtonRow>
            <RoundButton testID={`${props.testID}:edit-save`} title={t('common.save')} size="small"
                loading={pending} disabled={pending || props.disabled || (props.mode === 'rename' ? !value.trim() : value.length === 0)}
                onPress={() => { void (async () => {
                    setPending(true);
                    try { if (await props.onSave(value)) { setValue(''); props.onCancel(); } }
                    finally { setPending(false); }
                })(); }} />
            <RoundButton testID={`${props.testID}:edit-cancel`} title={t('common.cancel')} size="small" display="secondary"
                disabled={pending || props.disabled} onPress={props.onCancel} />
        </SectionButtonRow></SectionContentRow>
    </>;
}

/** The access row: who can use the secret, then the access editor in place when it is open. */
function SecretAccessRow(props: Readonly<{
    summary: string;
    actionTitle: string;
    actionTestID: string;
    onAction: () => void;
    disabled?: boolean;
    editor: React.ReactNode | null;
}>) {
    return (
        <>
            <Item
                title={t('secretsSettings.accessTitle')}
                subtitle={props.summary}
                subtitleLines={0}
                showChevron={false}
                showDivider={false}
                rightElement={props.editor ? undefined : (
                    <RoundButton
                        testID={props.actionTestID}
                        size="small"
                        display="secondary"
                        title={props.actionTitle}
                        disabled={props.disabled}
                        onPress={props.onAction}
                    />
                )}
            />
            {props.editor}
        </>
    );
}

/** Rare operations close the expanded row: quiet ones first, the irreversible delete at the end. */
function SecretActionsRow(props: Readonly<{ children: React.ReactNode; destructive?: React.ReactNode }>) {
    const styles = stylesheet;
    return (
        <View style={styles.actions}>
            {props.children}
            {props.destructive ? <View style={styles.destructive}>{props.destructive}</View> : null}
        </View>
    );
}

function DeleteButton(props: Readonly<{ testID: string; onPress: () => void; disabled?: boolean }>) {
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="destructive"
            title={t('common.delete')}
            disabled={props.disabled}
            onPress={props.onPress}
        />
    );
}

function RenameButton(props: Readonly<{ testID: string; onPress: () => void; disabled?: boolean }>) {
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="secondary"
            title={t('common.rename')}
            disabled={props.disabled}
            onPress={props.onPress}
        />
    );
}

const PersonalSecretRow = React.memo(function PersonalSecretRow(props: Readonly<{
    secret: SavedSecret;
    storageMode: SavedSecretCatalogEntryV1['encryptionMode'];
    expanded: boolean;
    onExpandedChange: (next: boolean) => void;
    accessEditor: React.ReactNode | null;
    onRename: (secret: SavedSecret, name: string) => Promise<boolean>;
    onRotate: (secret: SavedSecret, value: string) => Promise<boolean>;
    onDelete: (secret: SavedSecret) => Promise<boolean>;
    onShare?: (secret: SavedSecret) => void;
    onBeginEdit?: () => void;
    shareDisabled: boolean;
}>) {
    const { secret } = props;
    const [editing, setEditing] = React.useState<'rename' | 'rotate' | null>(null);
    React.useEffect(() => { if (!props.expanded || props.accessEditor) setEditing(null); }, [props.expanded, props.accessEditor]);
    const beginEdit = (mode: 'rename' | 'rotate') => { void runGuardedNavigation(() => { props.onBeginEdit?.(); setEditing(mode); }); };
    return (
        <ExpandableItem
            testID={`saved-secret:${secret.id}`}
            expanded={props.expanded}
            onExpandedChange={props.onExpandedChange}
            // The header's own disclosure glyph (Item draws it from the expanded state) says the row opens.
            header={({ headerProps }) => (
                <Item
                    {...headerProps}
                    testID={`saved-secret:${secret.id}:header`}
                    title={secret.name}
                    // Open, the body's Storage and access rows say the rest; the header keeps only the kind.
                    subtitle={props.expanded ? kindLabel(secret.kind) ?? undefined
                        : [kindLabel(secret.kind), storageLabel(props.storageMode), t('secretsSettings.accessOnlyYou')].filter(Boolean).join(' · ')}
                />
            )}
        >
            <SecretValueRow replaceTestID={`saved-secret:${secret.id}:replace`} onReplace={() => beginEdit('rotate')} />
            {editing ? <SecretFieldEditor key={editing} testID={`saved-secret:${secret.id}`} mode={editing} name={secret.name}
                onSave={(value) => editing === 'rename' ? props.onRename(secret, value) : props.onRotate(secret, value)}
                onCancel={() => setEditing(null)} /> : null}
            <SecretStorageRow mode={props.storageMode} />
            {props.onShare ? (
                <SecretAccessRow
                    summary={`${t('secretsSettings.accessOnlyYou')}. ${t('secretsSettings.sharePersonalDescription')}`}
                    actionTitle={t('secretsSettings.share')}
                    actionTestID={`saved-secret:${secret.id}:share`}
                    onAction={() => props.onShare?.(secret)}
                    disabled={props.shareDisabled}
                    editor={props.accessEditor}
                />
            ) : null}
            <SecretActionsRow
                destructive={<DeleteButton testID={`saved-secret:${secret.id}:delete`} onPress={() => { void props.onDelete(secret); }} />}
            >
                <RenameButton testID={`saved-secret:${secret.id}:rename`} onPress={() => beginEdit('rename')} />
            </SecretActionsRow>
        </ExpandableItem>
    );
});

/** One of your secrets in the list: what it is and who can use it; it opens as its own page. */
const OwnedSecretRow = React.memo(function OwnedSecretRow(props: Readonly<{
    entry: SavedSecretCatalogEntryV1;
    status: SavedSecretCatalogEntryV1['materialStatus'];
    onOpen?: (ref: string) => void;
}>) {
    const { entry, status, onOpen } = props;
    const name = entry.name ?? t('secrets.catalog.unavailableName');
    const summary = [entryKindLabel(entry), entryStorageLabel(entry), audienceSummary(entry)]
        .filter((part): part is string => Boolean(part)).join(' · ');
    return (
        <Item
            testID={`saved-secret:${entry.ref}:header`}
            title={name}
            subtitle={summary}
            rightElement={secretStatusGlyph(entry.ref, sharedSecretRowStatus(status), sharedSecretStatusLabel(status))}
            keepChevronWithRightElement
            accessibilityLabel={[name, t('secrets.catalog.relationship.owner'), summary, ...statusWords(status)].join(', ')}
            onPress={onOpen ? () => onOpen(entry.ref) : undefined}
        />
    );
});

/** Each kind of thing that can hold a secret: its mark, and the page it lives on when the census names no exact one. */
const USED_BY_KINDS: Readonly<Record<AccountSettingsSavedSecretReference['owner'], Readonly<{ icon: IconName; route: string | null }>>> = {
    provider: { icon: 'cube', route: SETTINGS_ROUTES.providers },
    connectedAccountCredential: { icon: 'key', route: SETTINGS_ROUTES.connectedServices },
    connectedAccountConfiguration: { icon: 'key', route: SETTINGS_ROUTES.connectedServices },
    profile: { icon: 'sliders-horizontal', route: SETTINGS_ROUTES.profiles },
    voice: { icon: 'microphone', route: SETTINGS_ROUTES.voice },
    mcp: { icon: 'puzzle-piece', route: SETTINGS_ROUTES.mcp },
    acp: { icon: 'sparkle', route: SETTINGS_ROUTES.agents },
    plugin: { icon: 'cube', route: SETTINGS_ROUTES.plugins },
    remoteHost: { icon: 'hard-drives', route: SETTINGS_ROUTES.remoteHosts },
    notificationChannel: { icon: 'bell', route: SETTINGS_ROUTES.notifications },
    registrySource: { icon: 'books', route: SETTINGS_ROUTES.prompts },
    unknown: { icon: 'question', route: null },
};

/**
 * Who relies on this secret, from the held reference census. One thing reading it through two fields
 * is one row. Unknown stays a line of its own: it is never shown as "not used".
 */
export const SecretUsedBySection = React.memo(function SecretUsedBySection(props: Readonly<{
    testID: string;
    usedBy: readonly AccountSettingsSavedSecretReference[] | null;
    onOpen?: (route: string) => void;
}>) {
    const { theme } = useUnistyles();
    const rows = React.useMemo(() => {
        const unique = new Map<string, Readonly<{ key: string; title: string; subtitle: string; icon: IconName; route: string | null }>>();
        for (const reference of props.usedBy ?? []) {
            const kind = reference.referrer?.kind ?? reference.owner;
            const { title, subtitle } = savedSecretUsedByCopy(reference);
            const route = kind === 'provider' && reference.referrer ? providerConnectionDetailRoute(reference.referrer.id) : USED_BY_KINDS[kind].route;
            const key = JSON.stringify([route, title, subtitle]);
            if (!unique.has(key)) unique.set(key, { key, title, subtitle, icon: USED_BY_KINDS[kind].icon, route });
        }
        return [...unique.values()];
    }, [props.usedBy]);
    return (
        <ItemGroup title={t('secretsSettings.usedByTitle')}>
            {rows.length === 0 ? (
                // The same two lines as a row, so the section keeps its height when the census arrives.
                <Item
                    testID={props.testID}
                    title={props.usedBy === null ? t('secretsSettings.usedByUnknown') : t('secretsSettings.usedByEmpty')}
                    subtitle={props.usedBy === null ? t('secretsSettings.usedByUnknownDetail') : t('secretsSettings.usedByEmptyDetail')}
                    mode="info"
                    showChevron={false}
                />
            ) : rows.map((row) => (
                <Item
                    key={row.key}
                    testID={`${props.testID}:row`}
                    icon={<Icon name={row.icon} size={18} color={theme.colors.text.secondary} />}
                    title={row.title}
                    subtitle={row.subtitle || undefined}
                    {...(row.route && props.onOpen ? { onPress: () => props.onOpen?.(row.route!) } : { mode: 'info' as const, showChevron: false })}
                />
            ))}
        </ItemGroup>
    );
});

/**
 * One of your secrets as its own page (lab `crDetail-secret`): who it is, its value, who can use it,
 * who revealed it, and Delete last with what deleting does. Rare operations (rename, where it is kept,
 * moving it to a vault) sit in the header's ⋯.
 */
const OwnedSecretPage = React.memo(function OwnedSecretPage(props: Readonly<{
    scope: ServerAccountScope | null;
    entry: SavedSecretCatalogEntryV1;
    status: SavedSecretCatalogEntryV1['materialStatus'];
    notices: React.ReactNode;
    accessEditor: React.ReactNode | null;
    disabled: boolean;
    onRename?: (entry: SavedSecretCatalogEntryV1, name: string) => boolean | void | Promise<boolean | void>;
    onRotate?: (entry: SavedSecretCatalogEntryV1, value: string) => boolean | void | Promise<boolean | void>;
    onBeginEdit?: () => void;
    onMakeHomeManaged?: (entry: SavedSecretCatalogEntryV1) => void;
    onEncrypt?: (entry: SavedSecretCatalogEntryV1) => void;
    onManageAccess?: (entry: SavedSecretCatalogEntryV1) => void;
    onDelete?: (entry: SavedSecretCatalogEntryV1) => void;
    onOpenUsedBy?: (route: string) => void;
    moveToVault?: Readonly<{ label: string; onMove: (entry: SavedSecretCatalogEntryV1) => void }>;
}>) {
    const { entry, status } = props;
    const { theme } = useUnistyles();
    useSavedSecretUsedBySourcesDemand(props.scope);
    const usedBy = useSavedSecretUsedBy(props.scope, entry.ref);
    const inUse = usedBy !== null && usedBy.length > 0;
    const [editing, setEditing] = React.useState<'rename' | 'rotate' | null>(null);
    const [moreOpen, setMoreOpen] = React.useState(false);
    React.useEffect(() => { if (props.accessEditor) setEditing(null); }, [props.accessEditor]);
    const beginEdit = (mode: 'rename' | 'rotate') => { void runGuardedNavigation(() => { props.onBeginEdit?.(); setEditing(mode); }); };
    const name = entry.name ?? t('secrets.catalog.unavailableName');
    const passkey = entry.storage?.kind === 'passkey';
    const linked = entry.storage?.kind === 'external';
    const provider = linkedProvider(entry);
    const testID = `saved-secret:${entry.ref}`;
    // Conversion rewrites the resource's content through the same update a rotation uses, so it is
    // offered exactly where a rotation is, out of the row's known current mode, and only where the
    // screen allows that direction.
    const convert = entry.encryptionMode === 'e2ee' ? props.onMakeHomeManaged
        : entry.encryptionMode === 'plain' ? props.onEncrypt
            : undefined;
    const canConvert = entry.capabilities.rotate && Boolean(convert) && !linked;
    const canRename = entry.capabilities.rename && Boolean(props.onRename);
    const canDelete = entry.capabilities.delete && Boolean(props.onDelete);
    const canShare = entry.capabilities.manageAccess && Boolean(props.onManageAccess);
    const shared = (entry.audience?.accounts.length ?? 0) + (entry.audience?.teams.length ?? 0) + (entry.audience?.groups.length ?? 0) > 0;
    const parsedRef = parseSavedSecretCatalogReferenceV1(entry.ref);
    const resourceId = parsedRef?.kind === 'shared_resource' ? parsedRef.id : null;
    const onReplace = !passkey && entry.capabilities.rotate && props.onRotate ? () => beginEdit('rotate') : undefined;

    // Who it is, on one line: its type and where it is kept; a secret in trouble says so once, here.
    const meta: PageHeaderMetaFact[] = [
        ...(entryKindLabel(entry) ? [{ key: 'kind', text: entryKindLabel(entry)! }] : []),
        ...(entryStorageLabel(entry) ? [{ key: 'storage', text: entryStorageLabel(entry)!,
            ...(entry.encryptionMode === 'e2ee' && !linked ? { icon: 'lock' as const } : {}) }] : []),
        ...(status !== 'ready' ? [{ key: 'status', testID: `${testID}:status`, text: sharedSecretStatusLabel(status), icon: 'warning' as const }] : []),
    ];
    const moreItems: DropdownMenuItem[] = [
        ...(canRename ? [{ id: 'rename', testID: `${testID}:menu-rename`, title: t('common.rename'), disabled: props.disabled }] : []),
        ...(canConvert ? [{ id: 'convert', testID: `${testID}:convertMode`, disabled: props.disabled,
            title: entry.encryptionMode === 'e2ee' ? t('secrets.catalog.actions.convertToPlain') : t('secrets.catalog.actions.convertToE2ee') }] : []),
        ...(props.moveToVault ? [{ id: 'move', testID: `${testID}:moveToVault`, title: props.moveToVault.label, disabled: props.disabled }] : []),
    ];

    return (
        <>
            <SettingsPageHeader
                testID={`${testID}:page-header`}
                title={name}
                alwaysShowTitle
                compactPresentation="centered"
                leading={(
                    <PageHeaderMarkSlot>
                        <Icon name="key" size={26} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                meta={meta}
                // Renaming is rare: the pencil beside the name (as on pools and accounts), and in ⋯.
                titleAccessory={canRename ? (
                    <IconButton
                        testID={`${testID}:rename`}
                        accessibilityLabel={t('common.rename')}
                        iconName="pencil-simple"
                        variant="plain"
                        iconSize={15}
                        disabled={props.disabled}
                        onPress={() => beginEdit('rename')}
                    />
                ) : undefined}
                actions={canShare || moreItems.length > 0 ? (
                    <View style={stylesheet.headerActions}>
                        {/* While the access editor is open below, it is the way to change who can use it. */}
                        {canShare && !props.accessEditor ? (
                            <RoundButton
                                testID={`${testID}:manageAccess`}
                                size="small"
                                display="secondary"
                                title={t('secretsSettings.share')}
                                leading={<Icon name="share" size={14} color={theme.colors.text.primary} />}
                                disabled={props.disabled}
                                onPress={() => props.onManageAccess?.(entry)}
                            />
                        ) : null}
                        {moreItems.length > 0 ? (
                            <DropdownMenu
                                open={moreOpen}
                                onOpenChange={setMoreOpen}
                                items={moreItems}
                                onSelect={(id) => {
                                    if (id === 'rename') beginEdit('rename');
                                    if (id === 'convert') convert?.(entry);
                                    if (id === 'move') props.moveToVault?.onMove(entry);
                                }}
                                rowKind="item"
                                placement="bottom"
                                popoverAnchorAlign="end"
                                matchTriggerWidth={false}
                                trigger={({ toggle }) => (
                                    <IconButton
                                        testID={`${testID}:more`}
                                        iconName="dots-three"
                                        variant="plain"
                                        accessibilityLabel={t('common.moreActions')}
                                        onPress={toggle}
                                    />
                                )}
                            />
                        ) : null}
                    </View>
                ) : undefined}
            />
            {props.notices}
            {editing === 'rename' ? (
                <ItemGroup>
                    <SecretFieldEditor key="rename" testID={testID} mode="rename" name={name} disabled={props.disabled}
                        onSave={(value) => props.onRename?.(entry, value)}
                        onCancel={() => setEditing(null)} />
                </ItemGroup>
            ) : null}

            <ItemGroup>
                {passkey || linked || !props.scope ? (
                    // A passkey's key is never shown or replaced; a linked value lives in the vault, and
                    // replacing it stores a value in Happier instead.
                    <SecretValueRow
                        replaceTestID={`${testID}:rotate`}
                        subtitle={passkey ? t('secretsSettings.valuePasskey') : linked ? provider
                            ? t('secretsSettings.valueLinkedTo', { provider })
                            : t('secretsSettings.valueLinked') : undefined}
                        onReplace={onReplace}
                        disabled={props.disabled}
                    />
                ) : (
                    <SharedSavedSecretValueItem
                        testID={`${testID}:value`}
                        scope={props.scope}
                        entry={entry}
                        active
                        replaceTestID={`${testID}:rotate`}
                        onReplace={onReplace}
                        disabled={props.disabled}
                    />
                )}
                {editing === 'rotate' ? (
                    <SecretFieldEditor key="rotate" testID={testID} mode="rotate" name={name} disabled={props.disabled}
                        onSave={(value) => props.onRotate?.(entry, value)}
                        onCancel={() => setEditing(null)} />
                ) : null}
            </ItemGroup>

            <SecretUsedBySection testID={`${testID}:used-by`} usedBy={usedBy} onOpen={props.onOpenUsedBy} />

            {canShare ? (
                <ItemGroup title={t('secretsSettings.sharingTitle')} description={t('secretsSettings.sharingDescription')}>
                    <Item
                        testID={`${testID}:access`}
                        title={audienceSummary(entry)}
                        mode="info"
                        showChevron={false}
                        showDivider={false}
                    />
                    {props.accessEditor}
                </ItemGroup>
            ) : null}

            {/* Reveal history lists who saw the value; a passkey's key is never shown, so it has none. */}
            {props.scope && resourceId && entry.capabilities.manageAccess && !passkey ? (
                <ItemGroup title={t('secretsSettings.historyTitle')}>
                    <SharedSavedSecretHistory
                        testID={`${testID}:history`}
                        scope={props.scope}
                        resourceId={resourceId}
                        enabled
                    />
                </ItemGroup>
            ) : null}

            {canDelete ? (
                // The irreversible action closes the page, its consequence said once beneath it.
                <ItemGroup surface="none">
                    <View style={stylesheet.exit}>
                        <RoundButton
                            testID={`${testID}:delete`}
                            size="small"
                            display="destructive"
                            title={t('secretsSettings.deleteSecret')}
                            disabled={props.disabled || inUse}
                            onPress={() => props.onDelete?.(entry)}
                        />
                        <Text style={stylesheet.exitNote}>
                            {inUse ? t('secretsSettings.deleteInUseNote') : shared ? t('secretsSettings.deleteNoteShared') : t('secretsSettings.deleteNote')}
                        </Text>
                    </View>
                </ItemGroup>
            ) : null}
        </>
    );
});

/** A secret someone shared with this Account: who shared it and through what, never its value. */
function RecipientSecretRow(props: Readonly<{
    entry: SavedSecretCatalogEntryV1;
    status: SavedSecretCatalogEntryV1['materialStatus'];
}>) {
    const { entry, status } = props;
    const name = entry.name ?? t('secrets.catalog.unavailableName');
    const summary = sharedSecretProvenanceSegments(entry).join(' · ');
    return (
        <Item
            testID={`saved-secret:${entry.ref}`}
            title={name}
            subtitle={summary}
            subtitleLines={0}
            rightElement={secretStatusGlyph(entry.ref, sharedSecretRowStatus(status), sharedSecretStatusLabel(status))}
            accessibilityLabel={[name, t('secrets.catalog.relationship.recipient'), summary, ...statusWords(status)].join(', ')}
            mode="info"
            showChevron={false}
        />
    );
}

/** A troubled secret's status in its row's end slot: icon only, the word in the tooltip (P8); a ready secret has none. */
function secretStatusGlyph(ref: string, status: CollectionRowStatus | null, label: string): React.ReactNode {
    return status ? <CollectionStatusGlyph testID={`saved-secret:${ref}:status`} status={status} label={label} /> : undefined;
}

/** The status word an assistive reader still hears, since the sighted row draws only the glyph. */
function statusWords(status: SavedSecretCatalogEntryV1['materialStatus']): readonly string[] {
    return status === 'ready' ? [] : [sharedSecretStatusLabel(status)];
}

/** A secret the Home cannot read: informational, with the owner's delete as the only repair. */
function CorruptSecretRow(props: Readonly<{
    testID: string;
    relationship: 'owner' | 'recipient';
    onDelete?: () => void;
    deleteTestID?: string;
    disabled?: boolean;
}>) {
    const name = t('secrets.catalog.unavailableName');
    const status = t('secrets.catalog.status.resource_corrupt');
    return (
        <Item
            testID={props.testID}
            title={name}
            subtitle={status}
            accessibilityLabel={[
                name,
                props.relationship === 'owner'
                    ? t('secrets.catalog.relationship.owner')
                    : t('secrets.catalog.relationship.recipient'),
                status,
            ].join(', ')}
            mode="info"
            showChevron={false}
            rightElementOutsidePressable={Boolean(props.onDelete)}
            rightElement={props.onDelete ? (
                <View style={stylesheet.endSlot}>
                    <CollectionStatusGlyph status="failed" label={status} />
                    <DeleteButton testID={props.deleteTestID ?? `${props.testID}:delete`} disabled={props.disabled} onPress={props.onDelete} />
                </View>
            ) : <CollectionStatusGlyph status="failed" label={status} />}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    endSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 16,
    },
    destructive: {
        marginLeft: 'auto',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    exit: {
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    exitNote: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));
