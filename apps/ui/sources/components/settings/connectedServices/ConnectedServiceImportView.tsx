import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectedServiceIdSchema, type ConnectedServiceImportParams } from '@happier-dev/protocol';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Text, TextInput } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useAllMachines } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { sync } from '@/sync/sync';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { importConnectedServiceLogin } from '@/sync/ops/connectedServices/importConnectedServiceLogin';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import { fireAndForget } from '@/utils/system/fireAndForget';

function stringParam(value: unknown): string {
    return typeof value === 'string' ? value.trim() : Array.isArray(value) ? stringParam(value[0]) : '';
}

export const ConnectedServiceImportView = React.memo(function ConnectedServiceImportView() {
    const params = useLocalSearchParams();
    const router = useRouter();
    const { theme } = useUnistyles();
    const enabled = useFeatureEnabled('connectedServices');
    const machines = useAllMachines();
    const parsed = ConnectedServiceIdSchema.safeParse(stringParam(params.serviceId));
    const serviceId = parsed.success ? parsed.data : null;
    const profileId = stringParam(params.profileId);
    const sources = serviceId ? getConnectedServiceRegistryEntry(serviceId).importSources ?? [] : [];
    const [machineId, setMachineId] = React.useState('');
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [source, setSource] = React.useState<'acp' | 'cli'>('acp');
    const [projectId, setProjectId] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const selectedMachine = machines.find((machine) => machine.id === machineId);
    const canImport = Boolean(enabled && selectedMachine && isMachineOnline(selectedMachine) && profileId && sources.includes(source));

    const submit = async () => {
        if (!canImport || busy || !serviceId) return;
        setBusy(true);
        try {
            const result = await importConnectedServiceLogin({
                serverId: getActiveServerSnapshot().serverId,
                machineId,
                request: { serviceId, profileId, source, ...(projectId.trim() ? { projectId: projectId.trim() } : {}) } as ConnectedServiceImportParams,
            });
            if (!result.success) {
                if (result.errorCode === 'storage_result_unknown') {
                    // A refresh failure must not turn an unknown write into a retryable import error.
                    await sync.refreshProfile().catch(() => undefined);
                    invalidateConnectedServiceGroupsRefreshSignal();
                    await Modal.alert(t('common.error'), t('connectedServices.importAccounts.unknownResult'));
                    return;
                }
                await Modal.alert(t('common.error'), result.errorCode === 'unsupported'
                    ? t('connectedServices.importAccounts.unsupported')
                    : result.errorCode === 'project_required'
                        ? t('connectedServices.importAccounts.projectRequired')
                        : result.errorCode === 'account_ineligible'
                            ? t('connectedServices.importAccounts.accountIneligible')
                        : t('connectedServices.importAccounts.failed'));
                return;
            }
            await sync.refreshProfile();
            invalidateConnectedServiceGroupsRefreshSignal();
            if (result.requiresBrowserReauthorization) {
                await Modal.alert(t('connectedServices.importAccounts.reauthorizeTitle'), t('connectedServices.importAccounts.reauthorizeBody'));
                router.replace({ pathname: '/settings/connected-services/oauth', params: { serviceId, profileId, method: 'paste' } });
            } else {
                router.back();
            }
        } catch {
            await Modal.alert(t('common.error'), t('connectedServices.importAccounts.failed'));
        } finally {
            setBusy(false);
        }
    };

    if (!enabled || !serviceId || !profileId || !sources.length) {
        return <ItemList><ItemGroup><Item title={t('connectedServices.oauthPaste.invalidConfig')} showChevron={false} /></ItemGroup></ItemList>;
    }

    return (
        <ItemList keyboardAware keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('connectedServices.importAccounts.title')} footer={t('connectedServices.importAccounts.description')}>
                <DropdownMenu
                    open={machineMenuOpen} onOpenChange={setMachineMenuOpen} selectedId={machineId}
                    items={machines.map((machine) => ({ id: machine.id, title: getMachineDisplayName(machine) ?? machine.id, disabled: !isMachineOnline(machine) }))}
                    onSelect={(id) => { setMachineId(id); setMachineMenuOpen(false); }}
                    itemTrigger={{ title: t('newSession.selectMachineTitle'), subtitle: selectedMachine ? getMachineDisplayName(selectedMachine) ?? undefined : t('newSession.noMachineSelected') }}
                />
                {sources.map((value) => <Item
                    key={value} testID={`connectedServices.import.source:${value}`}
                    title={value === 'acp' ? t('connectedServices.importAccounts.acpLogin') : t('connectedServices.importAccounts.cliLogin')}
                    selected={source === value} onPress={busy ? undefined : () => setSource(value)}
                    showChevron={false}
                />)}
                <View style={{ padding: 16 }}>
                    <Text>{t('connectedServices.importAccounts.projectLabel')}</Text>
                    <TextInput testID="connectedServices.import.projectInput" value={projectId} onChangeText={setProjectId}
                        editable={!busy} autoCapitalize="none" autoCorrect={false}
                        style={{ color: theme.colors.input.text, backgroundColor: theme.colors.input.background, padding: 12 }}
                        accessibilityLabel={t('connectedServices.importAccounts.projectLabel')} />
                    <RoundButton testID="connectedServices.import.submit" title={busy ? t('common.loading') : t('connectedServices.importAccounts.title')}
                        disabled={!canImport || busy} onPress={() => fireAndForget(submit(), { tag: 'ConnectedServiceImportView.submit' })} />
                </View>
            </ItemGroup>
        </ItemList>
    );
});
