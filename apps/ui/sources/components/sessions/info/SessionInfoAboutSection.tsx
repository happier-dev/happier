import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { buildSessionDebugInformationForSession } from '@/components/sessions/debug/sessionDebugInformation';
import { stringifySessionDebugJson } from '@/components/sessions/debug/sessionDebugRedaction';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useMachinePoolOriginName } from '@/sync/engine/machines/useMachinePoolOriginName';
import type { MachinePoolProjectionMachine } from '@/sync/engine/machines/useMachinePoolProjections';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { t } from '@/text';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import {
  formatOSPlatform,
  formatPathRelativeToHome,
} from '@/utils/sessions/sessionUtils';
import {
  getAttachCommandForSession,
  getTmuxFallbackReason,
  getTmuxTargetForSession,
} from '@/utils/sessions/terminalSessionDetails';
import type { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useSessionInfoDisclosureCommands } from './useSessionInfoDisclosureCommands';

type SessionInfoMetadata = ReturnType<typeof readSessionOwnerMetadataView>;

/** An id reads by its two ends: the start to recognise it, the end to tell it from its neighbours. */
function middleTruncate(value: string, keep = 6): string {
  return value.length > keep * 2 + 1
    ? `${value.slice(0, keep)}…${value.slice(-keep)}`
    : value;
}

type Fact = Readonly<{ key: string; node: React.ReactElement }>;

/**
 * About (P2 §4, rows 35–46 and 50/53): every identifying and diagnostic fact of the Session as one
 * aligned value column — mono only for ids, paths and commands, each with copy. The facts a person
 * reaches for lead; the rest open through one disclosure whose count is the facts it actually holds.
 */
export const SessionInfoAboutSection = React.memo(
  function SessionInfoAboutSection(
    props: Readonly<{
      session: Session;
      metadata: SessionInfoMetadata;
      serverId: string;
      agentId: string | null;
      agentTitle: string | null;
      providerDisplayName: string;
      isConnected: boolean;
      isCliOutdated: boolean;
      vendorResumeId: string | null;
      vendorResumeLabel: string | null;
      executionMachineId: string | null;
      executionMachineLabel: string | null;
      machineList: readonly MachinePoolProjectionMachine[] | undefined;
      showUsage: boolean;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { session, metadata } = props;
    const useProfiles = useSetting('useProfiles') === true;
    const profiles = useAiLaunchProfilesForLegacyUi();
    const [moreExpanded, setMoreExpanded] = React.useState(false);
    const toggleMore = React.useCallback(() => setMoreExpanded(current => !current), []);
    const openUsage = React.useCallback(() => router.push(buildScopedSessionRouteHref({
      sessionId: props.session.id, serverId: props.serverId, suffix: '/usage',
    }) as never), [props.serverId, props.session.id, router]);
    const [privateFolderExpanded, setPrivateFolderExpanded] =
      React.useState(false);
    const mono = styles.mono;
    const formatDate = (timestamp: number) =>
      new Date(timestamp).toLocaleString();

    const profileLabel = React.useMemo(() => {
      const profileId = metadata?.profileId;
      if (profileId === null || profileId === '')
        return t('profiles.noProfile');
      if (typeof profileId !== 'string') return t('status.unknown');
      const resolved = resolveProfileById(profileId, profiles);
      return resolved ? getProfileDisplayName(resolved) : t('status.unknown');
    }, [metadata?.profileId, profiles]);
    const attachCommand = getAttachCommandForSession({
      sessionId: session.id,
      terminal: metadata?.terminal,
    });
    const tmuxTarget = getTmuxTargetForSession(metadata?.terminal);
    const tmuxFallbackReason = getTmuxFallbackReason(metadata?.terminal);
    const sessionLogPath =
      typeof (metadata as any)?.sessionLogPath === 'string' &&
      (metadata as any).sessionLogPath.trim()
        ? String((metadata as any).sessionLogPath).trim()
        : null;
    const resumeCommand = t('sessionInfo.resumeCommand', {
      sessionId: session.id,
    });
    const managedFolder = metadata
      ? readSessionDirectoryKind(metadata) === 'managed'
      : false;
    const pendingRequestCount = session.agentState?.requests
      ? Object.keys(session.agentState.requests).length
      : 0;

    const lead: Fact[] = [];
    const more: Fact[] = [];
    if (props.executionMachineLabel) {
      const machineId = props.executionMachineId;
      lead.push({
        key: 'run-on',
        node: (
          <Item
            testID="session-info-execution-machine"
            title={t('machinePools.executionMachine')}
            detail={props.executionMachineLabel}
            showChevron={Boolean(machineId)}
            {...(machineId
              ? {
                  onPress: () =>
                    router.push(
                      machinePageHref({
                        door: 'rail',
                        target: { machineId, serverId: props.serverId },
                      }) as never,
                    ),
                }
              : {})}
          />
        ),
      });
    }
    if (metadata?.placementOrigin?.kind === 'machine_pool') {
      lead.push({
        key: 'pool',
        node: (
          <SessionMachinePoolOriginItem
            serverId={props.serverId}
            poolId={metadata.placementOrigin.poolId}
            machines={props.machineList}
          />
        ),
      });
    }
    if (metadata?.path) {
      lead.push({
        key: 'folder',
        node: managedFolder ? (
          // A no-folder session's folder is Happier's own: named, not shown, with the real path one
          // disclosure away (with Copy) for support.
          <ExpandableItem
            testID="session-info-private-folder"
            expanded={privateFolderExpanded}
            onExpandedChange={setPrivateFolderExpanded}
            header={({ expanded, headerProps }) => (
              <Item
                {...headerProps}
                title={t('session.folderless.folder')}
                detail={t('session.folderless.privateToSession')}
              />
            )}
          >
            <Item
              testID="session-info-private-folder-path"
              title={metadata.path}
              copy={metadata.path}
              showChevron={false}
            />
          </ExpandableItem>
        ) : (
          <Item
            testID="session-info-folder"
            title={t('sessionPages.info.folder')}
            detail={formatSessionPath(metadata.path, metadata.homeDir)}
            detailStyle={mono}
            copy={metadata.path}
            showChevron={false}
          />
        ),
      });
    }
    if (props.agentTitle) {
      lead.push({
        key: 'agent',
        node: (
          <Item
            testID="session-info-agent"
            title={t('sessionPages.info.agent')}
            detail={props.agentTitle}
            showChevron={false}
          />
        ),
      });
    }
    if (metadata?.nativeSandbox) {
      lead.push({
        key: 'native-sandbox',
        node: (
          <Item
            testID="session-info-native-sandbox"
            title={t('agentInput.permissionMode.nativeSandbox')}
            detail={metadata.nativeSandbox === 'off' ? t('common.off') : t('common.on')}
            showChevron={false}
          />
        ),
      });
    }
    lead.push({
      key: 'started',
      node: (
        <Item
          testID="session-info-started"
          title={t('sessionPages.info.started')}
          detail={formatDate(session.createdAt)}
          showChevron={false}
        />
      ),
    });
    if (!session.active && props.vendorResumeId) {
      lead.push({
        key: 'resume-command',
        node: (
          <Item
            testID="session-info-resume-command"
            title={t('sessionPages.info.resumeCommand')}
            detail={t('sessionInfo.resumeCommand', { sessionId: middleTruncate(session.id) })}
            detailStyle={mono}
            copy={resumeCommand}
            showChevron={false}
          />
        ),
      });
    }
    lead.push({
      key: 'session-id',
      node: (
        <Item
          testID="session-info-session-id"
          title={t('sessionInfo.happySessionId')}
          detail={middleTruncate(session.id)}
          detailStyle={mono}
          copy={session.id}
          showChevron={false}
        />
      ),
    });

    lead.push({
      key: 'copy-information',
      node: (
        <Item
          testID="session-info-copy-debug-information"
          title={t('sessionInfo.copyDebugInformation')}
          copy={buildSessionDebugInformationForSession(session).text}
          showChevron={false}
        />
      ),
    });

    more.push({
      key: 'connection',
      node: (
        <Item
          title={t('sessionPages.info.connection')}
          detail={props.isConnected ? t('status.online') : t('status.offline')}
          showChevron={false}
        />
      ),
    });
    if (useProfiles && metadata?.profileId !== undefined) {
      more.push({
        key: 'profile',
        node: (
          <Item
            title={t('sessionInfo.aiProfile')}
            detail={profileLabel}
            showChevron={false}
          />
        ),
      });
    }
    if (props.vendorResumeId && props.vendorResumeLabel) {
      more.push({
        key: 'vendor-id',
        node: (
          <Item
            title={props.vendorResumeLabel}
            detail={middleTruncate(props.vendorResumeId)}
            detailStyle={mono}
            copy={props.vendorResumeId}
            showChevron={false}
          />
        ),
      });
    }
    more.push({
      key: 'updated',
      node: (
        <Item
          title={t('sessionInfo.lastUpdated')}
          detail={formatDate(session.updatedAt)}
          showChevron={false}
        />
      ),
    });
    more.push({
      key: 'sequence',
      node: (
        <Item
          title={t('sessionInfo.sequence')}
          detail={session.seq.toLocaleString()}
          showChevron={false}
        />
      ),
    });
    if (metadata?.happyHomeDir) {
      more.push({
        key: 'happier-home',
        node: (
          <Item
            title={t('sessionInfo.happyHome')}
            detail={formatPathRelativeToHome(
              metadata.happyHomeDir,
              metadata.homeDir,
            )}
            detailStyle={mono}
            showChevron={false}
          />
        ),
      });
    }
    if (metadata?.host) {
      more.push({
        key: 'host',
        node: (
          <Item
            title={t('sessionInfo.host')}
            detail={metadata.host}
            detailStyle={mono}
            showChevron={false}
          />
        ),
      });
    }
    if (metadata?.os) {
      more.push({
        key: 'os',
        node: (
          <Item
            title={t('sessionInfo.operatingSystem')}
            detail={formatOSPlatform(metadata.os)}
            showChevron={false}
          />
        ),
      });
    }
    if (metadata?.version) {
      more.push({
        key: 'cli',
        node: (
          <Item
            title={t('sessionPages.info.cli')}
            detail={
              props.isCliOutdated
                ? t('sessionPages.info.cliOutdatedValue', {
                    version: metadata.version,
                  })
                : metadata.version
            }
            detailStyle={
              props.isCliOutdated
                ? { color: theme.colors.state.warning.textForeground }
                : undefined
            }
            showChevron={false}
          />
        ),
      });
    }
    if (metadata?.hostPid) {
      more.push({
        key: 'pid',
        node: (
          <Item
            title={t('sessionInfo.processId')}
            detail={metadata.hostPid.toString()}
            detailStyle={mono}
            showChevron={false}
          />
        ),
      });
    }
    if (session.agentState) {
      more.push({
        key: 'controlled-by',
        node: (
          <Item
            title={t('sessionPages.info.controlledBy')}
            detail={
              session.agentState.controlledByUser
                ? t('sessionPages.info.controlledByYou')
                : props.providerDisplayName
            }
            showChevron={false}
          />
        ),
      });
      if (pendingRequestCount > 0) {
        more.push({
          key: 'pending',
          node: (
            <Item
              title={t('sessionInfo.pendingRequests')}
              detail={pendingRequestCount.toLocaleString()}
              showChevron={false}
            />
          ),
        });
      }
    }
    if (attachCommand) {
      more.push({
        key: 'attach',
        node: (
          <Item
            title={t('sessionInfo.attachFromTerminal')}
            detail={attachCommand}
            detailStyle={mono}
            copy={attachCommand}
            showChevron={false}
          />
        ),
      });
    }
    if (tmuxTarget) {
      more.push({
        key: 'tmux-target',
        node: (
          <Item
            title={t('sessionInfo.tmuxTarget')}
            detail={tmuxTarget}
            detailStyle={mono}
            showChevron={false}
          />
        ),
      });
    }
    if (tmuxFallbackReason) {
      more.push({
        key: 'tmux-fallback',
        node: (
          <Item
            title={t('sessionInfo.tmuxFallback')}
            subtitle={tmuxFallbackReason}
            icon={
              <Icon
                name="warning-circle"
                color={theme.colors.state.warning.foreground}
              />
            }
            showChevron={false}
          />
        ),
      });
    }
    if (sessionLogPath && metadata) {
      more.push({
        key: 'session-log',
        node: (
          <Item
            testID="session-info-session-log-path"
                title={t('sessionLog.logPathCopyLabel')}
            detail={formatPathRelativeToHome(sessionLogPath, metadata.homeDir)}
            detailStyle={mono}
            copy={sessionLogPath}
            showChevron={false}
          />
        ),
      });
    }
    if (props.showUsage) {
      more.push({
        key: 'usage',
        node: (
          <Item
            testID="session-info-usage"
            title={t('sessionPages.info.usage')}
            detail={t('sessionPages.info.usageDetail')}
            onPress={openUsage}
          />
        ),
      });
    }
    if (metadata) {
      more.push({
        key: 'copy-all',
        node: (
          <Item
            testID="session-info-copy-metadata"
            title={t('sessionPages.info.copyAllDetails')}
            detail={t('sessionPages.info.copyAllDetailsNote')}
            copy={stringifySessionDebugJson(metadata)}
            showChevron={false}
          />
        ),
      });
    }

    useSessionInfoDisclosureCommands([
      { key: 'about', title: t('sessionPages.info.aboutTitle'), expanded: moreExpanded,
        onExpandedChange: setMoreExpanded, available: more.length > 0 },
      { key: 'private-folder', title: t('session.folderless.folder'), expanded: privateFolderExpanded,
        onExpandedChange: setPrivateFolderExpanded, available: managedFolder && Boolean(metadata?.path) },
    ]);
    useCurrentUiContextLocalCommands(React.useMemo(() => [
      ...(moreExpanded && props.showUsage ? [{ key: 'session.info.usage', title: t('sessionPages.info.usage'), invoke: openUsage }] : []),
    ], [moreExpanded, openUsage, props.showUsage]));

    return (
      <ItemGroup
        testID="session-info-about"
        title={t('sessionPages.info.aboutTitle')}
        // A list of facts: the list shape of its density (in the Info inspector, value-first fact rows).
        density="compact"
      >
        {lead.map((fact) => (
          <React.Fragment key={fact.key}>{fact.node}</React.Fragment>
        ))}
        {moreExpanded
          ? more.map((fact) => (
              <React.Fragment key={fact.key}>{fact.node}</React.Fragment>
            ))
          : null}
        {more.length > 0 ? (
          <Item
            testID="session-info-about-more"
            // The caret leads the words on the facts' own edge; no glyph column for the whole section.
            title={
              <View style={styles.moreTitleRow}>
                <DisclosureCaret expanded={moreExpanded} />
                <Text style={styles.moreTitle}>
                  {moreExpanded
                    ? t('sessionPages.info.showFewer')
                    : t('sessionPages.info.showMore', { count: more.length })}
                </Text>
              </View>
            }
            accessibilityLabel={moreExpanded
              ? t('sessionPages.info.showFewer')
              : t('sessionPages.info.showMore', { count: more.length })}
            accessibilityExpanded={moreExpanded}
            showChevron={false}
            onPress={toggleMore}
          />
        ) : null}
      </ItemGroup>
    );
  },
);

function SessionMachinePoolOriginItem(
  props: Readonly<{
    serverId: string;
    poolId: string;
    machines?: readonly MachinePoolProjectionMachine[];
  }>,
) {
  const name = useMachinePoolOriginName(props);
  return (
    <Item
      testID="session-info-placement-origin"
      title={t('machinePools.chosenFrom')}
      detail={name ?? t('machinePools.aMachinePool')}
      showChevron={false}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  mono: {
    ...Typography.mono(),
  },
  moreTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  moreTitle: {
    ...Typography.variant('body', 'medium'),
    color: theme.colors.text.secondary,
  },
}));
