import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SavedSecret } from '@happier-dev/protocol';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { SavedSecretPrivateCreationApprovalOptions } from './useSavedSecretCatalog';
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
    /** The catalog's private-create port; absent where only the grant-aware choice is offered. */
    onCreatePersonal?: (input: Readonly<{ name: string; value: string }>, approval?: SavedSecretPrivateCreationApprovalOptions) => Promise<string | null>;
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
}>) {
    const { theme } = useUnistyles();
    const sharedAvailable = props.scope !== null && props.sharedAvailable !== false;
    const personalAvailable = Boolean(props.onCreatePersonal);
    const [chosenStorage, setChosenStorage] = React.useState<SecretStorage>('personal');
    const storage: SecretStorage = !personalAvailable ? 'shared' : !sharedAvailable ? 'personal' : chosenStorage;
    const [name, setName] = React.useState('');
    const [value, setValue] = React.useState('');
    const [kind, setKind] = React.useState<SavedSecret['kind']>('apiKey');
    const [grants, setGrants] = React.useState(createEmptySavedSecretGrantDraft);
    const [submitting, setSubmitting] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const dirty = name.length > 0 || value.length > 0 || kind !== 'apiKey'
        || chosenStorage !== 'personal' || grants.length > 0;
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
            const createdId = await create({ name: trimmedName, value }, { onApprovalPending: props.requestApproval });
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
    }, [finishCreated, props.onCreatePersonal, props.requestApproval, scopeKey, value]);

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
        const trimmedName = name.trim();
        if (!trimmedName || value.length === 0 || operationInFlight.current || props.approvalPending) return;
        if (storage === 'personal') await submitPersonal(trimmedName);
        else await submitShared(trimmedName);
    }, [name, props.approvalPending, storage, submitPersonal, submitShared, value.length]);

    const busy = submitting || props.approvalPending;
    const storageTabs = React.useMemo(() => [
        { id: 'personal' as const, label: t('secretsSettings.keepPersonal') },
        { id: 'shared' as const, label: t('secretsSettings.keepShared') },
    ], []);
    const kindTabs = React.useMemo(() => SECRET_KINDS.map((candidate) => ({
        id: candidate,
        label: t(`secrets.catalog.kinds.${candidate}`),
    })), []);

    return (
        <View style={styles.body} testID="saved-secret-create-editor">
            <View style={styles.fields}>
                <FieldItem label={t('secrets.fields.name')}>
                    <FieldTextInput
                        testID="saved-secret-create-name"
                        value={name}
                        onChangeText={setName}
                        placeholder={t('secrets.placeholders.nameExample')}
                        accessibilityLabel={t('secrets.fields.name')}
                        editable={!busy}
                        autoFocus
                    />
                </FieldItem>
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
                {personalAvailable && sharedAvailable ? (
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
                    testID="saved-secret-create-submit"
                    title={t('secretsSettings.save')}
                    loading={busy}
                    disabled={busy || !name.trim() || value.length === 0}
                    onPress={() => { void submit(); }}
                />
                <RoundButton
                    testID="saved-secret-create-cancel"
                    display="secondary"
                    title={t('common.cancel')}
                    disabled={busy}
                    onPress={props.onCancel}
                />
            </View></RoundButtonSizeScope>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 14 },
    fields: { gap: 12, width: '100%' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    notice: { fontSize: 13, lineHeight: 18 },
}));
