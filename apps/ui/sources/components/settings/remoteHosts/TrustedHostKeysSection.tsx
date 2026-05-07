import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { RemoteHostTrustedHostKeyRecord } from '@/sync/domains/remoteHosts/hostKeys/model';
import { getRemoteHostTrustedHostKeyStore } from '@/sync/domains/remoteHosts/hostKeys/trustedHostKeyStore';

function formatTrustedHostKeyTitle(record: RemoteHostTrustedHostKeyRecord): string {
    return `${record.hostLower}:${record.port}`;
}

function formatTrustedHostKeySubtitle(record: RemoteHostTrustedHostKeyRecord): string {
    return `${record.algorithm}\n${record.fingerprintSha256}`;
}

export const TrustedHostKeysSection = React.memo(function TrustedHostKeysSection() {
    const store = React.useMemo(() => getRemoteHostTrustedHostKeyStore(), []);
    const [records, setRecords] = React.useState<readonly RemoteHostTrustedHostKeyRecord[]>(() => store.readAll());
    const refresh = React.useCallback(() => {
        setRecords(store.readAll());
    }, [store]);

    if (records.length === 0) {
        return null;
    }

    return (
        <ItemGroup title={t('settings.remoteHostsTrustedHostKeysTitle')}>
            {records.map((record) => (
                <Item
                    key={`${record.hostLower}:${record.port}:${record.algorithm}`}
                    title={formatTrustedHostKeyTitle(record)}
                    subtitle={formatTrustedHostKeySubtitle(record)}
                    subtitleLines={0}
                    showChevron={false}
                    onPress={() => {
                        void (async () => {
                            const confirmed = await Modal.confirm(
                                t('settings.remoteHostsTrustedHostKeyRemoveTitle'),
                                formatTrustedHostKeyTitle(record),
                                {
                                    destructive: true,
                                    confirmText: t('common.remove'),
                                    cancelText: t('common.cancel'),
                                },
                            );
                            if (!confirmed) return;
                            store.delete({
                                host: record.hostLower,
                                port: record.port,
                                algorithm: record.algorithm,
                            });
                            refresh();
                        })();
                    }}
                />
            ))}
            <Item
                testID="settings.remoteHosts.trustedHostKeys.clear"
                title={t('settings.remoteHostsTrustedHostKeysClearTitle')}
                showChevron={false}
                onPress={() => {
                    void (async () => {
                        const confirmed = await Modal.confirm(
                            t('settings.remoteHostsTrustedHostKeysClearTitle'),
                            undefined,
                            {
                                destructive: true,
                                confirmText: t('common.remove'),
                                cancelText: t('common.cancel'),
                            },
                        );
                        if (!confirmed) return;
                        store.clear();
                        refresh();
                    })();
                }}
            />
        </ItemGroup>
    );
});
