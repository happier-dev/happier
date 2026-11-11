import * as React from 'react';

import { PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1 } from '@happier-dev/protocol/plugins/ui';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { usePluginSurfaceAccountEncryptionMode } from '@/components/plugins/surfaces/pluginSurfaceContext';

import { resolveHostedFrameHostOrigin } from '../framed/hostOrigin';
import type { CallerHostedHtmlRuntime } from './HostedHtmlSurfaceAdapter';
import { createSessionCallerHostedHtmlRequestController } from './sessionCallerHostedHtmlRequestController';
import { isHostedInlineDocumentFrameAvailable } from './hostedInlineDocumentFrameCapability';

/** Current viewer adapter for caller-authored HTML; a bound Session retains its read guard. */
export function useSessionCallerHostedHtmlRuntime(
    serverId: string | null | undefined,
    sessionId: string | undefined,
    pluginRuntime?: PluginUiProjectionCurrentness,
    isSurfaceCurrent?: () => boolean,
): CallerHostedHtmlRuntime | null {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const pluginRuntimeRef = React.useRef(pluginRuntime);
    pluginRuntimeRef.current = pluginRuntime;
    const pluginPhase = pluginRuntime?.phase;
    const pluginInteractionEnabled = pluginRuntime?.interactionEnabled;
    const pluginServerId = pluginRuntime?.serverId;
    const pluginMachineId = pluginRuntime?.machineId;
    const pluginUiProjection = pluginRuntime?.pluginUiProjection;
    const session = useSessionViewShellSession(sessionId ?? '', serverId);
    const sessionCurrent = sessionId === undefined || session?.access?.capabilities.readTranscript === true;
    const sessionCurrentRef = React.useRef(sessionCurrent);
    sessionCurrentRef.current = sessionCurrent;
    const sessionOwnedRef = React.useRef(session?.access?.role === 'owner');
    sessionOwnedRef.current = session?.access?.role === 'owner';
    const surfaceCurrentRef = React.useRef(isSurfaceCurrent);
    surfaceCurrentRef.current = isSurfaceCurrent;
    const hostOrigin = resolveHostedFrameHostOrigin();
    const resolveMode = React.useCallback(async (signal: AbortSignal) => {
        if (!binding?.isCurrent()) throw new Error('caller_account_unavailable');
        const account = await captureLazyActionAccountContext(binding.serverId, signal);
        try {
            if (account.accountId !== binding.accountId) throw new Error('caller_account_unavailable');
            return await account.resolveAccountMode();
        } finally {
            account.dispose();
        }
    }, [binding]);
    const accountMode = usePluginSurfaceAccountEncryptionMode({
        accountLifetime: binding,
        resolveMode,
    });
    const accountModeRef = React.useRef(accountMode);
    accountModeRef.current = accountMode;
    return React.useMemo<CallerHostedHtmlRuntime | null>(() => {
        if (!binding || accountMode.status !== 'ready' || !hostOrigin || !binding.isCurrent() || !sessionCurrent
            || !isHostedInlineDocumentFrameAvailable()) return null;
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(binding.serverId);
        if (serverIdentityId === null) return null;
        const isCurrent = () => binding.isCurrent() && accountModeRef.current === accountMode
            && sessionCurrentRef.current && surfaceCurrentRef.current?.() !== false;
        const pluginTargetCurrent = pluginPhase === 'current'
            && pluginInteractionEnabled
            && (pluginServerId === null || pluginServerId !== undefined && areServerProfileIdentifiersEquivalent(pluginServerId, binding.serverId))
            && pluginUiProjection != null;
        const pluginTarget = pluginTargetCurrent ? {
            machineId: pluginMachineId ?? null,
            serverId: pluginServerId ?? null,
            projection: pluginUiProjection,
            isCurrent: () => isCurrent()
                && pluginRuntimeRef.current?.phase === 'current'
                && pluginRuntimeRef.current.interactionEnabled
                && (pluginRuntimeRef.current.serverId === null || areServerProfileIdentifiersEquivalent(pluginRuntimeRef.current.serverId, binding.serverId))
                && pluginRuntimeRef.current.machineId === pluginMachineId,
        } : null;
        return Object.freeze({
            serverIdentityId,
            accountId: binding.accountId,
            accountEncryptionMode: accountMode.mode,
            hostOrigin,
            admittedHostMethods: PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1.filter(
                (method) => method === 'context' || method === 'watchContext'
                    || method === 'executeAction' || method === 'notify'
                    || (pluginTarget !== null && (method === 'readResource' || method === 'watchResource')),
            ),
            createRequestController: (publishResourceEvent, mount) => createSessionCallerHostedHtmlRequestController({
                sessionId,
                serverId: binding.serverId,
                serverIdentityId,
                accountId: binding.accountId,
                executeHostAction: execute,
                isAccountCurrent: isCurrent,
                isSessionCurrent: () => sessionCurrentRef.current,
                isSessionOwned: () => sessionOwnedRef.current,
                readActionsSettings: async signal => {
                    const account = await captureLazyActionAccountContext(binding.serverId, signal);
                    try {
                        if (account.accountId !== binding.accountId) throw new Error('caller_account_unavailable');
                        const settings = await account.readSettings();
                        return normalizeActionsSettingsV1(settings.actionsSettingsV1);
                    } finally { account.dispose(); }
                },
                pluginTarget,
                surfaceTarget: mount?.target,
                mountInstanceKey: mount?.mountInstanceKey,
                launchInput: mount?.input,
                publishResourceEvent,
                notify: ({ requestId, message, severity }) => publishPresentationNotice({
                    key: `caller-hosted-html:${binding.serverId}:${requestId}`,
                    message,
                    severity,
                }),
            }),
            lifetime: Object.freeze({
                isCurrent,
                onRetire: binding.onRetire,
            }),
        });
    }, [accountMode, binding, execute, hostOrigin, pluginPhase, pluginInteractionEnabled, pluginServerId,
        pluginMachineId, pluginUiProjection, sessionCurrent, sessionId]);
}
