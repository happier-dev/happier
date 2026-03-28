import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { canBrowseDirectSessions, resolveDirectBrowseLockedSource } from '@/components/sessions/directSessions/browse/resolveDirectBrowseLockedSourceOption';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function ResumePickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const settings = useSettings() ?? settingsDefaults;
    const accountProfile = useAccountProfile();
    const params = useLocalSearchParams<{
        currentResumeId?: string;
        agentType?: AgentId;
        machineId?: string;
        spawnServerId?: string;
        dataId?: string;
    }>();

    const [inputValue, setInputValue] = React.useState(params.currentResumeId || '');
    const agentType: AgentId = isAgentId(params.agentType) ? params.agentType : DEFAULT_AGENT_ID;
    const tempSessionData = React.useMemo(() => {
        const dataId = typeof params.dataId === 'string' ? params.dataId.trim() : '';
        return dataId ? peekTempData<NewSessionData>(dataId) : null;
    }, [params.dataId]);
    const effectiveMachineId = React.useMemo(() => {
        const directParam = typeof params.machineId === 'string' ? params.machineId.trim() : '';
        if (directParam) return directParam;
        const fromTemp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        return fromTemp || null;
    }, [params.machineId, tempSessionData?.machineId]);
    const effectiveServerId = React.useMemo(() => {
        const directParam = typeof params.spawnServerId === 'string' ? params.spawnServerId.trim() : '';
        return directParam || null;
    }, [params.spawnServerId]);
    const agentOptionState = React.useMemo(() => {
        const backendTarget = tempSessionData?.backendTarget;
        if (!backendTarget) return null;
        const key = buildBackendTargetKey(backendTarget);
        const map = tempSessionData?.agentNewSessionOptionStateByAgentId ?? {};
        return map && typeof map === 'object' ? (map as Record<string, Record<string, unknown>>)[key] ?? null : null;
    }, [tempSessionData?.agentNewSessionOptionStateByAgentId, tempSessionData?.backendTarget]);
    const resumeBrowseEnabled = Boolean(effectiveMachineId) && canBrowseDirectSessions(agentType);

    const handleSave = React.useCallback((nextValue: string) => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: { resumeSessionId: nextValue },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [navigation, router]);

    const handleClear = React.useCallback(() => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: { resumeSessionId: '' },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [navigation, router]);

    const headerTitle = t('newSession.resume.pickerTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
        };
    }, [headerBackTitle, headerTitle]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <NewSessionResumeSelectionContent
                value={inputValue}
                onChangeValue={setInputValue}
                onSave={handleSave}
                onClear={handleClear}
                onClose={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
                agentType={agentType}
                resumeBrowse={resumeBrowseEnabled ? {
                    enabled: true,
                    onBrowse: () => {
                        if (!effectiveMachineId) return null;
                        const source = resolveDirectBrowseLockedSource({
                            providerId: agentType as any,
                            agentOptionState,
                            profile: accountProfile,
                            settings,
                        });
                        if (!source) return null;
                        // IMPORTANT (native):
                        // New session can be presented as a contained sheet/drawer. App-root modals can render
                        // behind that native presentation even with high zIndex. Use an Expo Router screen
                        // so the browse UI is inside the same presentation boundary.
                        router.replace({
                            pathname: '/new/pick/resume-browse',
                            params: {
                                agentType,
                                machineId: effectiveMachineId,
                                spawnServerId: effectiveServerId ?? undefined,
                                dataId: typeof params.dataId === 'string' ? params.dataId : undefined,
                            },
                        });
                        return null;
                    },
                } : null}
                focusMode="routeFocus"
                showInlineHeader={false}
            />
        </>
    );
}
