import React from 'react';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { fetchAccountSettingsHistory } from '@/sync/api/account/apiAccountSettingsHistory';
import {
    AccountSettingsHistoryRestoreInvalidError,
    AccountSettingsHistoryRestoreUnavailableError,
    restoreAccountSettingsFromHistorySnapshot,
} from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { storage } from '@/sync/domains/state/storageStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

function formatRecordedAt(value: string): string {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? formatWithCachedDateTimeFormatter(date, undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : value;
}

/**
 * The Account Settings history/restore surface inside the existing Account
 * settings screen. Restore is the one client-side classification-aware owner
 * (`restoreAccountSettingsFromHistorySnapshot`): it opens the recorded
 * envelope in its recorded mode, preserves untransferred current entity
 * sources, excludes opened active destinations, reseals to the current mode,
 * and submits through the ordinary
 * whole-document CAS. This section adds presentation only — no second
 * restore writer, router, or history store.
 */
export const SettingsHistorySection = React.memo(function SettingsHistorySection(params: Readonly<{
    credentials: AuthCredentials | null;
    encryption: Encryption | null;
    /** Injected by the enclosing `ItemGroup`: this section is one disclosure row of it. */
    showDivider?: boolean;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    const [snapshots, setSnapshots] = React.useState<Readonly<{ scope: AccountSettingsScope | null }> & (
        | Readonly<{ owner: AuthCredentials | null; status: 'loading' }>
        | Readonly<{ owner: AuthCredentials; status: 'empty' }>
        | Readonly<{ owner: AuthCredentials; status: 'unavailable' }>
        | Readonly<{ owner: AuthCredentials; status: 'ready'; versions: readonly number[]; recordedAtByVersion: ReadonlyMap<number, string> }>
    )>({ owner: null, scope: null, status: 'loading' });
    const [restoringVersion, setRestoringVersion] = React.useState<number | null>(null);
    const settingsScope = useAccountSettingsScope();
    const mountedRef = React.useRef(true);
    const credentialsRef = React.useRef(params.credentials);
    credentialsRef.current = params.credentials;

    const isCurrent = React.useCallback((credentials: AuthCredentials, scope: AccountSettingsScope) => (
        mountedRef.current
        && credentialsRef.current === credentials
        && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
    ), []);

    const refresh = React.useCallback(async (credentials: AuthCredentials, scope: AccountSettingsScope, signal?: AbortSignal) => {
        if (signal?.aborted || !isCurrent(credentials, scope)) return;
        const result = await fetchAccountSettingsHistory(credentials, { settingsScope: scope, signal });
        if (signal?.aborted || !isCurrent(credentials, scope)) return;
        if (result.status !== 'ready' || result.snapshots.length === 0) {
            setSnapshots(result.status !== 'ready'
                ? { owner: credentials, scope, status: 'unavailable' }
                : { owner: credentials, scope, status: 'empty' });
            return;
        }
        // Newest first: restore goes back to a previous point in time.
        const ordered = [...result.snapshots].sort((left, right) => right.version - left.version);
        setSnapshots({
            owner: credentials,
            scope,
            status: 'ready',
            versions: ordered.map((snapshot) => snapshot.version),
            recordedAtByVersion: new Map(ordered.map((snapshot) => [snapshot.version, snapshot.createdAt])),
        });
    }, [isCurrent]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        const credentials = params.credentials;
        setRestoringVersion(null);
        if (!credentials || !settingsScope) {
            setSnapshots({ owner: null, scope: settingsScope, status: 'loading' });
            return;
        }
        const controller = new AbortController();
        setSnapshots({ owner: credentials, scope: settingsScope, status: 'loading' });
        void refresh(credentials, settingsScope, controller.signal);
        return () => controller.abort();
    }, [params.credentials, settingsScope, refresh]);

    if (!params.credentials) return null;
    const visibleSnapshots = snapshots.owner === params.credentials
        && areAccountSettingsScopesEqual(snapshots.scope, settingsScope)
        ? snapshots
        : { owner: params.credentials, status: 'loading' as const };

    const handleRestore = (historyVersion: number): void => {
        void (async () => {
            const credentials = params.credentials;
            const expectedSettingsScope = settingsScope;
            if (!credentials || !expectedSettingsScope) return;
            const confirmed = await Modal.confirm(
                t('settingsAccount.history.restoreConfirmTitle'),
                t('settingsAccount.history.restoreConfirmBody'),
                { confirmText: t('settingsAccount.history.restoreConfirmAction'), destructive: true },
            );
            if (
                !confirmed
                || !isCurrent(credentials, expectedSettingsScope)
            ) return;
            // Read at press time: the version being replaced is the current one.
            const expectedSettingsVersion = storage.getState().settingsVersion ?? 0;
            setRestoringVersion(historyVersion);
            try {
                const result = await restoreAccountSettingsFromHistorySnapshot({
                    credentials,
                    encryption: params.encryption,
                    settingsScope: expectedSettingsScope,
                    historyVersion,
                    expectedSettingsVersion,
                });
                if (!isCurrent(credentials, expectedSettingsScope)) return;
                if (result.status === 'conflict') {
                    await Modal.alert(
                        t('settingsAccount.history.conflictTitle'),
                        t('settingsAccount.history.conflictBody', { currentVersion: String(result.currentSettingsVersion) }),
                    );
                    return;
                }
                if (result.status === 'outcomeUnknown') {
                    await Modal.alert(
                        t('common.error'),
                        t('settingsAccount.history.outcomeUnknownBody'),
                    );
                    return;
                }
                await Modal.alert(
                    t('settingsAccount.history.restoredTitle'),
                    t(result.status === 'unchanged'
                        ? 'settingsAccount.history.unchangedBody'
                        : 'settingsAccount.history.restoredBody'),
                );
            } catch (error) {
                if (!isCurrent(credentials, expectedSettingsScope)) return;
                if (error instanceof AccountSettingsHistoryRestoreInvalidError) {
                    await Modal.alert(
                        t('common.error'),
                        t('settingsAccount.history.invalidBody'),
                    );
                    return;
                }
                if (error instanceof AccountSettingsHistoryRestoreUnavailableError) {
                    await Modal.alert(
                        t('common.error'),
                        t('settingsAccount.history.unavailableBody'),
                    );
                    return;
                }
                await Modal.alert(t('common.error'), t('settingsAccount.history.unavailableBody'));
            } finally {
                if (isCurrent(credentials, expectedSettingsScope)) {
                    setRestoringVersion(null);
                    void refresh(credentials, expectedSettingsScope);
                }
            }
        })();
    };

    const newestVersion = visibleSnapshots.status === 'ready' ? visibleSnapshots.versions[0] : undefined;
    const newestRecordedAt = newestVersion === undefined || visibleSnapshots.status !== 'ready'
        ? undefined
        : visibleSnapshots.recordedAtByVersion.get(newestVersion);
    const summary = visibleSnapshots.status === 'ready'
        ? t('settingsAccount.history.summary', {
            count: visibleSnapshots.versions.length,
            latest: newestRecordedAt ? formatRecordedAt(newestRecordedAt) : String(newestVersion),
        })
        : visibleSnapshots.status === 'empty'
            ? t('settingsAccount.history.empty')
            : visibleSnapshots.status === 'unavailable'
                ? t('settingsAccount.history.unavailable')
                : t('settingsAccount.history.loading');

    return (
        <ExpandableItem
            testID="settings-account-history"
            expanded={expanded}
            onExpandedChange={setExpanded}
            showDivider={params.showDivider}
            header={({ headerProps }) => (
                <Item
                    {...headerProps}
                    title={t('settingsAccount.history.title')}
                    subtitle={summary}
                />
            )}
        >
            <SectionContentRow>
                <Text style={styles.explanation}>{t('settingsAccount.history.footer')}</Text>
            </SectionContentRow>
            {visibleSnapshots.status === 'loading' ? (
                <Item title={t('settingsAccount.history.loading')} showChevron={false} />
            ) : null}
            {visibleSnapshots.status === 'empty' ? (
                <Item title={t('settingsAccount.history.empty')} showChevron={false} />
            ) : null}
            {visibleSnapshots.status === 'unavailable' ? (
                <Item title={t('settingsAccount.history.unavailable')} showChevron={false} />
            ) : null}
            {visibleSnapshots.status === 'ready' ? visibleSnapshots.versions.map((version) => {
                const recordedAt = visibleSnapshots.recordedAtByVersion.get(version);
                return (
                    <Item
                        key={version}
                        testID={`settings-account-history-restore-${version}`}
                        title={t('settingsAccount.history.entryTitle', { version: String(version) })}
                        subtitle={recordedAt
                            ? t('settingsAccount.history.entrySubtitle', { recordedAt: formatRecordedAt(recordedAt) })
                            : undefined}
                        loading={restoringVersion === version}
                        disabled={restoringVersion !== null}
                        accessibilityLabel={t('settingsAccount.history.entryTitle', { version: String(version) })}
                        accessibilityHint={t('settingsAccount.history.restoreConfirmBody')}
                        accessibilityRole="button"
                        onPress={() => handleRestore(version)}
                        showChevron={false}
                    />
                );
            }) : null}
        </ExpandableItem>
    );
});

const styles = StyleSheet.create((theme) => ({
    explanation: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));
