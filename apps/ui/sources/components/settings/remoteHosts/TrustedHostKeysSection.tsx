import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { RemoteHostTrustedHostKeyRecord } from '@/sync/domains/remoteHosts/hostKeys/model';
import { getRemoteHostTrustedHostKeyStore } from '@/sync/domains/remoteHosts/hostKeys/trustedHostKeyStore';
import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';

import { REMOTE_HOSTS_ACCESS_SETTINGS } from './remoteHostsSettings';

function formatTrustedHostKeyTitle(record: RemoteHostTrustedHostKeyRecord): string {
    return `${record.hostLower}:${record.port}`;
}

function formatTrustedHostKeySubtitle(record: RemoteHostTrustedHostKeyRecord): string {
    return `${record.algorithm}\n${record.fingerprintSha256}`;
}

export const TrustedHostKeysSection = React.memo(function TrustedHostKeysSection() {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(scope);
    const store = React.useMemo(() => getRemoteHostTrustedHostKeyStore(), []);
    const [records, setRecords] = React.useState<readonly RemoteHostTrustedHostKeyRecord[]>(() => store.readAll());
    const refresh = React.useCallback(() => {
        setRecords(store.readAll());
    }, [store]);
    const remove = async (input: { key: { host: string; port: number; algorithm: string; fingerprintSha256: string } } | { keys: { host: string; port: number; algorithm: string; fingerprintSha256: string }[] }) => {
        try {
            const id = 'key' in input ? 'remote_hosts.trusted_keys.remove' : 'remote_hosts.trusted_keys.clear';
            const result = await execution.executeForPresentation(id, input);
            if (!result) return;
            if (!result.ok) {
                Modal.alert(t('common.error'), resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed'));
                return;
            }
            const receipt = REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1[id].parse(result.result);
            if (receipt.status === 'removed') {
                refresh();
            } else if (receipt.status === 'conflict' || (receipt.status === 'unavailable'
                && (receipt.reason === 'trusted_host_key_changed' || receipt.reason === 'trusted_host_keys_changed'))) {
                refresh();
                Modal.alert(t('common.error'), t('approvals.conflictFailure'));
            } else {
                const code = receipt.status === 'unavailable' ? receipt.reason : receipt.status;
                Modal.alert(t('common.error'), resolveActionExecutionErrorMessage({ code }, t('common.requestFailed')));
            }
        } catch (error) {
            if (execution.isCurrent()) Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('common.requestFailed')));
        }
    };
    const keyInput = (record: RemoteHostTrustedHostKeyRecord) => ({ host: record.hostLower, port: record.port,
        algorithm: record.algorithm, fingerprintSha256: record.fingerprintSha256 });

    // With no keys the section stays, empty, so a search for "Clear trusted host keys" lands on it.
    if (records.length === 0) {
        return (
            <SettingSection section={REMOTE_HOSTS_ACCESS_SETTINGS.sectionRefs.trustedHostKeys}>
                <ItemGroup
                    title={t('settings.remoteHostsTrustedHostKeysTitle')}
                    description={t('settingsRemoteHostsPage.trustedHostKeysDescription')}
                >
                    <Item
                        testID="settings.remoteHosts.trustedHostKeys.empty"
                        title={t('settingsRemoteHostsPage.trustedHostKeysEmpty')}
                        titleLines={0}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </SettingSection>
        );
    }

    return (
        <ItemGroup
            title={t('settings.remoteHostsTrustedHostKeysTitle')}
            description={t('settingsRemoteHostsPage.trustedHostKeysDescription')}
        >
            {execution.approval.approvalPending && execution.approval.approvalId && scope ? <ActionApprovalPendingNotice
                message={t('approvals.title')} onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(execution.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
            {records.map((record) => (
                <Item
                    key={`${record.hostLower}:${record.port}:${record.algorithm}`}
                    title={formatTrustedHostKeyTitle(record)}
                    subtitle={formatTrustedHostKeySubtitle(record)}
                    subtitleLines={0}
                    showChevron={false}
                    onPress={() => {
                        void remove({ key: keyInput(record) });
                    }}
                />
            ))}
            <SettingRow
                testID="settings.remoteHosts.trustedHostKeys.clear"
                setting={REMOTE_HOSTS_ACCESS_SETTINGS.settings.clearTrustedHostKeys}
                destructive
                showChevron={false}
                onPress={() => {
                    void remove({ keys: records.map(keyInput) });
                }}
            />
        </ItemGroup>
    );
});
