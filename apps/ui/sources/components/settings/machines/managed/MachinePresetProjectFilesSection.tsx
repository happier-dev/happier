import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { useProjectFilesChoices } from '@/components/machines/projectFiles/projectFilesChoices';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
import {
  useWorkspaceContentPolicyRows,
  WorkspaceActivationContentPolicyRows,
} from '@/components/workspaces/activation/WorkspaceActivationEditor';
import {
  projectFilesOption,
  projectFilesOptionId,
  projectFilesValueForOption,
  type ProjectFilesOptionId,
} from '@/sync/domains/machines/projectFiles/projectFilesOptions';
import { t } from '@/text';

import { ManagedFieldRow } from './MachinePresetDetail';
import { presetGitHostingProviders, selectPresetGitHostingProvider, withPresetGitAccount } from './presetGitAccount';
import { holdsConnectedAccountForService } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { storage } from '@/sync/domains/state/storageStore';
import { SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID } from '@happier-dev/protocol/plugins/contributions/scmHostingProviders';
import { useDaemonScmContributionCatalog } from '@/scm/registry/useDaemonScmContributionCatalog';
import { useFirstConnection } from '@/components/projects/deployments/useFirstConnection';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';

/** One default policy object, so an unset preset's rows keep their identity across renders. */
const DEFAULT_CONTENT_POLICY = createDefaultWorkspaceContentPolicyV1();

/**
 * "Project files" on a preset (lab machine-sandboxes-1115 F1, round 4): one "How files get in" select, then the
 * chosen option's own settings as a group titled with its name. New Session can override it per session.
 */
export function MachinePresetProjectFilesSection(
  props: Readonly<{
    value: SessionProjectFilesV1 | undefined;
    serverId: string;
    /** The managing Machine, whose SCM hosting providers name the Git account a clone uses. */
    machineId: string | null;
    /** Absent for a viewer who cannot manage the preset: the rows stay legible, their controls dimmed. */
    onChange?: (next: SessionProjectFilesV1) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { value, onChange } = props;
  const option = projectFilesOption(value);
  const choices = useProjectFilesChoices();
  // An unset preset copies once with the default content policy; editing it stores that choice explicitly.
  const rows = useWorkspaceContentPolicyRows({
    policy:
      value?.kind === 'git_clone'
        ? null
        : (value?.contentPolicy ?? DEFAULT_CONTENT_POLICY),
    commitPatterns: 'endEditing',
    disabled: !onChange,
    testIdPrefix: `${props.testID}.content`,
    onChange: (contentPolicy) =>
      onChange?.(
        value && value.kind !== 'git_clone'
          ? { ...value, contentPolicy }
          : { kind: 'copy_once', contentPolicy },
      ),
  });
  const twoWay = projectFilesOptionId(value) === 'keep_both_in_sync';
  return (
    <>
      <ItemGroup
        testID={props.testID}
        title={t('machineDetailPage.projectFiles.title')}
        description={t('machineDetailPage.projectFiles.description')}
      >
        <ManagedFieldRow
          testID={`${props.testID}.how`}
          row={{
            title: t('machineDetailPage.projectFiles.how'),
            subtitle: t(option.subtitleKey),
            choices,
            value: option.id,
            disabled: !onChange,
            onChange: (id) => {
              const next = projectFilesValueForOption(
                id as ProjectFilesOptionId,
                value,
              );
              if (next && id !== projectFilesOptionId(value)) onChange?.(next);
            },
            // Only Two-way sync reaches back into the folder: one calm line says so (round 4 fix 3b).
            ...(twoWay
              ? {
                  note: (
                    <NoticeLine
                      testID={`${props.testID}.deletions`}
                      iconName="warning-circle"
                      wrap
                      iconColor={theme.colors.state.warning.foreground}
                      title={t(
                        'machineDetailPage.projectFiles.twoWayDeletions',
                      )}
                    />
                  ),
                }
              : {}),
          }}
        />
      </ItemGroup>
      <ItemGroup testID={`${props.testID}.option`} title={t(option.groupTitleKey)}>
        {value?.kind === 'git_clone' ? (
          <>
            {/* Unnamed, both come from the session's folder when it starts (lab F4); a named clone shows its own. */}
            <Item
              testID={`${props.testID}.repository`}
              title={t('machineDetailPage.projectFiles.repository')}
              subtitle={t('machineDetailPage.projectFiles.repositoryHelp')}
              detail={value.source?.repository.nameWithOwner ?? t('machineDetailPage.projectFiles.fromFolder')}
              wrapDetail
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
            <Item
              testID={`${props.testID}.branch`}
              title={t('machineDetailPage.projectFiles.branch')}
              subtitle={t('machineDetailPage.projectFiles.branchHelp')}
              detail={value.branch ?? t('machineDetailPage.projectFiles.folderBranch')}
              wrapDetail
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
            <PresetGitAccountRow serverId={props.serverId} machineId={props.machineId} value={value}
              onChange={onChange} testID={`${props.testID}.git-account`} />
          </>
        ) : (
          <>
            {twoWay ? (
              <Item
                testID={`${props.testID}.conflict`}
                title={t('machineDetailPage.projectFiles.conflict')}
                subtitle={t('machineDetailPage.projectFiles.conflictHelp')}
                subtitleLines={0}
                mode="info"
                showChevron={false}
              />
            ) : null}
            {rows ? <WorkspaceActivationContentPolicyRows {...rows} /> : null}
          </>
        )}
      </ItemGroup>
    </>
  );
}

/**
 * The Git account a clone uses (lab F4): the managing Machine's Git host's Connected services account, chosen with
 * the shared connected-account chooser. With none connected the row says why it is needed and opens the shared
 * Connect flow; the new account becomes this clone's. Happier keeps the credential; the agent never receives it.
 */
function PresetGitAccountRow(props: Readonly<{
  serverId: string;
  machineId: string | null;
  value: Extract<SessionProjectFilesV1, { kind: 'git_clone' }>;
  onChange?: (next: SessionProjectFilesV1) => void;
  testID: string;
}>) {
  const { value, onChange } = props;
  const catalog = useDaemonScmContributionCatalog({ machineId: props.machineId, serverId: props.serverId });
  const accounts = storage((state) => state.profile.connectedAccountsV4, GIT_ACCOUNT_INVENTORY_KEYS);
  // The host the row chose while no account is stored yet; a stored account names its own host.
  const [chosenHostId, setChosenHostId] = React.useState<string | null>(null);
  const hosts = presetGitHostingProviders(catalog.hostingProviders);
  const provider = selectPresetGitHostingProvider(catalog.hostingProviders, value.gitAccount, chosenHostId,
    service => holdsConnectedAccountForService(accounts ?? [], service));
  const firstConnection = useFirstConnection(null, provider?.authService ?? null,
    account => onChange?.(withPresetGitAccount(value, account)));
  if (!provider) return null;
  // Several hosts: the row chooses which one this clone signs in to (owner 09:24Z); changing it drops the old account.
  const hostRow = hosts.length > 1 ? (
    <ManagedFieldRow
      testID={`${props.testID}.host`}
      row={{
        title: t('machineDetailPage.projectFiles.gitHost'),
        choices: hosts.map(host => ({ id: host.id, title: host.title })),
        value: provider.id,
        disabled: !onChange,
        onChange: (id) => {
          if (id === provider.id) return;
          setChosenHostId(id);
          if (value.gitAccount) onChange?.(withPresetGitAccount(value, null));
        },
      }}
    />
  ) : null;
  if (firstConnection.missing && !value.gitAccount) {
    return (<>{hostRow}
      <Item
        testID={props.testID}
        title={provider.title}
        subtitle={t('machineDetailPage.projectFiles.gitAccountNeeded')}
        subtitleLines={0}
        mode="info"
        showChevron={false}
        rightElement={onChange ? (
          <SectionActionButton testID={`${props.testID}.connect`}
            title={t('machineDetailPage.projectFiles.connectGit', { service: provider.title })}
            onPress={() => { void firstConnection.connect(); }} />
        ) : undefined}
      />
    </>);
  }
  return (<>{hostRow}
    <ConnectedAccountPurposeTargetChooser
      testID={props.testID}
      localizedTextPluginId={provider.pluginId ?? provider.authService.pluginId}
      declaration={{ purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID, service: provider.authService, required: true }}
      title={provider.title}
      description={t('machineDetailPage.projectFiles.gitAccountCustody')}
      value={value.gitAccount ? { kind: 'account', account: value.gitAccount } : null}
      accountsOnly
      disabled={!onChange}
      onChange={next => onChange?.(withPresetGitAccount(value, next?.kind === 'account' ? next.account : null))}
    />
  </>);
}

/** The profile's connected accounts, read through the key-scoped subscription (as the shared Connect owner does). */
const GIT_ACCOUNT_INVENTORY_KEYS = { profile: ['connectedAccountsV4'], profileScope: true } as const;
