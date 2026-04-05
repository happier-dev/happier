import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';
import type { TailscaleSecureAccessTaskResult } from '@happier-dev/protocol';
import type { RelayAccessConfig, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskSnapshot, RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import {
    buildRelayAccessDisableSystemTaskSpec,
    buildRelayAccessExecutionSystemTaskSpec,
    buildRelayAccessStatusSystemTaskSpec,
} from '@/components/systemTasks/specs/relayAccess/buildRelayAccessSystemTaskSpec';
import { t } from '@/text';

function readRelayAccessSnapshot(result: SystemTaskResult | null): RelayAccessTaskSnapshot | null {
    if (!result?.ok) {
        return null;
    }
    const data = result.data as Partial<RelayAccessTaskSnapshot> | null | undefined;
    if (!data || typeof data !== 'object') {
        return null;
    }
    if (typeof (data as any).configured !== 'boolean') {
        return null;
    }
    if (!data.status || typeof data.status !== 'object') {
        return null;
    }
    return data as RelayAccessTaskSnapshot;
}

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

function isTailscaleRelayAccessProviderId(providerId: RelayAccessProviderId | null): providerId is 'tailscaleServe' | 'tailscaleFunnel' {
    return providerId === 'tailscaleServe' || providerId === 'tailscaleFunnel';
}

function readTailscaleSecureAccessSnapshot(
    providerId: 'tailscaleServe' | 'tailscaleFunnel',
    result: SystemTaskResult | null,
): RelayAccessTaskSnapshot | null {
    if (!result?.ok) {
        return null;
    }
    const data = result.data as Partial<TailscaleSecureAccessTaskResult> | null | undefined;
    if (!data || typeof data !== 'object') {
        return null;
    }
    const shareUrl = typeof data.shareableHttpsUrl === 'string' ? data.shareableHttpsUrl.trim() : '';
    const requiresApproval = data.requiresApproval && typeof data.requiresApproval === 'object'
        ? data.requiresApproval
        : null;

    return {
        configured: true,
        providerId,
        status: {
            state: requiresApproval ? 'needs_auth' : (shareUrl ? 'enabled' : 'unknown'),
            shareUrl: shareUrl.length > 0 ? shareUrl : null,
            details: {
                tailscaleInstalled: data.tailscaleInstalled === true,
                tailscaleLoggedIn: data.tailscaleLoggedIn === true,
                serveEnabled: data.serveEnabled === true,
                requiresApproval,
            },
        },
    };
}

type RelayAccessActionKind = 'relay.access.configure.v1' | 'relay.access.disable.v1';

export type RelayAccessControlOptions = Readonly<{
    runner?: SystemTaskRunner;
    target?: RelayAccessTaskTarget;
    upstreamUrl?: string | null;
}>;

export function useRelayAccessControl(options: RelayAccessControlOptions = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const target = options.target ?? { kind: 'local' as const };
    const upstreamUrl = React.useMemo(() => {
        const value = typeof options.upstreamUrl === 'string' ? options.upstreamUrl.trim() : '';
        return value.length > 0 ? value : null;
    }, [options.upstreamUrl]);
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [statusTaskId, setStatusTaskId] = React.useState<string | null>(null);
    const [actionTaskId, setActionTaskId] = React.useState<string | null>(null);
    const [lastSnapshot, setLastSnapshot] = React.useState<RelayAccessTaskSnapshot | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledActionTaskIdRef = React.useRef<string | null>(null);
    const lastActionProviderIdRef = React.useRef<RelayAccessProviderId | null>(null);

    const statusSnapshot = useSystemTaskSnapshot(runner, statusTaskId);
    const actionSnapshot = useSystemTaskSnapshot(runner, actionTaskId);

    const startTask = React.useCallback(async (kind: 'relay.access.status.v1' | RelayAccessActionKind, params?: Readonly<{
        providerId?: RelayAccessProviderId;
        config?: RelayAccessConfig;
    }>) => {
        try {
            const taskId =
                kind === 'relay.access.status.v1'
                    ? await runner.start(buildRelayAccessStatusSystemTaskSpec({ target }))
                    : kind === 'relay.access.disable.v1'
                        ? await runner.start(buildRelayAccessDisableSystemTaskSpec({ target }))
                        : await runner.start(buildRelayAccessExecutionSystemTaskSpec({
                            target,
                            providerId: params?.providerId as RelayAccessProviderId,
                            config: params?.config as RelayAccessConfig,
                            upstreamUrl,
                        }));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [runner, target, upstreamUrl]);

    const refreshStatus = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        const taskId = await startTask('relay.access.status.v1');
        if (!taskId) return null;
        setStatusTaskId(taskId);
        return taskId;
    }, [isUnavailable, startTask]);

    const runAction = React.useCallback(async (kind: RelayAccessActionKind, payload?: Readonly<{
        providerId: RelayAccessProviderId;
        config: RelayAccessConfig;
    }>) => {
        if (isUnavailable) {
            return null;
        }
        lastActionProviderIdRef.current = payload?.providerId ?? null;
        const taskId = await startTask(kind, payload);
        if (!taskId) return null;
        handledActionTaskIdRef.current = null;
        setActionTaskId(taskId);
        return taskId;
    }, [isUnavailable, startTask]);

    React.useEffect(() => {
        if (isUnavailable) return;
        if (autoRefreshRequestedRef.current) return;
        autoRefreshRequestedRef.current = true;
        void refreshStatus().catch(() => {});
    }, [isUnavailable, refreshStatus]);

    React.useEffect(() => {
        const nextSnapshot = readRelayAccessSnapshot(statusSnapshot?.result ?? null);
        if (nextSnapshot) {
            setLastSnapshot(nextSnapshot);
            setLastErrorMessage(null);
            return;
        }
        const errorMessage = readErrorMessage(statusSnapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [statusSnapshot]);

    React.useEffect(() => {
        if (!actionSnapshot?.result || handledActionTaskIdRef.current === actionSnapshot.taskId) {
            return;
        }
        handledActionTaskIdRef.current = actionSnapshot.taskId;
        if (!actionSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(actionSnapshot.result));
            return;
        }

        const providerId = lastActionProviderIdRef.current;
        if (isTailscaleRelayAccessProviderId(providerId)) {
            const inlineSnapshot = readTailscaleSecureAccessSnapshot(providerId, actionSnapshot.result);
            if (inlineSnapshot) {
                setLastSnapshot(inlineSnapshot);
                setLastErrorMessage(null);
                void refreshStatus().catch(() => {});
                return;
            }
        }

        const inlineSnapshot = readRelayAccessSnapshot(actionSnapshot.result);
        if (inlineSnapshot) {
            setLastSnapshot(inlineSnapshot);
            setLastErrorMessage(null);
        }
        void refreshStatus().catch(() => {});
    }, [actionSnapshot, refreshStatus]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = actionSnapshot?.result ? null : actionSnapshot ?? (statusSnapshot?.result ? null : statusSnapshot);
        return snapshot ?? null;
    }, [actionSnapshot, statusSnapshot]);

    const isBusy = activeTaskSnapshot != null && activeTaskSnapshot.result == null;

    return {
        activeTaskSnapshot,
        configure: React.useCallback(async (payload: Readonly<{ providerId: RelayAccessProviderId; config: RelayAccessConfig }>) => {
            return await runAction('relay.access.configure.v1', payload);
        }, [runAction]),
        disable: React.useCallback(async () => {
            return await runAction('relay.access.disable.v1');
        }, [runAction]),
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        snapshot: lastSnapshot,
    };
}
