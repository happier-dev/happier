import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { CommandPalette } from './CommandPalette';
import { Command } from './types';
import { useGlobalKeyboard } from '@/hooks/ui/useGlobalKeyboard';
import { useAuth } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSegments } from 'expo-router';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resetDesktopPetOverlayPosition } from '@/components/pets/desktop/bridge/desktopPetOverlayBridge';
import { requestCodexPetRefresh } from '@/components/settings/pets/petSettingsCommandEvents';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { buildCommandPaletteCommands, type PetCommandControls } from './buildCommandPaletteCommands';

function readActiveSessionIdFromSegments(segments: readonly string[]): string | null {
    // expo-router segments look like: ['(app)', 'session', '<id>', ...]
    const idx = segments.indexOf('session');
    if (idx < 0) return null;
    const candidate = String(segments[idx + 1] ?? '').trim();
    return candidate.length > 0 ? candidate : null;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { logout } = useAuth();
    const sessions = storage(useShallow((state) => state.sessions));
    const commandPaletteEnabled = storage(useShallow((state) => state.localSettings.commandPaletteEnabled));
    const navigateToSession = useNavigateToSession();
    const segments = useSegments();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const voiceEnabled = useFeatureEnabled('voice');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const petsCompanionEnabled = useFeatureEnabled('pets.companion');
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const actionExecutor = useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
            openSession: (sessionId) => {
                router.push((`/session/${sessionId}`) as any);
            },
        }),
        [router],
    );
    const petControls = useMemo<PetCommandControls>(() => {
        const desktop = isTauriDesktop();
        const surface = desktop ? 'desktopOverlay' : Platform.OS === 'web' ? 'appShell' : 'none';
        return {
            surface,
            wake: () => {
                applySettings({ petsEnabled: true });
                applyLocalSettings(desktop
                    ? { petsEnabledOverride: 'enabled', desktopPetOverlayEnabledOverride: 'enabled' }
                    : { petsEnabledOverride: 'enabled' });
            },
            tuck: () => {
                applyLocalSettings(desktop
                    ? { desktopPetOverlayEnabledOverride: 'disabled' }
                    : { petsEnabledOverride: 'disabled' });
            },
            resetPosition: desktop
                ? () => {
                    applyLocalSettings({
                        desktopPetOverlayOffset: { x: 0, y: 0 },
                        desktopPetOverlayAnchor: 'bottomRight',
                    });
                    fireAndForget(resetDesktopPetOverlayPosition(), {
                        tag: 'CommandPaletteProvider.resetDesktopPetOverlayPosition',
                    });
                }
                : undefined,
            refreshCodexPets: () => {
                router.push('/settings/pets' as any);
                requestCodexPetRefresh();
            },
        };
    }, [applyLocalSettings, applySettings, router]);

    // Define available commands
    const commands = useMemo((): Command[] => {
        const activeSessionId = readActiveSessionIdFromSegments(segments);

        return buildCommandPaletteCommands({
            sessionsById: sessions as any,
            isDev: __DEV__ === true,
            activeSessionId,
            features: { executionRunsEnabled, voiceEnabled, memorySearchEnabled, petsCompanionEnabled },
            petControls,
            nav: {
                push: (path) => router.push(path as any),
                navigateToSession,
            },
            auth: { logout },
            actions: {
                execute: (actionId, parameters, ctx) => actionExecutor.execute(actionId as any, parameters, ctx),
            },
            alert: async (title, message) => {
                await Modal.alertAsync(title, message);
            },
        });
    }, [segments, sessions, executionRunsEnabled, voiceEnabled, memorySearchEnabled, petsCompanionEnabled, petControls, router, navigateToSession, logout, actionExecutor]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || !commandPaletteEnabled) return;

        Modal.show({
            component: CommandPalette,
            props: {
                commands,
            }
        });
    }, [commands, commandPaletteEnabled]);

    // Set up global keyboard handler only if feature is enabled
    useGlobalKeyboard(commandPaletteEnabled ? showCommandPalette : () => {});

    return <>{children}</>;
}
