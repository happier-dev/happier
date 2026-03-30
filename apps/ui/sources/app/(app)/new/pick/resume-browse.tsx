import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { View } from 'react-native';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { DirectSessionsBrowseScreen } from '@/components/sessions/directSessions/browse/DirectSessionsBrowseScreen';
import { canBrowseDirectSessions, resolveDirectBrowseLockedSource } from '@/components/sessions/directSessions/browse/resolveDirectBrowseLockedSourceOption';
import { NewSessionScreenPortalScope, createNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function ResumeBrowsePickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const settings = useSettings() ?? settingsDefaults;
    const accountProfile = useAccountProfile();
    const params = useLocalSearchParams<{
        agentType?: AgentId;
        machineId?: string;
        spawnServerId?: string;
        dataId?: string;
    }>();

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

    const lockScope = React.useMemo(() => {
        if (!effectiveMachineId) return null;
        if (!canBrowseDirectSessions(agentType)) return null;
        const source = resolveDirectBrowseLockedSource({
            providerId: agentType as any,
            agentOptionState,
            profile: accountProfile,
            settings,
        });
        if (!source) return null;
        return {
            machineId: effectiveMachineId,
            serverId: effectiveServerId,
            providerId: agentType as any,
            source,
        };
    }, [accountProfile, agentOptionState, agentType, effectiveMachineId, effectiveServerId, settings]);

    React.useEffect(() => {
        if (lockScope) return;
        safeRouterBack({ router, navigation, fallbackHref: '/new' });
    }, [lockScope, navigation, router]);

    const headerTitle = t('directSessions.browseTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = React.useMemo(() => {
        return createNewSessionContainedModalScreenOptions({
            title: headerTitle,
            headerBackTitle,
        });
    }, [headerBackTitle, headerTitle]);

    return (
        <NewSessionScreenPortalScope>
            <Stack.Screen options={screenOptions} />
            <View style={{ flex: 1, minHeight: 0 }}>
                {lockScope ? (
                    <DirectSessionsBrowseScreen
                        interaction="pickRemoteSessionId"
                        lockScope={lockScope}
                        onPickRemoteSessionId={(remoteSessionId) => {
                            const returnMode = setNewSessionPickerReturnParams({
                                navigation,
                                router,
                                routeParams: { resumeSessionId: remoteSessionId },
                            });
                            if (returnMode === 'dispatch') {
                                safeRouterBack({ router, navigation, fallbackHref: '/new' });
                            }
                        }}
                    />
                ) : null}
            </View>
        </NewSessionScreenPortalScope>
    );
}
