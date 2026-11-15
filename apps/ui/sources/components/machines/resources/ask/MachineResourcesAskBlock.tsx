import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  HubComposerSuggestionList,
  type HomeComposerSuggestionFill,
} from '@/components/hub/composer/suggestions/HubComposerSuggestions';
import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { NewSessionScreen } from '@/components/sessions/new/NewSessionScreen';
import { NewSessionEmbeddedHostProvider } from '@/components/sessions/new/navigation/newSessionHost';
import { useNewSessionEmbeddedHostState } from '@/components/sessions/new/navigation/useNewSessionEmbeddedHostState';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { readHappierStorageBytes } from '@/components/machines/storage/storageViewModel';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveDefaultDirectoryForMachine } from '@/utils/sessions/machineDefaultDirectory';
import { storage as appStorage } from '@/sync/domains/state/storageStore';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { selectMachineProcessesLeftBehind } from '@/sync/domains/machines/processes/selectMachineProcessesLeftBehind';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { deriveMachineResourceSuggestions, type MachineResourceSuggestionSubject } from './machineResourceSuggestions';

/**
 * "Ask an agent" (plan 60 AGW-11, lab `ra` A1/A1b/A1p): the last block of a Resources tab. The real
 * embedded New Session composer, bound to this machine, and three prompts written from what the page
 * shows right now. Pressing a prompt fills the composer; sending opens an ordinary session there.
 * Offline, there is no embedded composer; last-report prompts fill the global New Session draft.
 */
export const MachineResourcesAskBlock = React.memo(
  function MachineResourcesAskBlock(
    props: Readonly<{
      serverId: string;
      machineId: string;
      machineName: string;
      /** The open tab's subject (Setup, Security); the resource tabs when absent. */
      subject?: MachineResourceSuggestionSubject;
    }>,
  ) {
    const presence = useMachinePresenceSummary(props.serverId, props.machineId);
    const online = presence.reachability === 'reachable';
    // Ask starts at the home intent of whoever the session runs as, never the daemon's absolute home:
    // on a separate-users Machine the member's folder comes from the New Session placement owner.
    const directory = appStorage(React.useCallback((state: ReturnType<typeof appStorage.getState>) => {
      const machine = resolveServerScopedMachine(state, props.serverId, props.machineId);
      return machine ? resolveDefaultDirectoryForMachine({ machineId: props.machineId, machines: [machine], recentPaths: [] }) || undefined
        : undefined;
    }, [props.machineId, props.serverId]));
    const fillGlobalComposer = React.useCallback(async (suggestion: HomeComposerSuggestionFill) => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      const scope = selectActiveServerAccountScopeForServer(lifetime?.scope ?? null, props.serverId);
      // A Machine on a Home other than the active Account's has no Account to open New Session in.
      if (!lifetime || !scope) {
        Modal.alert(t('common.error'), t('errors.operationFailed'));
        return;
      }
      // The authoring owner shows a refusal or a waiting approval.
      await openSessionAuthoringAction({ seed: { prompt: suggestion.prompt } }, lifetime);
    }, [props.serverId]);

    return (
      <ItemGroup
        surface="none"
        title={t('machineResources.ask.title')}
        // Offline, the machine page has already said so once (its Overview banner): the block just offers the prompts,
        // which open a new session wherever the person chooses.
        {...(online ? { description: t('machineResources.ask.description') } : {})}
      >
        <View testID="machine-resources-ask" style={styles.stack}>
          {online ? (
            <AskComposer
              key={`${props.serverId}:${props.machineId}`}
              serverId={props.serverId}
              machineId={props.machineId}
              machineName={props.machineName}
              directory={directory}
              subject={props.subject}
            />
          ) : (
            <AskSuggestions {...props} online={online} directory={directory} onFill={fillGlobalComposer} />
          )}
        </View>
      </ItemGroup>
    );
  },
);

/** The composer is bound to this machine: the draft's placement starts here, and prompts fill it. */
const AskComposer = React.memo(function AskComposer(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    directory: string | undefined;
    subject?: MachineResourceSuggestionSubject;
  }>,
) {
  const initialParams = React.useMemo(() => ({
    spawnServerId: props.serverId,
    machineId: props.machineId,
    ...(props.directory ? { directory: props.directory } : {}),
  }), [props.directory, props.machineId, props.serverId]);
  const { host, markDemanded } = useNewSessionEmbeddedHostState(initialParams);
  const setHostParams = host.setParams;
  const draftId =
    typeof host.params.draftId === 'string'
      ? host.params.draftId
      : `machine-ask:${props.machineId}`;
  const demand = markDemanded;
  const fill = React.useCallback(
    (suggestion: HomeComposerSuggestionFill) => {
      markDemanded();
      setHostParams({
        prompt: suggestion.prompt,
        spawnServerId: suggestion.placement?.serverId ?? props.serverId,
        machineId: suggestion.placement?.machineId ?? props.machineId,
        ...(suggestion.placement?.directory
          ? { directory: suggestion.placement.directory }
          : {}),
      });
    },
    [markDemanded, props.machineId, props.serverId, setHostParams],
  );
  return (
    <>
      <View
        testID="machine-resources-ask.composer"
        onFocus={demand}
        onPointerEnter={demand}
        onTouchStart={demand}
      >
        <NewSessionEmbeddedHostProvider host={host}>
          <ComposerBannerCollapseProvider key={draftId}>
            <NewSessionScreen
              presentation="embedded"
              // The lab's minimal ask box: where it runs and which model answers; the page is the context.
              composerControlPreset="compact"
              inputPlaceholder={t('machineResources.ask.placeholder', { machine: props.machineName })}
            />
          </ComposerBannerCollapseProvider>
        </NewSessionEmbeddedHostProvider>
      </View>
      <AskSuggestions {...props} online={true} onFill={fill} />
    </>
  );
});

/** Only the prompt tiles consume resource reports; launch commands consume placement. */
function AskSuggestions(props: Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  directory: string | undefined;
  subject?: MachineResourceSuggestionSubject;
  online: boolean;
  onFill: (suggestion: HomeComposerSuggestionFill) => void;
}>) {
    const language = usePreferredLanguage();
    const { online, directory } = props;
    const summary = useMachineResourceSummary({
      serverId: props.serverId,
      machineId: props.machineId,
    });
    const policy = useMachineResourcesPolicy({
      serverId: props.serverId,
      machineId: props.machineId,
    });
    // Observe the reports the tabs already hold; Ask never creates sampling demand.
    const storage = useMachineStorageSummary({ serverId: props.serverId, machineId: props.machineId, enabled: false });
    const processes = useMachineProcesses({ serverId: props.serverId, machineId: props.machineId,
      scope: 'happier', view: 'owners', active: false });
    const automations = useAutomationsSupport({ scopeKind: 'spawn', serverId: props.serverId });
    const happierStorageBytes = storage.summary ? readHappierStorageBytes(storage.summary) : null;
    const leftBehindCount = processes.answer?.state === 'live'
      ? selectMachineProcessesLeftBehind(processes.answer.leftBehind).count : null;
    const reported = summary?.kind === 'reporting' ? summary.summary : null;
    const hasLastReport = reported !== null;
    const memoryPressure = reported?.memory.pressure;
    const diskAvailableBytes = reported?.disk.availableBytes ?? null;
    const diskTotalBytes = reported?.disk.totalBytes ?? null;
    const diskTone = reported?.disk.tone;
    const calm = summary?.kind === 'reporting' && summary.attention?.level === 'calm';
    const guardEnabled = policy.policy
      ? policy.policy.guard?.memoryGuard?.enabled === true
      : null;
    const previousSuggestions = React.useRef<ReturnType<typeof deriveMachineResourceSuggestions>>(undefined);
    const suggestions = React.useMemo(
      () =>
        deriveMachineResourceSuggestions({
          machine: {
            serverId: props.serverId,
            machineId: props.machineId,
            name: props.machineName,
            directory: directory ?? '',
          },
          online,
          hasLastReport,
          calm: hasLastReport && calm,
          memoryPressure,
          ...(diskTone !== undefined
            ? {
                disk: {
                  availableBytes: diskAvailableBytes,
                  totalBytes: diskTotalBytes,
                  tone: diskTone,
                },
              }
            : {}),
          guardEnabled,
          happierStorageBytes,
          leftBehindCount,
          automationsEnabled: automations.enabled,
          subject: props.subject,
        }, previousSuggestions.current),
      [
        language,
        props.subject,
        automations.enabled,
        calm,
        guardEnabled,
        happierStorageBytes,
        leftBehindCount,
        directory,
        props.machineId,
        props.machineName,
        online,
        props.serverId,
        hasLastReport,
        memoryPressure,
        diskAvailableBytes,
        diskTotalBytes,
        diskTone,
      ],
    );
    React.useEffect(() => {
      previousSuggestions.current = suggestions;
    }, [suggestions]);
    return <HubComposerSuggestionList suggestions={suggestions} onFill={props.onFill} />;
}

const styles = StyleSheet.create(() => ({
  // A sheetless section (anatomy): the composer is its own card and the prompts their own tiles.
  stack: {
    gap: 12,
  },
}));
