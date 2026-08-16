import * as React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';

import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import {
  useStableRecentPathsForMachine,
  useStableRecentPathsResolver,
} from '@/utils/sessions/useStableRecentPathsForMachine';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { Text } from '@/components/ui/text/Text';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import {
  resolveDirectoryFavoriteComparisonKey,
  toggleHomeAwareDirectoryFavorite,
} from '@/components/sessions/new/hooks/favoriteDirectoriesToggle';

import type { VoiceSessionSpawnPickerResult } from './openVoiceSessionSpawnPicker';
import { Icon } from '@/components/ui/icons/Icon';


type Props = CustomModalInjectedProps & Readonly<{
  onResolve: (value: VoiceSessionSpawnPickerResult | null) => void;
  onRequestClose?: () => void;
}>;

type Step = 'machine' | 'path';

const stylesheet = StyleSheet.create((theme) => ({
  body: {
    flex: 1,
    minHeight: 0,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  stepHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  stepHeaderText: {
    color: theme.colors.text.secondary,
    ...Typography.default(),
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
  const sessions = useSessions();
  const recentMachinePaths = useSetting('recentMachinePaths') as any[] | undefined;
  const normalizedRecentMachinePaths = React.useMemo(
    () => Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
    [recentMachinePaths],
  );
  const useMachinePickerSearch = useSetting('useMachinePickerSearch');
  const [favoriteMachinesRaw, setFavoriteMachinesRaw] = useSettingMutable('favoriteMachines');
  const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');

  const favoriteMachineIds = Array.isArray(favoriteMachinesRaw) ? favoriteMachinesRaw : [];
  const favoriteMachines = React.useMemo(() => {
    const byId = new Map(machines.map((m: any) => [m?.id, m] as const));
    return favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as any[];
  }, [favoriteMachineIds, machines]);

  const recentMachines = React.useMemo(() => {
    return getRecentMachinesFromSessions({ machines, sessions });
  }, [machines, sessions]);

  const [step, setStep] = React.useState<Step>('machine');
  const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() =>
    resolvePreferredMachineId({ machines, recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [] }),
  );

  const selectedMachine = React.useMemo(() => {
    return machines.find((m: any) => m?.id === selectedMachineId) ?? null;
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

  const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw as string[] : [];
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
    && canAttemptMachineSpawn({ selectedMachineId, machine: selectedMachine })
    && (selectedPath.trim() || selectedMachine?.metadata?.homeDir),
  );

  const handleCreate = React.useCallback(() => {
    if (!selectedMachineId) return;
    if (!canAttemptMachineSpawn({ selectedMachineId, machine: selectedMachine })) return;
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

  const chrome = React.useMemo(() => ({
    kind: 'card' as const,
    title: t('newSession.title'),
    dimensions: { width: 520, maxHeightRatio: 0.92, size: 'md' as const },
    layout: 'fill' as const,
    footer,
  }), [footer]);

  useModalCardChrome(setChrome, chrome);

  return (
    <View style={styles.body}>
      {step === 'machine' ? (
        <>
          <View style={styles.stepHeaderRow}>
            <Text style={styles.stepHeaderText}>{t('newSession.selectMachineTitle')}</Text>
          </View>
          <ItemList style={{ paddingTop: 0 }}>
            <MachineSelector
              machines={machines as any}
              selectedMachine={selectedMachine as any}
              recentMachines={recentMachines as any}
              favoriteMachines={favoriteMachines as any}
              showFavorites={true}
              showRecent={true}
              showSearch={useMachinePickerSearch !== false}
              showCliGlyphs={false}
              autoDetectCliGlyphs={false}
              onSelect={(machine: any) => {
                const nextMachineId = normalizeId(machine?.id) || null;
                setSelectedMachineId(nextMachineId);
                setSelectedPath(resolveRecentPathsForMachine(nextMachineId)[0] ?? '');
                setStep('path');
              }}
              onToggleFavorite={(machine: any) => {
                const id = normalizeId(machine?.id);
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
          <View style={styles.stepHeaderRow}>
            <Pressable
              onPress={() => setStep('machine')}
              hitSlop={10}
              style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
            >
              <Icon name="caret-left" size={20} color={theme.colors.text.secondary} />
            </Pressable>
            <Text style={styles.stepHeaderText}>{t('newSession.selectWorkingDirectoryTitle')}</Text>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            <PathSelectionList
              initialValue={selectedPath}
              favorites={favoriteDirectories.map((p) => ({ path: p }))}
              recents={recentPaths.map((p, index) => ({ path: p, lastUsedAt: Date.now() - index }))}
              machineHomeDir={selectedMachineHomeDir}
              machineId={selectedMachine?.id ?? null}
              serverId={null}
              machinePlatform={machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform)}
              onCommit={setSelectedPath}
              onChangeDraftPath={setSelectedPath}
              onRequestClose={() => {}}
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
            />
          </ScrollView>
        </>
      )}
    </View>
  );
}
