import * as React from 'react';

import {
    PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1,
    formatUiSurfaceActionRequestV1,
    type NormalizedUiSurfaceCapabilityRequestV1,
    type UiSurfaceExecutableApprovalKeyV1,
} from '@happier-dev/protocol/plugins/ui';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useLocalSettingMutable } from '@/sync/store/hooks';

import { resolveHostedFrameHostOrigin } from '../framed/hostOrigin';
import type { CallerHostedHtmlRuntime } from './HostedHtmlSurfaceAdapter';
import { createSessionCallerHostedHtmlRequestController } from './sessionCallerHostedHtmlRequestController';
import { isHostedInlineDocumentFrameAvailable } from './hostedInlineDocumentFrameCapability';

function hasSameApprovalScope(left: UiSurfaceExecutableApprovalKeyV1, right: UiSurfaceExecutableApprovalKeyV1): boolean {
    return left.serverIdentityId === right.serverIdentityId
        && left.accountId === right.accountId
        && left.approvalSubject === right.approvalSubject
        && left.executableSecurityFingerprint === right.executableSecurityFingerprint;
}

function isCapabilitySubset(
    requested: NormalizedUiSurfaceCapabilityRequestV1,
    approved: NormalizedUiSurfaceCapabilityRequestV1,
): boolean {
    const resources = new Set(approved.resources.map(formatUiSurfaceActionRequestV1));
    const actions = new Set(approved.actions.map(formatUiSurfaceActionRequestV1));
    return requested.hostMethods.every((method) => approved.hostMethods.includes(method))
        && requested.resources.every((resource) => resources.has(formatUiSurfaceActionRequestV1(resource)))
        && requested.actions.every((action) => actions.has(formatUiSurfaceActionRequestV1(action)))
        && requested.networkOrigins.every((origin) => approved.networkOrigins.includes(origin));
}

/** Exact-Home Session adapter for caller-authored HTML. */
export function useSessionCallerHostedHtmlRuntime(
    serverId: string | null | undefined,
    sessionId: string,
    pluginRuntime?: SessionPluginRuntimeState,
): CallerHostedHtmlRuntime | null {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const [approvals, setApprovals] = useLocalSettingMutable('uiSurfaceExecutableApprovalsV1');
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const pluginRuntimeRef = React.useRef(pluginRuntime);
    pluginRuntimeRef.current = pluginRuntime;
    const pluginPhase = pluginRuntime?.phase;
    const pluginInteractionEnabled = pluginRuntime?.interactionEnabled;
    const pluginServerId = pluginRuntime?.serverId;
    const pluginMachineId = pluginRuntime?.machineId;
    const pluginUiProjection = pluginRuntime?.pluginUiProjection;
    const session = useSessionViewShellSession(sessionId, serverId);
    const sessionCurrent = session?.access?.capabilities.readTranscript === true;
    const sessionCurrentRef = React.useRef(sessionCurrent);
    sessionCurrentRef.current = sessionCurrent;
    const hostOrigin = resolveHostedFrameHostOrigin();
    // Approval is mutable access consulted at decision time, not part of the
    // physical mount's authority lifetime: approving or revoking one item must
    // not hand every other mounted item a new lifetime or request owner.
    const approvalsRef = React.useRef(approvals);
    approvalsRef.current = approvals;

    const authority = React.useMemo<Omit<CallerHostedHtmlRuntime, 'isApproved'> | null>(() => {
        if (!binding || !hostOrigin || !binding.isCurrent() || !sessionCurrent
            || !isHostedInlineDocumentFrameAvailable()) return null;
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(binding.serverId);
        if (serverIdentityId === null) return null;
        const isCurrent = () => binding.isCurrent() && sessionCurrentRef.current;
        const pluginTargetCurrent = pluginPhase === 'current'
            && pluginInteractionEnabled
            && pluginServerId != null
            && areServerProfileIdentifiersEquivalent(pluginServerId, binding.serverId)
            && pluginMachineId != null
            && pluginUiProjection?.generation != null;
        const pluginTarget = pluginTargetCurrent ? {
            machineId: pluginMachineId,
            serverId: pluginServerId,
            generation: pluginUiProjection.generation,
            projection: pluginUiProjection,
            isCurrent: () => isCurrent()
                && pluginRuntimeRef.current?.phase === 'current'
                && pluginRuntimeRef.current.interactionEnabled
                && areServerProfileIdentifiersEquivalent(pluginRuntimeRef.current.serverId, binding.serverId)
                && pluginRuntimeRef.current.machineId === pluginMachineId
                && pluginRuntimeRef.current.pluginUiProjection?.generation
                    === pluginUiProjection.generation,
        } : null;
        return Object.freeze({
            serverIdentityId,
            accountId: binding.accountId,
            hostOrigin,
            admittedHostMethods: PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1.filter(
                (method) => method === 'context' || method === 'watchContext'
                    || method === 'executeAction' || method === 'notify'
                    || (pluginTarget !== null && (method === 'readResource' || method === 'watchResource')),
            ),
            approve: (approval, approvalKey, capabilities) => setApprovals({
                ...approvalsRef.current, [approvalKey]: { approval, capabilities },
            }),
            revoke: (approval, approvalKey) => {
                const next = { ...approvalsRef.current };
                delete next[approvalKey];
                // A narrowed request can be admitted by an earlier broader
                // approval. Revocation must remove that consent as well.
                for (const [key, entry] of Object.entries(next)) {
                    if (entry !== true && hasSameApprovalScope(entry.approval, approval)) delete next[key];
                }
                setApprovals(next);
            },
            createRequestController: (publishResourceEvent) => createSessionCallerHostedHtmlRequestController({
                sessionId,
                serverId: binding.serverId,
                serverIdentityId,
                accountId: binding.accountId,
                executeHostAction: execute,
                isAccountCurrent: binding.isCurrent,
                isSessionCurrent: () => sessionCurrentRef.current,
                pluginTarget,
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
    }, [binding, execute, hostOrigin, pluginPhase, pluginInteractionEnabled, pluginServerId,
        pluginMachineId, pluginUiProjection, sessionCurrent, sessionId, setApprovals]);

    // A new runtime value on approval change re-renders its adapters so each
    // re-reads its own exact approval; `lifetime` and `createRequestController`
    // keep their identity, so an unchanged item's mount stays connected.
    return React.useMemo<CallerHostedHtmlRuntime | null>(() => authority === null ? null : Object.freeze({
        ...authority,
        isApproved: (approval, approvalKey, capabilities) => approvals[approvalKey] === true
            || Object.values(approvals).some((entry) => entry !== true
                && hasSameApprovalScope(entry.approval, approval)
                && isCapabilitySubset(capabilities, entry.capabilities)),
    }), [approvals, authority]);
}
