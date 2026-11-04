import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SavedSecret } from '@happier-dev/protocol/profiles/backendProfileSchema';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { SavedSecretCatalogProjection, SavedSecretPersonalCreateInput, SavedSecretPrivateCreationApprovalOptions } from './useSavedSecretCatalog';
import {
    SavedSecretVaultFields,
    SavedSecretVaultItemsField,
    useSavedSecretVaultChoice,
    type SavedSecretVaultItemSelection,
} from './vault/SavedSecretVaultFields';
import { useSavedSecretSources } from './vault/useSavedSecretSources';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createSavedSecretResource } from '@/sync/ops/settings/savedSecretResourceOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';

import {
    createEmptySavedSecretGrantDraft,
    savedSecretGrantInputs,
} from '@/components/sharing/secrets/savedSecretGrantDraft';
import { SavedSecretShareSheet } from '@/components/sharing/secrets/SavedSecretShareSheet';

const SECRET_KINDS = ['apiKey', 'token', 'password', 'other'] as const satisfies readonly SavedSecret['kind'][];

type SecretStorage = 'personal' | 'shared';
/** Where the value comes from: typed into Happier, or read from a declared secret source's field. */
const VALUE_ORIGIN = 'value';

/** From a vault that can list its items: link ones it has, or save a new value into it. */
type VaultMode = 'existing' | 'new';

/**
 * The one editor that adds a Saved Secret, shown in the draft row of the Secrets collection.
 *
 * Both choices use the SavedSecret resource owner. The catalog's private-create port gives the
 * resource no recipients; the shared-create port also accepts the chosen grants. A value is entered
 * once and never shown again.
 */
export const SavedSecretCreateEditor = React.memo(function SavedSecretCreateEditor(props: Readonly<{
    /** The admitted Home and Account for resource creation. */
    scope: ServerAccountScope | null;
    /** Links a vault's items (all, or the chosen ones) as personal secrets; absent where vaults cannot be browsed. */
    onLinkVault?: SavedSecretCatalogProjection['linkVaultItems'];
    /** The catalog's private-create port; absent where only the grant-aware choice is offered. */
    onCreatePersonal?: (input: SavedSecretPersonalCreateInput, approval?: SavedSecretPrivateCreationApprovalOptions) => Promise<string | null>;
    /** Whether this Home allows shared secrets. Defaults to available when a scope is given. */
    sharedAvailable?: boolean;
    approvalPending: boolean;
    approvalId?: string | null;
    onOpenApproval?: () => void;
    requestApproval: (registration: ActionApprovalRegistration) => void;
    onCancel: () => void;
    onDirtyChange?: (dirty: boolean) => void;
    /** The newly created resource's canonical reference. */
    onCreated: (ref: string, storage: SecretStorage) => void | Promise<void>;
    /** The name a new secret gets unless the person types another (a Connect sheet's "DeepSeek key"). */
    initialName?: string;
    /** The primary's words where the sheet names what it saves ("Save key"); "Save secret" by default. */
    submitLabel?: string;
    /** `sheet`: the Connect sheet's card supplies the gutter, so the form adds none of its own. */
    presentation?: 'sheet';
}>) {
    const { theme } = useUnistyles();
    const sharedAvailable = props.scope !== null && props.sharedAvailable !== false;
    const personalAvailable = Boolean(props.onCreatePersonal);
    const [chosenStorage, setChosenStorage] = React.useState<SecretStorage>('personal');
    const sources = useSavedSecretSources(props.scope, personalAvailable);
    const [chosenOrigin, setChosenOrigin] = React.useState<string>(VALUE_ORIGIN);
    // A source that is no longer installed falls back to a typed value rather than a form that cannot succeed.
    const linkedSource = sources.find(source => source.key === chosenOrigin) ?? null;
    // Linked secrets are personal-only: the Machine that uses one reads it from the owner's vault.
    const storage: SecretStorage = linkedSource ? 'personal' : !personalAvailable ? 'shared' : !sharedAvailable ? 'personal' : chosenStorage;
    const [name, setName] = React.useState('');
    // A suggested name makes Name optional: an empty field saves under the suggestion.
    const suggestedName = props.initialName?.trim() ?? '';
    const effectiveName = name.trim() || suggestedName;
    const [value, setValue] = React.useState('');
    const [linkAccount, setLinkAccount] = React.useState('');
    const [linkReference, setLinkReference] = React.useState('');
    // A source that lists its vault is browsed rather than typed; one that can also store offers a new item.
    const browseable = Boolean(linkedSource?.capabilities?.list && props.onLinkVault);
    const storable = browseable && linkedSource?.capabilities?.store === true;
    const [chosenVaultMode, setVaultMode] = React.useState<VaultMode>('existing');
    const vaultMode: VaultMode | null = !browseable ? null : storable ? chosenVaultMode : 'existing';
    const vaultChoice = useSavedSecretVaultChoice({ scope: props.scope, source: browseable ? linkedSource : null,
        onApprovalPending: props.requestApproval });
    const vault = vaultChoice.state.status === 'ready' ? vaultChoice.vault : null;
    // Each vault starts with all of its items chosen.
    const [chosenItems, setChosenItems] = React.useState<Readonly<{ vaultId: string | null; selection: SavedSecretVaultItemSelection }>>(
        { vaultId: null, selection: 'all' });
    const itemSelection: SavedSecretVaultItemSelection = vault && chosenItems.vaultId === vault.id ? chosenItems.selection : 'all';
    const chosenItemCount = itemSelection === 'all' ? vaultChoice.items.length : itemSelection.size;
    const material = vaultMode === 'existing' ? vaultChoice.target !== null && chosenItemCount > 0
        : vaultMode === 'new' ? vaultChoice.target !== null && value.length > 0
        : linkedSource ? linkAccount.trim().length > 0 && linkReference.trim().length > 0 : value.length > 0;
    // Linked items take their names from the vault ("GitHub / token"); the other choices are named here.
    const named = vaultMode !== 'existing';
    const [kind, setKind] = React.useState<SavedSecret['kind']>('apiKey');
    const [grants, setGrants] = React.useState(createEmptySavedSecretGrantDraft);
    const [submitting, setSubmitting] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const dirty = name.length > 0 || value.length > 0 || kind !== 'apiKey'
        || chosenStorage !== 'personal' || grants.length > 0
        || chosenOrigin !== VALUE_ORIGIN || linkAccount.length > 0 || linkReference.length > 0 || vaultChoice.dirty;
    React.useEffect(() => { props.onDirtyChange?.(dirty); }, [dirty, props.onDirtyChange]);
    const operationInFlight = React.useRef(false);
    const scopeKey = props.scope ? `${props.scope.serverId}:${props.scope.accountId}` : 'unscoped';
    const currentScopeKey = React.useRef(scopeKey);
    currentScopeKey.current = scopeKey;

    // The draft key is Home + viewer Account (plan 10.09 §14: Home server
    // identity + Team + resource + viewer Account; a new secret has no Team or
    // resource yet). A scope change is therefore a different draft: a value
    // typed for one Home must never be submittable to another, and its
    // recipients are that Home's identities, so the whole draft clears in the
    // same render that shows the new scope.
    const [draftScopeKey, setDraftScopeKey] = React.useState(scopeKey);
    if (draftScopeKey !== scopeKey) {
        setDraftScopeKey(scopeKey);
        setName('');
        setValue('');
        setLinkAccount('');
        setLinkReference('');
        setChosenOrigin(VALUE_ORIGIN);
        setKind('apiKey');
        setGrants(createEmptySavedSecretGrantDraft);
    }

    React.useEffect(() => {
        operationInFlight.current = false;
        setSubmitting(false);
        setFailure(null);
    }, [scopeKey]);

    const finishCreated = React.useCallback(async (ref: string, requestedScopeKey: string, created: SecretStorage) => {
        if (currentScopeKey.current !== requestedScopeKey) return;
        setSubmitting(false);
        operationInFlight.current = false;
        await props.onCreated(ref, created);
    }, [props.onCreated]);

    const submitPersonal = React.useCallback(async (trimmedName: string) => {
        const create = props.onCreatePersonal;
        if (!create) return;
        operationInFlight.current = true;
        setSubmitting(true);
        setFailure(null);
        try {
            // The original promise is settled by the shared Artifact continuation,
            // not by replaying creation after approval.
            const input: SavedSecretPersonalCreateInput = vaultMode === 'new' && vaultChoice.target
                ? { name: trimmedName, value, storeIn: vaultChoice.target }
                : linkedSource
                ? { name: trimmedName, source: { kind: 'external', contribution: linkedSource.contribution,
                    account: linkAccount.trim(), reference: linkReference.trim() } }
                : { name: trimmedName, value };
            const createdId = await create(input, { onApprovalPending: props.requestApproval });
            if (currentScopeKey.current !== scopeKey) return;
            if (createdId) {
                await finishCreated(createdId, scopeKey, 'personal');
                return;
            }
        } catch {
            if (currentScopeKey.current !== scopeKey) return;
            setFailure(t('secrets.catalog.operationFailed'));
        }
        operationInFlight.current = false;
        setSubmitting(false);
    }, [finishCreated, linkAccount, linkReference, linkedSource, props.onCreatePersonal, props.requestApproval, scopeKey, value,
        vaultChoice.target, vaultMode]);

    const submitLink = React.useCallback(async () => {
        const link = props.onLinkVault;
        const target = vaultChoice.target;
        if (!link || !target) return;
        operationInFlight.current = true;
        setSubmitting(true);
        setFailure(null);
        try {
            const outcome = await link({ source: target,
                ...(itemSelection === 'all' ? {} : { itemIds: [...itemSelection] }) });
            if (currentScopeKey.current !== scopeKey) return;
            if (outcome.kind === 'succeeded') {
                const first = outcome.value.secrets[0]?.secretRef;
                if (first) { await finishCreated(first, scopeKey, 'personal'); return; }
            } else {
                setFailure(outcome.failure.kind === 'outcome_unknown'
                    ? t('secrets.catalog.outcomeUnknown') : t('secretsSettings.vaultLinkFailed'));
            }
        } catch (cause) {
            if (currentScopeKey.current !== scopeKey) return;
            if (isTeamActionApprovalPendingError(cause)) { props.requestApproval(cause.registration); return; }
            setFailure(t('secretsSettings.vaultLinkFailed'));
        }
        operationInFlight.current = false;
        setSubmitting(false);
    }, [finishCreated, itemSelection, props.onLinkVault, props.requestApproval, scopeKey, vaultChoice.target]);

    const submitShared = React.useCallback(async (trimmedName: string) => {
        const scope = props.scope;
        if (!scope) return;
        const grantCount = grants.length;
        if (grantCount > 0) {
            const confirmed = await Modal.confirm(
                t('secrets.catalog.shareDisclosureTitle'),
                t('secrets.catalog.shareDisclosureBody'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('secrets.catalog.shareDisclosureConfirm', {
                        target: t('secrets.catalog.shareDisclosureTargetCount', { count: grantCount }),
                    }),
                },
            );
            if (!confirmed || currentScopeKey.current !== scopeKey) return;
        }
        operationInFlight.current = true;
        setSubmitting(true);
        setFailure(null);
        try {
            const result = await createSavedSecretResource({
                scope,
                name: trimmedName,
                kind,
                value,
                ...savedSecretGrantInputs(grants),
                onApprovalSucceeded: ({ resourceRef }) => finishCreated(resourceRef, scopeKey, 'shared'),
                onApprovalFailed: () => {
                    if (currentScopeKey.current !== scopeKey) return;
                    operationInFlight.current = false;
                    setSubmitting(false);
                    setFailure(t('secrets.catalog.approvalDeclined'));
                },
            });
            if (currentScopeKey.current !== scopeKey) return;
            if (result.ok) await finishCreated(result.resourceRef, scopeKey, 'shared');
            else {
                operationInFlight.current = false;
                setSubmitting(false);
                setFailure(result.reason === 'outcome_unknown'
                    ? t('secrets.catalog.outcomeUnknown')
                    : t('secrets.catalog.operationFailed'));
            }
        } catch (cause) {
            if (currentScopeKey.current !== scopeKey) return;
            if (isTeamActionApprovalPendingError(cause)) {
                props.requestApproval(cause.registration);
                return;
            }
            operationInFlight.current = false;
            setSubmitting(false);
            setFailure(t('secrets.catalog.operationFailed'));
        }
    }, [finishCreated, grants, kind, props.requestApproval, props.scope, scopeKey, value]);

    const submit = React.useCallback(async () => {
        const trimmedName = effectiveName;
        if ((named && !trimmedName) || !material || operationInFlight.current || props.approvalPending) return;
        if (vaultMode === 'existing') await submitLink();
        else if (storage === 'personal') await submitPersonal(trimmedName);
        else await submitShared(trimmedName);
    }, [effectiveName, material, named, props.approvalPending, storage, submitLink, submitPersonal, submitShared, vaultMode]);

    const busy = submitting || props.approvalPending;
    const storageTabs = React.useMemo(() => [
        { id: 'personal' as const, label: t('secretsSettings.keepPersonal') },
        { id: 'shared' as const, label: t('secretsSettings.keepShared') },
    ], []);
    const originTabs = React.useMemo(() => [
        { id: VALUE_ORIGIN, label: t('secretsSettings.originHappier') },
        ...sources.map(source => ({ id: source.key, label: source.title })),
    ], [sources]);
    const vaultModeTabs = React.useMemo(() => [
        { id: 'existing' as const, label: t('secretsSettings.vaultModeExisting') },
        { id: 'new' as const, label: t('secretsSettings.vaultModeNew') },
    ], []);
    const submitTitle = vaultMode === 'existing' && vault
        ? itemSelection === 'all' ? t('secretsSettings.vaultLinkAll', { vault: vault.name })
            : t('secretsSettings.vaultLinkCount', { count: chosenItemCount })
        : vaultMode === 'new' && vault ? t('secretsSettings.vaultSaveTo', { vault: vault.name })
        : (props.submitLabel ?? t('secretsSettings.save'));
    const kindTabs = React.useMemo(() => SECRET_KINDS.map((candidate) => ({
        id: candidate,
        label: t(`secrets.catalog.kinds.${candidate}`),
    })), []);

    return (
        <View style={props.presentation === 'sheet' ? styles.sheetBody : styles.body} testID="saved-secret-create-editor">
            <View style={styles.fields}>
                {linkedSource && vaultMode ? (
                    <>
                        {storable ? (
                            <FieldItem label={t('secretsSettings.vaultModeTitle')}>
                                <SegmentedTabBar
                                    labelSize="field"
                                    tabs={vaultModeTabs}
                                    activeTabId={vaultMode}
                                    onSelectTab={setVaultMode}
                                    disabled={busy}
                                    testIDPrefix="saved-secret-create-vault-mode"
                                />
                            </FieldItem>
                        ) : null}
                        <SavedSecretVaultFields choice={vaultChoice} provider={linkedSource.title} disabled={busy}
                            testID="saved-secret-create-vault" />
                        {vaultMode === 'existing' && vault ? (
                            <SavedSecretVaultItemsField
                                vault={vault}
                                items={vaultChoice.items}
                                selection={itemSelection}
                                onChange={(selection) => setChosenItems({ vaultId: vault.id, selection })}
                                disabled={busy}
                                testID="saved-secret-create-vault-items"
                            />
                        ) : null}
                        {vaultMode === 'new' ? (
                            <FieldItem label={t('secrets.fields.value')}>
                                <FieldTextInput
                                    testID="saved-secret-create-value"
                                    value={value}
                                    onChangeText={setValue}
                                    placeholder={t('secrets.placeholders.valueExample')}
                                    accessibilityLabel={t('secrets.fields.value')}
                                    editable={!busy}
                                    secureTextEntry
                                    monospace
                                />
                            </FieldItem>
                        ) : null}
                    </>
                ) : linkedSource ? (
                    <>
                        <FieldItem label={t('secretsSettings.linkAccount')}>
                            <FieldTextInput
                                testID="saved-secret-create-link-account"
                                value={linkAccount}
                                onChangeText={setLinkAccount}
                                placeholder={t('secretsSettings.linkAccountPlaceholder')}
                                accessibilityLabel={t('secretsSettings.linkAccount')}
                                editable={!busy}
                            />
                        </FieldItem>
                        <FieldItem label={t('secretsSettings.linkReference')}>
                            <FieldTextInput
                                testID="saved-secret-create-link-reference"
                                value={linkReference}
                                onChangeText={setLinkReference}
                                placeholder={t('secretsSettings.linkReferencePlaceholder')}
                                accessibilityLabel={t('secretsSettings.linkReference')}
                                editable={!busy}
                                monospace
                            />
                        </FieldItem>
                    </>
                ) : (
                    <FieldItem label={t('secrets.fields.value')}>
                        <FieldTextInput
                            testID="saved-secret-create-value"
                            value={value}
                            onChangeText={setValue}
                            placeholder={t('secrets.placeholders.valueExample')}
                            accessibilityLabel={t('secrets.fields.value')}
                            editable={!busy}
                            secureTextEntry
                            monospace
                            autoFocus
                        />
                    </FieldItem>
                )}
                {/* One order on every key sheet: the value, its name, then where it is kept. */}
                {named ? <FieldItem label={t('secrets.fields.name')}
                    supportingText={suggestedName ? t('connectedServicesSettings.keyNameOptional') : undefined}>
                    <FieldTextInput
                        testID="saved-secret-create-name"
                        value={name}
                        onChangeText={setName}
                        placeholder={suggestedName || t('secrets.placeholders.nameExample')}
                        accessibilityLabel={t('secrets.fields.name')}
                        editable={!busy}
                    />
                </FieldItem> : null}
                {sources.length > 0 ? (
                    <FieldItem
                        label={t('secretsSettings.originTitle')}
                        supportingText={linkedSource
                            ? t('secretsSettings.originLinkedDescription', { provider: linkedSource.title })
                            : undefined}
                    >
                        <SegmentedTabBar
                            labelSize="field"
                            tabs={originTabs}
                            activeTabId={linkedSource ? linkedSource.key : VALUE_ORIGIN}
                            onSelectTab={setChosenOrigin}
                            disabled={busy}
                            testIDPrefix="saved-secret-create-origin"
                        />
                    </FieldItem>
                ) : null}
                {personalAvailable && sharedAvailable && !linkedSource ? (
                    <FieldItem
                        label={t('secretsSettings.keepTitle')}
                        supportingText={storage === 'personal'
                            ? t('secretsSettings.keepPersonalDescription')
                            : t('secretsSettings.keepSharedDescription')}
                    >
                        <SegmentedTabBar
                            labelSize="field"
                            tabs={storageTabs}
                            activeTabId={storage}
                            onSelectTab={setChosenStorage}
                            disabled={busy}
                            testIDPrefix="saved-secret-create-storage"
                        />
                    </FieldItem>
                ) : null}
                {storage === 'shared' ? (
                    <FieldItem label={t('secrets.catalog.kindTitle')}>
                        <SegmentedTabBar
                            role="radiogroup"
                            labelSize="field"
                            tabs={kindTabs}
                            activeTabId={kind}
                            onSelectTab={setKind}
                            disabled={busy}
                            testIDPrefix="saved-secret-create-kind"
                        />
                    </FieldItem>
                ) : null}
            </View>
            {storage === 'shared' && props.scope ? (
                <FieldItem label={t('secretsSettings.accessTitle')}>
                    <SavedSecretShareSheet scope={props.scope} draft={grants} onChange={setGrants} disabled={busy} />
                </FieldItem>
            ) : null}
            {failure ? (
                <Text
                    testID="saved-secret-create-failure"
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[styles.notice, { color: theme.colors.state.danger.foreground }]}
                >
                    {failure}
                </Text>
            ) : null}
            {props.approvalId && props.onOpenApproval ? (
                <ActionApprovalPendingNotice testID="saved-secret-create-approval"
                    message={t('secrets.catalog.approvalPending')} onOpenApproval={props.onOpenApproval} />
            ) : null}
            <RoundButtonSizeScope size="normal" presentation="uniform"><View style={styles.actions}>
                <RoundButton
                    testID="saved-secret-create-cancel"
                    display="secondary"
                    title={t('common.cancel')}
                    disabled={busy}
                    onPress={props.onCancel}
                />
                <RoundButton
                    testID="saved-secret-create-submit"
                    title={submitTitle}
                    loading={busy}
                    disabled={busy || (named && !effectiveName) || !material}
                    onPress={() => { void submit(); }}
                />
            </View></RoundButtonSizeScope>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 14 },
    fields: { gap: 12, width: '100%' },
    sheetBody: { gap: 14 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
    notice: { fontSize: 13, lineHeight: 18 },
}));
