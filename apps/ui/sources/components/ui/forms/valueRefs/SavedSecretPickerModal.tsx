import * as React from 'react';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { SavedSecretChoiceList, type SavedSecretChoiceRow } from '@/components/secrets/SavedSecretChoiceList';
import { sharedSecretStatusLabel } from '@/components/secrets/savedSecretRowCopy';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { SharedSavedSecretReferenceSelectionV1Schema, type SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    /** The source editor's captured Home, retained when this modal stays mounted. */
    scope: AccountSettingsScope | null;
    referenceSelection: Readonly<{
        selected: SharedSavedSecretReferenceSelectionV1 | null;
        onSelect: (selection: SharedSavedSecretReferenceSelectionV1) => void;
    }>;
}>;

/**
 * The saved-secret picker's body: the shared secrets this Account can bind, by name, in the one choice list.
 * Only a ready secret can be pressed; one still preparing or out of reach stays listed with its status. Pressing
 * returns its exact reference and current revision, never material. Management (add, rename, replace, delete)
 * lives in Saved Secrets, not here.
 */
export function SavedSecretPickerModal(props: SavedSecretPickerModalProps) {
    const catalog = useSavedSecretCatalog({ scope: props.scope, includeMaterial: false });
    const stale = catalog.status === 'error' || (catalog.status === 'ready' && catalog.stale);
    // The same entries the Connect sheet's Saved tab lists: every named secret this Account can bind by reference.
    const rows = React.useMemo((): readonly SavedSecretChoiceRow[] => catalog.entries.flatMap((entry) => {
        const resolution = catalog.resolveReference(entry.ref);
        if (entry.name === null || resolution.kind !== 'shared_resource') return [];
        const status = resolution.status;
        const ready = status === 'ready' && !stale;
        return [{ entry, disabled: !ready, note: status === 'ready' ? null : resolveActionExecutionErrorMessage(resolution.errorCause, sharedSecretStatusLabel(status), { safeToRetry: true }) }];
    }), [catalog.entries, catalog.resolveReference, stale]);
    const retry = React.useCallback(() => {
        void catalog.reload().catch(() => {});
    }, [catalog.reload]);
    const choose = (ref: string) => {
        const resolution = catalog.resolveReference(ref);
        if (resolution.kind !== 'shared_resource' || resolution.status !== 'ready') return;
        const selection = SharedSavedSecretReferenceSelectionV1Schema.safeParse({ ref, resourceRevision: resolution.revision });
        if (!selection.success) return;
        props.referenceSelection.onSelect(selection.data);
        props.onClose();
    };

    // Known rows stay while the catalog refreshes; the line holds the place only before the first answer.
    if (catalog.status === 'loading' && rows.length === 0) {
        return (
            <View style={styles.body}>
                <SurfaceStateCard testID="saved-secret-picker:loading" size="line" kind="loading" title={t('common.loading')} />
            </View>
        );
    }
    return (
        <View style={styles.body} testID="saved-secret-picker">
            <SavedSecretChoiceList
                rows={rows}
                selectedRef={props.referenceSelection.selected?.ref ?? null}
                onChoose={choose}
                testIDPrefix="saved-secret-picker"
                notice={stale ? (
                    <SurfaceStateCard
                        testID="saved-secret-picker:stale"
                        size="line"
                        kind="unavailable"
                        title={resolveActionExecutionErrorMessage(catalog.errorCause, t('secrets.catalog.operationFailed'), { safeToRetry: true })}
                        action={{ label: t('common.retry'), onPress: retry, testID: 'saved-secret-picker:retry' }}
                    />
                ) : null}
            />
        </View>
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
}));
