import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import * as React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

import { useAllMachines, useAllSessionListRenderables, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import {
  useStableRecentPathsForMachine,
  useStableRecentPathsResolver,
} from '@/utils/sessions/useStableRecentPathsForMachine';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
  resolveDirectoryFavoriteComparisonKey,
  toggleHomeAwareDirectoryFavorite,
} from '@/utils/sessions/favoriteDirectoriesToggle';

import type { VoiceSessionSpawnPickerResult } from './openVoiceSessionSpawnPicker';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';


type Props = CustomModalInjectedProps & Readonly<{
  onResolve: (value: VoiceSessionSpawnPickerResult | null) => void;
  onRequestClose?: () => void;
}>;

type Step = 'machine' | 'path';

const stylesheet = StyleSheet.create(() => ({
  body: {
    flex: 1,
    minHeight: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
}));

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function VoiceSessionSpawnPickerModal(props: Props) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const { onClose, onResolve, setChrome } = props;

  const machines = useAllMachines();
  const sessions = useAllSessionListRenderables();
  const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
  const normalizedRecentMachinePaths = React.useMemo(
    () => Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
    [recentMachinePaths],
  );
  const useMachinePickerSearch = useSetting('useMachinePickerSearch');
  const [favoriteMachinesRaw, setFavoriteMachinesRaw] = useSettingMutable('favoriteMachines');
  const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');

  const favoriteMachineIds = Array.isArray(favoriteMachinesRaw) ? favoriteMachinesRaw : [];
  const favoriteMachines = React.useMemo(() => {
    const byId = new Map(machines.map((machine) => [machine.id, machine] as const));
    return favoriteMachineIds
      .map((id) => byId.get(id))
      .filter((machine): machine is Machine => Boolean(machine));
  }, [favoriteMachineIds, machines]);

  const recentMachines = React.useMemo(() => {
    return getRecentMachinesFromSessions({ machines, sessions });
  }, [machines, sessions]);

  const [step, setStep] = React.useState<Step>('machine');
  const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() =>
    resolvePreferredMachineId({ machines, recentMachinePaths: normalizedRecentMachinePaths }),
  );

  const selectedMachine = React.useMemo(() => {
    return machines.find((machine) => machine.id === selectedMachineId) ?? null;
  }, [machines, selectedMachineId]);

  const recentPaths = useStableRecentPathsForMachine({
    machineId: selectedMachineId,
    recentMachinePaths: normalizedRecentMachinePaths,
    sessions,
  });
  const resolveRecentPathsForMachine = useStableRecentPathsResolver({
    recentMachinePaths: normalizedRecentMachinePaths,
    sessions,
  });

  const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];
  const selectedMachineHomeDir = selectedMachine?.metadata?.homeDir || '/home';
  const favoriteDirectoryKeys = React.useMemo(() => new Set(
    favoriteDirectories.map((path) =>
      resolveDirectoryFavoriteComparisonKey(path, selectedMachineHomeDir)
    ),
  ), [favoriteDirectories, selectedMachineHomeDir]);

  const [selectedPath, setSelectedPath] = React.useState<string>(() => {
    const first = recentPaths?.[0] ?? '';
    return first || '';
  });

  React.useEffect(() => {
    if (step !== 'path') return;
    if (selectedPath.trim()) return;
    const first = recentPaths?.[0] ?? '';
    if (first) setSelectedPath(first);
  }, [recentPaths, selectedPath, step]);

  const handleCancel = React.useCallback(() => {
    onResolve(null);
    onClose();
  }, [onClose, onResolve]);

  const canCreate = Boolean(
    selectedMachineId
    && selectedMachine
    && canAttemptMachineSpawn({ machine: selectedMachine, selectedMachineId })
    && (selectedPath.trim() || selectedMachine?.metadata?.homeDir),
  );

  const handleCreate = React.useCallback(() => {
    if (!selectedMachineId) return;
    if (!canAttemptMachineSpawn({ machine: selectedMachine, selectedMachineId })) return;
    const directory = selectedPath.trim() || selectedMachine?.metadata?.homeDir || '/home';
    onResolve({ machineId: selectedMachineId, directory });
    onClose();
  }, [onClose, onResolve, selectedMachine, selectedMachineId, selectedPath]);

  const footer = React.useMemo(() => (
    <View style={styles.footer}>
      <RoundButton
        display="inverted"
        title={t('common.cancel')}
        onPress={handleCancel}
      />
      <RoundButton
        title={t('common.create')}
        onPress={handleCreate}
        disabled={!canCreate}
      />
    </View>
  ), [canCreate, handleCancel, handleCreate, styles.footer]);

  // The title band names the step; on the folder step its leading control goes back to machines.
  const backToMachines = React.useMemo(() => step === 'path' ? (
    <Pressable
      testID="voice-session-spawn-back"
      onPress={() => setStep('machine')}
      hitSlop={10}
      style={({ pressed }) => ({ padding: 2, opacity: pressed ? motionTokens.press.opacity : 1 })}
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
    >
      <Icon name="caret-left" size={20} color={theme.colors.text.secondary} />
    </Pressable>
  ) : null, [step, theme.colors.text.secondary]);

  const chrome = React.useMemo(() => ({
    kind: 'card' as const,
    leading: backToMachines,
    title: t('newSession.title'),
    subtitle: step === 'machine' ? t('newSession.selectMachineTitle') : t('newSession.selectWorkingDirectoryTitle'),
    dimensions: { width: 520, maxHeightRatio: 0.92, size: 'md' as const },
    footer,
  }), [backToMachines, footer, step]);

  useModalCardChrome(setChrome, chrome);

  return (
    <View style={styles.body}>
      {step === 'machine' ? (
        <>
          <ItemList presentation="grouped" style={{ paddingTop: 0 }}>
            <MachineSelector
              machines={machines}
              selectedMachine={selectedMachine}
              recentMachines={recentMachines}
              favoriteMachines={favoriteMachines}
              showFavorites={true}
              showRecent={true}
              showSearch={useMachinePickerSearch !== false}
              showCliGlyphs={false}
              autoDetectCliGlyphs={false}
              onSelect={(machine) => {
                const nextMachineId = normalizeId(machine.id) || null;
                setSelectedMachineId(nextMachineId);
                setSelectedPath(resolveRecentPathsForMachine(nextMachineId)[0] ?? '');
                setStep('path');
              }}
              onToggleFavorite={(machine) => {
                const id = normalizeId(machine.id);
                if (!id) return;
                const exists = favoriteMachineIds.includes(id);
                const next = exists ? favoriteMachineIds.filter((v) => v !== id) : [...favoriteMachineIds, id];
                setFavoriteMachinesRaw(next);
              }}
            />
          </ItemList>
        </>
      ) : (
        <>
          <ScrollView keyboardShouldPersistTaps="handled">
            <PathSelectionList
              initialValue={selectedPath}
              machineHomeDir={selectedMachineHomeDir}
              favorites={favoriteDirectories.map((path) => ({ path }))}
              recents={recentPaths.map((path, index) => ({ path, lastUsedAt: index }))}
              machineId={selectedMachine?.id ?? null}
              serverId={null}
              machinePlatform={machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform)}
              onCommit={setSelectedPath}
              onChangeDraftPath={setSelectedPath}
              onRequestClose={() => setStep('machine')}
              isFavorite={(path) => favoriteDirectoryKeys.has(
                resolveDirectoryFavoriteComparisonKey(path, selectedMachineHomeDir),
              )}
              onToggleFavorite={(path) => {
                setFavoriteDirectoriesRaw([...toggleHomeAwareDirectoryFavorite(
                  favoriteDirectories,
                  path,
                  selectedMachineHomeDir,
                )]);
              }}
              maxHeight={420}
            />
          </ScrollView>
        </>
      )}
    </View>
  );
}
