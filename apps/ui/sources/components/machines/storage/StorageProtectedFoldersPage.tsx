import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { useMachineStorageCleanup } from '@/sync/domains/machines/storage/useMachineStorageCleanup';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { StoragePolicyNotice } from './StoragePolicyNotice';
import { StorageSayLine } from '@/components/storage/StorageSayLine';
import { StoragePageHead } from './StoragePageHead';
import { formatStorageDay } from './storageCategoryText';

const BUILT_IN = ['personal', 'checkouts', 'inUse', 'agentHomes'] as const;

/**
 * Protected folders (plan 40 STO-10/22, R42.1, lab `rs` SET 3 / SETp): what Happier keeps without being
 * asked — built in, and the folders added here. Kept means never suggested, never cleared by automation,
 * and clearing one by hand first names what is lost. Separately, the disk's top, system folders, the home
 * folder and Happier's own data are never cleared by anyone. Adding and removing are the storage Actions
 * on the machine's resources policy; recipients and an offline machine read the list.
 */
export const StorageProtectedFoldersPage = React.memo(
  function StorageProtectedFoldersPage(
    props: Readonly<{
      serverId: string;
      machineId: string;
      machineName: string;
      onBack: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const target = { machineId: props.machineId, serverId: props.serverId };
    const policy = useMachineResourcesPolicy(target);
    const cleanup = useMachineStorageCleanup(target);
    const facts = useMachineTabFacts(props.serverId, props.machineId);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [failed, setFailed] = React.useState(false);
    const folders = policy.policy?.storage.protectedFolders ?? [];
    const editable = policy.editable;
    const change = React.useCallback(
      (path: string, protect: boolean) => {
        setBusy(path);
        setFailed(false);
        fireAndForget(
          cleanup.setProtected(path, protect).then((result) => {
            setBusy(null);
            if (!result.ok) setFailed(true);
          }),
          { tag: 'StorageProtected.change' },
        );
      },
      [cleanup],
    );
    const add = React.useCallback(() => {
      fireAndForget((async () => {
        const path = await openMachinePathBrowserModal({ machineId: props.machineId, serverId: props.serverId,
          title: t('machineStorage.protectedFolders.addTitle'), initialPath: facts.homeDir ?? null, selectionMode: 'directory' });
        if (path) change(path, true);
      })(), { tag: 'StorageProtected.add' });
    }, [change, facts.homeDir, props.machineId, props.serverId]);
    const readOnly =
      policy.readOnlyReason === 'offline'
        ? t('machineStorage.tidy.readOnlyOffline', {
            machine: props.machineName,
          })
        : policy.readOnlyReason === 'not_custodian'
          ? t('machineStorage.tidy.readOnlyNotCustodian', {
              machine: props.machineName,
            })
          : null;
    return (
      <View testID="machine-storage-protected">
        <StoragePageHead title={t('machineStorage.protectedFolders.title')} onBack={props.onBack}>
          <StorageSayLine
            text={readOnly ?? t('machineStorage.protectedFolders.lead', { machine: props.machineName })}
          />
        </StoragePageHead>
        {policy.status !== 'ready' ? (
          <StoragePolicyNotice />
        ) : (
          <>
            <ItemGroup
              title={t('machineStorage.protectedFolders.builtInTitle')}
              description={t('machineStorage.protectedFolders.builtInDescription')}
            >
              {BUILT_IN.map((id, index) => (
                <Item
                  key={id}
                  testID={`machine-storage-protected-builtin-${id}`}
                  mode="info"
                  showChevron={false}
                  icon={
                    <Icon
                      name="lock"
                      size={18}
                      color={theme.colors.text.secondary}
                    />
                  }
                  title={t(`machineStorage.protectedFolders.builtIn.${id}.title`)}
                  subtitle={t(
                    `machineStorage.protectedFolders.builtIn.${id}.subtitle`,
                  )}
                  showDivider={index < BUILT_IN.length - 1}
                />
              ))}
            </ItemGroup>
            <ItemGroup
              title={t('machineStorage.protectedFolders.addedTitle')}
              description={failed ? t('machineStorage.tidy.saveFailed') : undefined}
              action={
                editable ? (
                  <TextLinkButton
                    testID="machine-storage-protected-add"
                    tone="strong"
                    label={t('machineStorage.protectedFolders.add')}
                    onPress={add}
                  />
                ) : undefined
              }
            >
              {folders.length === 0 ? (
                <Item
                  testID="machine-storage-protected-none"
                  mode="info"
                  showChevron={false}
                  title={t('machineStorage.protectedFolders.none')}
                />
              ) : (
                folders.map((folder, index) => (
                  <Item
                    key={folder.path}
                    testID={`machine-storage-protected-${index}`}
                    mode="info"
                    showChevron={false}
                    icon={
                      <Icon
                        name="folder"
                        size={18}
                        color={theme.colors.text.secondary}
                      />
                    }
                    title={
                      <Text style={styles.mono}>
                        {formatPathRelativeToHome(folder.path, facts.homeDir)}
                      </Text>
                    }
                    subtitle={t('machineStorage.protectedFolders.added', {
                      date: formatStorageDay(folder.addedAt),
                    })}
                    rightElement={
                      editable ? (
                        <RoundButton
                          testID={`machine-storage-protected-${index}-remove`}
                          size="small"
                          display="inverted"
                          title={t('machineStorage.protectedFolders.remove')}
                          loading={busy === folder.path}
                          onPress={() => change(folder.path, false)}
                        />
                      ) : undefined
                    }
                    showDivider={index < folders.length - 1}
                  />
                ))
              )}
            </ItemGroup>
            <ItemGroup header="none" surface="none">
              <Text style={styles.note}>
                {t('machineStorage.protectedFolders.forbiddenNote')}
              </Text>
            </ItemGroup>
          </>
        )}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  mono: {
    ...Typography.mono(),
    color: theme.colors.text.primary,
  },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
}));
