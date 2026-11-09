import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  isSessionDebugInformationEnabled,
  resolveProviderSessionArtifactPath,
} from '@/components/sessions/debug/sessionDebugInformation';
import { stringifySessionDebugJson } from '@/components/sessions/debug/sessionDebugRedaction';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CodeView } from '@/components/ui/media/CodeView';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useLocalSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { t } from '@/text';
import {
  formatPathRelativeToHome,
  type SessionStatus,
} from '@/utils/sessions/sessionUtils';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useSessionInfoDisclosureCommands } from './useSessionInfoDisclosureCommands';

type RawJsonSectionId = 'agentState' | 'metadata' | 'sessionStatus' | 'session';
type RawJsonSnapshot = Readonly<{ section: RawJsonSectionId; code: string }>;

/**
 * Developer (developer mode only): raw records for debugging. A JSON view is serialized and redacted
 * only when it is opened, and stays as it was until reopened, so live arrivals never re-stringify it.
 */
export const SessionInfoDeveloperSection = React.memo(
  function SessionInfoDeveloperSection(
    props: Readonly<{
      session: Session;
      metadata: ReturnType<typeof readSessionOwnerMetadataView>;
      serverId: string;
      providerDisplayName: string;
      status: SessionStatus;
    }>,
  ) {
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    if (!isSessionDebugInformationEnabled(localDevModeEnabled)) return null;
    return <SessionInfoDeveloperContent {...props} />;
  },
);

function SessionInfoDeveloperContent(
  props: Readonly<{
    session: Session;
    metadata: ReturnType<typeof readSessionOwnerMetadataView>;
    serverId: string;
    providerDisplayName: string;
    status: SessionStatus;
  }>,
) {
  const router = useRouter();
  const { session, metadata } = props;
  const [expanded, setExpanded] = React.useState<RawJsonSnapshot | null>(null);
  const providerSessionArtifactPath =
    resolveProviderSessionArtifactPath(metadata);
  const buildCode = (section: RawJsonSectionId) => {
    switch (section) {
      case 'agentState':
        return stringifySessionDebugJson(session.agentState);
      case 'metadata':
        return stringifySessionDebugJson(metadata);
      case 'sessionStatus':
        return stringifySessionDebugJson({
          isConnected: props.status.isConnected,
          statusText: props.status.statusText,
          statusColor: props.status.statusColor,
          statusDotColor: props.status.statusDotColor,
          isPulsing: props.status.isPulsing,
        });
      case 'session':
        return stringifySessionDebugJson(session);
    }
  };
  const setSectionExpanded = (section: RawJsonSectionId, next: boolean) =>
    setExpanded(next ? { section, code: buildCode(section) } : null);
  const toggle = (section: RawJsonSectionId) => setExpanded(current => current?.section === section
    ? null : { section, code: buildCode(section) });
  useSessionInfoDisclosureCommands([
    { key: 'agentState' as const, title: t('sessionInfo.agentState'), available: Boolean(session.agentState) },
    { key: 'metadata' as const, title: t('sessionInfo.metadata'), available: Boolean(metadata) },
    { key: 'sessionStatus' as const, title: t('sessionInfo.sessionStatus') },
    { key: 'session' as const, title: t('sessionInfo.fullSessionObject') },
  ].map(section => ({ key: `developer.${section.key}`, title: section.title, available: section.available,
    expanded: expanded?.section === section.key,
    onExpandedChange: (next: boolean) => setSectionExpanded(section.key, next),
  })));
  const openSessionLog = React.useCallback(() => router.push(buildScopedSessionRouteHref({
    sessionId: session.id, serverId: props.serverId, suffix: '/log',
  }) as never), [props.serverId, router, session.id]);
  useCurrentUiContextLocalCommands([{ key: 'session.info.session-log', title: t('sessionPages.info.sessionLog'),
    invoke: openSessionLog }]);
  const jsonRow = (section: RawJsonSectionId, title: string) => (
    <React.Fragment key={section}>
      <Item
        title={title}
        accessibilityExpanded={expanded?.section === section}
        onPress={() => toggle(section)}
      />
      {expanded?.section === section ? (
        <View style={styles.code}>
          <CodeView code={expanded.code} language="json" />
        </View>
      ) : null}
    </React.Fragment>
  );

  return (
    <ItemGroup
      testID="session-info-developer"
      title={t('sessionPages.info.developerTitle')}
      description={t('sessionPages.info.developerDescription')}
      density="compact"
    >
      <Item
        title={t('sessionInfo.thinking')}
        detail={
          session.thinking
            ? `${t('common.yes')} · ${new Date(session.thinkingAt).toLocaleTimeString()}`
            : t('common.no')
        }
        showChevron={false}
      />
      {providerSessionArtifactPath ? (
        <Item
          title={t('sessionInfo.providerSessionLogs', {
            provider: props.providerDisplayName,
          })}
          detail={formatPathRelativeToHome(
            providerSessionArtifactPath,
            metadata?.homeDir,
          )}
          detailStyle={styles.mono}
          copy={providerSessionArtifactPath}
          showChevron={false}
        />
      ) : null}
      <Item
        testID="session-info-session-log"
        title={t('sessionPages.info.sessionLog')}
        detail={t('sessionPages.info.view')}
        onPress={openSessionLog}
      />
      {session.agentState
        ? jsonRow('agentState', t('sessionInfo.agentState'))
        : null}
      {metadata ? jsonRow('metadata', t('sessionInfo.metadata')) : null}
      {jsonRow('sessionStatus', t('sessionInfo.sessionStatus'))}
      {jsonRow('session', t('sessionInfo.fullSessionObject'))}
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  code: {
    marginHorizontal: theme.space.s16,
    marginBottom: theme.space.s12,
  },
  mono: {
    ...Typography.mono(),
  },
}));
