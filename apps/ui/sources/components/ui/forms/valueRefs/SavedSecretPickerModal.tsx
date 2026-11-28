import * as React from 'react';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SavedSecretChoiceList, type SavedSecretChoiceRow } from '@/components/secrets/SavedSecretChoiceList';
import { SavedSecretCreateEditor } from '@/components/secrets/SavedSecretCreateEditor';
import { sharedSecretStatusLabel } from '@/components/secrets/savedSecretRowCopy';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { SharedSavedSecretReferenceSelectionV1Schema, type SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    /** The source editor's captured Home, retained when this modal stays mounted. */
    scope: AccountSettingsScope | null;
    secretPurpose?: string;
    referenceSelection: Readonly<{
        selected: SharedSavedSecretReferenceSelectionV1 | null;
        onSelect: (selection: SharedSavedSecretReferenceSelectionV1) => void;
    }>;
}>;

/**
 * The saved-secret picker's body: the shared secrets this Account can bind, by name, in the one choice list, and the one
 * Saved Secret create form for when the one it needs doesn't exist yet. Rename, replace and delete live in Saved Secrets.
 */
export function SavedSecretPickerModal(props: SavedSecretPickerModalProps) {
    const { onSelect } = props.referenceSelection;
    const { onClose } = props;
    const select = React.useCallback((selection: SharedSavedSecretReferenceSelectionV1) => {
        onSelect(selection);
        onClose();
    }, [onSelect, onClose]);
    return (
        <View style={styles.body} testID="saved-secret-picker">
            <SavedSecretReferenceChoice
                scope={props.scope}
                secretPurpose={props.secretPurpose}
                selectedRef={props.referenceSelection.selected?.ref ?? null}
                onSelect={select}
                onCancel={onClose}
                testIDPrefix="saved-secret-picker"
            />
        </View>
    );
}

type ChoiceMode = 'saved' | 'new';

/**
 * The saved-secret choice over this Account's catalog, shared by the picker sheet and plugin surfaces. Only a ready
 * secret can be pressed; one still preparing or out of reach stays listed with its status. Pressing returns its
 * exact reference and current revision, never material. A secret that doesn't exist yet is created here through the
 * one Saved Secret create form (as the Connect sheet does) and chosen once the catalog has it: "No matches" is never a
 * dead end (PAGE-ACCEPT-176 R14-D6).
 */
export function SavedSecretReferenceChoice(props: Readonly<{
    scope: AccountSettingsScope | null;
    selectedRef: string | null;
    secretPurpose?: string;
    connectionStringLabel?: string;
    onSelect: (selection: SharedSavedSecretReferenceSelectionV1) => void;
    /** Leaves the choice (the picker sheet closes); the create form's Cancel when there is no saved list to go back to. */
    onCancel?: () => void;
    testIDPrefix: string;
}>) {
    const catalog = useSavedSecretCatalog({ scope: props.scope, includeMaterial: false });
    const stale = catalog.status === 'error' || (catalog.status === 'ready' && catalog.stale);
    // The same entries the Connect sheet's Saved tab lists: every named secret this Account can bind by reference.
    const rows = React.useMemo((): readonly SavedSecretChoiceRow[] => catalog.entries.flatMap((entry) => {
        const resolution = catalog.resolveReference(entry.ref);
        if (entry.name === null || resolution.kind !== 'shared_resource') return [];
        const status = resolution.status;
        const ready = status === 'ready' && !stale;
        return [{ entry, disabled: !ready, note: resolution.resolving && status === 'temporarily_unavailable' ? t('common.loading')
            : status === 'ready' ? null : resolveActionExecutionErrorMessage(resolution.errorCause, sharedSecretStatusLabel(status), { safeToRetry: true }) }];
    }), [catalog.entries, catalog.resolveReference, stale]);
    const retry = React.useCallback(() => {
        void catalog.reload().catch(() => {});
    }, [catalog.reload]);
    const { onSelect } = props;
    const choose = React.useCallback((ref: string) => {
        const resolution = catalog.resolveReference(ref);
        if (resolution.kind !== 'shared_resource' || resolution.status !== 'ready') return false;
        const selection = SharedSavedSecretReferenceSelectionV1Schema.safeParse({ ref, resourceRevision: resolution.revision });
        if (!selection.success) return false;
        onSelect(selection.data);
        return true;
    }, [catalog.resolveReference, onSelect]);
    const prefix = props.testIDPrefix;
    const router = useRouter();
    const scope = props.scope;
    const approval = useActionApprovalContinuation({
        scopeKey: scope ? `${scope.serverId}:${scope.accountId}` : 'unbound:saved-secret-picker',
        serverId: scope?.serverId ?? '',
        onExecuted: retry,
    });
    const approvalId = approval.approvalId;
    // With nothing saved yet, the form is the way in; with saved secrets, it is one tab away.
    const [chosenMode, setChosenMode] = React.useState<ChoiceMode | null>(null);
    const mode: ChoiceMode = rows.length === 0 && !stale ? 'new' : chosenMode ?? 'saved';
    // A new secret is chosen as soon as the catalog reads it ready, with the revision the reference needs.
    const [createdRef, setCreatedRef] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (createdRef !== null && choose(createdRef)) {
            setCreatedRef(null);
            setChosenMode('saved');
        }
    }, [createdRef, choose, catalog.entries]);
    const tabs = React.useMemo(() => [
        { id: 'saved' as const, label: t('secrets.savedTitle') },
        { id: 'new' as const, label: t('secrets.addTitle') },
    ], []);

    // Known rows stay while the catalog refreshes; the line holds the place only before the first answer.
    if (catalog.status === 'loading' && rows.length === 0) {
        return <SurfaceStateCard testID={`${prefix}:loading`} size="line" kind="loading" title={t('common.loading')} />;
    }
    const create = (
        <SavedSecretCreateEditor
            scope={scope}
            presentation="sheet"
            namePlaceholder={props.secretPurpose}
            valueLabel={props.connectionStringLabel}
            fixedKind={props.connectionStringLabel ? 'other' : undefined}
            onCreatePersonal={catalog.personalMutations.create}
            sharedAvailable={catalog.sharedEnabled}
            approvalPending={approval.approvalPending}
            approvalId={approvalId}
            requestApproval={approval.requestApproval}
            onOpenApproval={approvalId && scope ? () => router.pushRetainingCurrent(
                `/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(scope.serverId)}`) : undefined}
            onCancel={props.connectionStringLabel ? undefined : rows.length > 0 || stale ? () => setChosenMode('saved') : props.onCancel}
            onCreated={(ref) => {
                setCreatedRef(ref);
                retry();
            }}
        />
    );
    return (
        <>
            {rows.length > 0 || stale ? (
                <SegmentedTabBar
                    role="radiogroup"
                    labelSize="field"
                    segmentSizing="equal"
                    accessibilityLabel={t('secrets.addTitle')}
                    tabs={tabs}
                    activeTabId={mode}
                    onSelectTab={setChosenMode}
                    testIDPrefix={`${prefix}:mode`}
                />
            ) : null}
            {mode === 'new' ? <ScrollView testID={`${prefix}:new`} style={styles.create} keyboardShouldPersistTaps="handled">
                {create}</ScrollView> : (
        <SavedSecretChoiceList
            rows={rows}
            referenceCommands
            selectedRef={props.selectedRef}
            onChoose={(ref) => { choose(ref); }}
            testIDPrefix={prefix}
            notice={stale ? (
                <SurfaceStateCard
                    testID={`${prefix}:stale`}
                    size="line"
                    kind="unavailable"
                    title={resolveActionExecutionErrorMessage(catalog.errorCause, t('secrets.catalog.operationFailed'), { safeToRetry: true })}
                    action={{ label: t('common.retry'), onPress: retry, testID: `${prefix}:retry` }}
                />
            ) : null}
        />
            )}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The anchored sheet bounds the height; the search stays and the rows scroll under it.
    body: {
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s16,
        flexShrink: 1,
        minHeight: 0,
    },
    // The form scrolls under the tabs inside the sheet's bound, as the Connect sheet's does.
    create: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
}));
