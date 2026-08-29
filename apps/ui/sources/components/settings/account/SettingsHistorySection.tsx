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
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
 * envelope in its recorded mode, keeps every current secret/binding/legacy
 * root, reseals to the current mode, and submits through the ordinary
 * whole-document CAS. This section adds presentation only — no second
 * restore writer, router, or history store.
 */
export const SettingsHistorySection = React.memo(function SettingsHistorySection(params: Readonly<{
    credentials: AuthCredentials | null;
    encryption: Encryption | null;
}>) {
    const [snapshots, setSnapshots] = React.useState<
        | Readonly<{ owner: AuthCredentials | null; status: 'loading' }>
        | Readonly<{ owner: AuthCredentials; status: 'empty' }>
        | Readonly<{ owner: AuthCredentials; status: 'unavailable' }>
        | Readonly<{ owner: AuthCredentials; status: 'ready'; versions: readonly number[]; recordedAtByVersion: ReadonlyMap<number, string> }>
    >({ owner: null, status: 'loading' });
    const [restoringVersion, setRestoringVersion] = React.useState<number | null>(null);
    const mountedRef = React.useRef(true);
    const credentialsRef = React.useRef(params.credentials);
    credentialsRef.current = params.credentials;

    const refresh = React.useCallback(async (credentials: AuthCredentials, signal?: AbortSignal) => {
        const result = await fetchAccountSettingsHistory(credentials, { signal });
        if (signal?.aborted || !mountedRef.current || credentialsRef.current !== credentials) return;
        if (result.status !== 'ready' || result.snapshots.length === 0) {
            setSnapshots(result.status !== 'ready'
                ? { owner: credentials, status: 'unavailable' }
                : { owner: credentials, status: 'empty' });
            return;
        }
        // Newest first: restore goes back to a previous point in time.
        const ordered = [...result.snapshots].sort((left, right) => right.version - left.version);
        setSnapshots({
            owner: credentials,
            status: 'ready',
            versions: ordered.map((snapshot) => snapshot.version),
            recordedAtByVersion: new Map(ordered.map((snapshot) => [snapshot.version, snapshot.createdAt])),
        });
    }, []);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        const credentials = params.credentials;
        setRestoringVersion(null);
        if (!credentials) {
            setSnapshots({ owner: null, status: 'loading' });
            return;
        }
        const controller = new AbortController();
        setSnapshots({ owner: credentials, status: 'loading' });
        void refresh(credentials, controller.signal);
        return () => controller.abort();
    }, [params.credentials, refresh]);

    if (!params.credentials) return null;
    const visibleSnapshots = snapshots.owner === params.credentials
        ? snapshots
        : { owner: params.credentials, status: 'loading' as const };

    const handleRestore = (historyVersion: number): void => {
        void (async () => {
            const credentials = params.credentials;
            if (!credentials) return;
            const confirmed = await Modal.confirm(
                t('settingsAccount.history.restoreConfirmTitle'),
                t('settingsAccount.history.restoreConfirmBody'),
                { confirmText: t('settingsAccount.history.restoreConfirmAction'), destructive: true },
            );
            if (!confirmed || !mountedRef.current || credentialsRef.current !== credentials) return;
            // Read at press time: the version being replaced is the current one.
            const expectedSettingsVersion = storage.getState().settingsVersion ?? 0;
            setRestoringVersion(historyVersion);
            try {
                const result = await restoreAccountSettingsFromHistorySnapshot({
                    credentials,
                    encryption: params.encryption,
                    historyVersion,
                    expectedSettingsVersion,
                });
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
                if (mountedRef.current && credentialsRef.current === credentials) {
                    setRestoringVersion(null);
                    void refresh(credentials);
                }
            }
        })();
    };

    return (
        <ItemGroup
            title={t('settingsAccount.history.title')}
            footer={t('settingsAccount.history.footer')}
        >
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
        </ItemGroup>
    );
});
