import * as React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { PathSelector } from '@/components/sessions/new/components/PathSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import type { VoiceSessionSpawnPickerResult } from './openVoiceSessionSpawnPicker';
import { Text } from '@/components/ui/text/Text';


type Props = CustomModalInjectedProps & Readonly<{
  onResolve: (value: VoiceSessionSpawnPickerResult | null) => void;
  onRequestClose?: () => void;
}>;

type Step = 'machine' | 'path';

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    width: 520,
    maxWidth: '94%',
    maxHeight: '92%',
    overflow: 'hidden',
    shadowColor: theme.colors.shadow.color,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  title: {
    fontSize: 17,
    color: theme.colors.text,
    ...Typography.default('semiBold'),
  },
  body: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
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
    color: theme.colors.textSecondary,
    ...Typography.default(),
  },
}));

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function VoiceSessionSpawnPickerModal({ onClose, onResolve }: Props) {
  const { theme } = useUnistyles();
  const styles = stylesheet;

  const machines = useAllMachines();
  const sessions = useSessions();
  const recentMachinePaths = useSetting('recentMachinePaths') as any[] | undefined;
  const useMachinePickerSearch = useSetting('useMachinePickerSearch');
  const usePathPickerSearch = useSetting('usePathPickerSearch');
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

  const recentPaths = React.useMemo(() => {
    if (!selectedMachineId) return [];
    return getRecentPathsForMachine({
      machineId: selectedMachineId,
      recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
      sessions,
    });
  }, [recentMachinePaths, selectedMachineId, sessions]);

  const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];

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
    && isMachineOnline(selectedMachine as any)
    && (selectedPath.trim() || selectedMachine?.metadata?.homeDir),
  );

  const handleCreate = React.useCallback(() => {
    if (!selectedMachineId) return;
    const directory = selectedPath.trim() || selectedMachine?.metadata?.homeDir || '/home';
    onResolve({ machineId: selectedMachineId, directory });
    onClose();
  }, [onClose, onResolve, selectedMachine?.metadata?.homeDir, selectedMachineId, selectedPath]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('newSession.title')}</Text>
        <Pressable
          onPress={handleCancel}
          hitSlop={10}
          style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Ionicons name="close" size={22} color={theme.colors.header.tint} />
        </Pressable>
      </View>

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
                  setSelectedMachineId(machine?.id ?? null);
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
                <Ionicons name="chevron-back" size={20} color={theme.colors.textSecondary} />
              </Pressable>
              <Text style={styles.stepHeaderText}>{t('newSession.selectWorkingDirectoryTitle')}</Text>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              <PathSelector
                machineHomeDir={selectedMachine?.metadata?.homeDir || '/home'}
                selectedPath={selectedPath}
                onChangeSelectedPath={setSelectedPath}
                recentPaths={recentPaths}
                usePickerSearch={usePathPickerSearch !== false}
                searchVariant="header"
                favoriteDirectories={favoriteDirectories}
                onChangeFavoriteDirectories={(dirs) => setFavoriteDirectoriesRaw(dirs)}
                submitBehavior="showRow"
              />
            </ScrollView>
          </>
        )}
      </View>

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
    </View>
  );
}
