import * as React from 'react';

import { useRouter } from 'expo-router';

import { buildMachinePickerRouteParams, buildProfilePickerRouteParams, buildServerPickerRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import type { AgentId } from '@/agents/catalog/catalog';

export function useNewSessionRouteHandlers(params: Readonly<{
    dataId?: string;
    selectedProfileId: string | null;
    selectedMachineId: string | null;
    selectedPath: string | null;
    targetServerId: string | null;
    resumeSessionId: string | null;
    agentType: AgentId;
}>): Readonly<{
    handleProfileClick: () => void;
    handlePathClick: () => void;
    handleResumeClick: () => void;
    handleMachineClick: () => void;
    handleServerClick: () => void;
}> {
    const router = useRouter();

    const handleProfileClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/profile',
            params: buildProfilePickerRouteParams({
                dataId: params.dataId,
                selectedProfileId: params.selectedProfileId,
                selectedMachineId: params.selectedMachineId,
                targetServerId: params.targetServerId,
            }),
        });
    }, [params.dataId, params.selectedMachineId, params.selectedProfileId, params.targetServerId, router]);

    const handlePathClick = React.useCallback(() => {
        if (params.selectedMachineId) {
            router.push({
                pathname: '/new/pick/path',
                params: {
                    ...(typeof params.dataId === 'string' && params.dataId.length > 0 ? { dataId: params.dataId } : {}),
                    machineId: params.selectedMachineId,
                    selectedPath: params.selectedPath,
                    ...(params.targetServerId ? { spawnServerId: params.targetServerId } : {}),
                },
            });
        }
    }, [params.dataId, params.selectedMachineId, params.selectedPath, params.targetServerId, router]);

    const handleResumeClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/resume' as const,
            params: {
                currentResumeId: params.resumeSessionId,
                agentType: params.agentType,
            },
        });
    }, [params.agentType, params.resumeSessionId, router]);

    const handleMachineClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/machine',
            params: buildMachinePickerRouteParams({
                dataId: params.dataId,
                selectedMachineId: params.selectedMachineId,
                targetServerId: params.targetServerId,
            }),
        });
    }, [params.dataId, params.selectedMachineId, params.targetServerId, router]);

    const handleServerClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/server',
            params: buildServerPickerRouteParams({
                dataId: params.dataId,
                targetServerId: params.targetServerId,
            }),
        });
    }, [params.dataId, params.targetServerId, router]);

    return {
        handleProfileClick,
        handlePathClick,
        handleResumeClick,
        handleMachineClick,
        handleServerClick,
    };
}
