import * as React from 'react';
import { SessionCapabilitySelectionAuthoringV1Schema, areSessionCapabilitySelectionsEquivalentV1,
    type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol/mcp/servers/previewV1';
import { EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { normalizeCredentialScopeServerId, useServerCredentialAccountScopeBinding, useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { SpawnCapabilitiesPreviewOutputV1Schema, type SpawnCapabilitiesPreviewOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { isMachineRequestReachabilityFailure } from '@/sync/domains/machines/reachability/machineReachability';
import { isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { setSessionCapabilitySelectionItem } from './sessionCapabilitySelectionState';

type Preview = Extract<SpawnCapabilitiesPreviewOutputV1, { ok: true }>;
type McpPreview = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;
export type CapabilityPreviewStatus = 'idle' | 'loading' | 'ready' | 'unreachable' | 'error';

export type CapabilityPreviewContext = Readonly<{
    machineId: string | null; directory: string; agentId: string; targetServerId?: string | null;
    projectKey?: string; profileId?: string;
}>;
const DEFAULT_SELECTION: SessionCapabilitySelectionV1 = {};
const NO_HOMES: readonly string[] = [];

function intersectPreviewItems<T extends { id: string; selectable: boolean }>(items: readonly T[], peers: readonly (readonly T[])[]): T[] {
    const peerItems = peers.map(peer => new Map(peer.map(item => [item.id, item])));
    return items.filter(item => peerItems.every(peer => peer.has(item.id))).map(item =>
        peerItems.some(peer => peer.get(item.id)?.selectable === false) ? { ...item, selectable: false } : item);
}

function intersectPolicyPreviews(first: Preview, others: readonly Preview[]): Preview {
    if (others.length === 0) return first;
    return { ...first,
        skills: { plan: { ...first.skills.plan, nativeDisables: [] },
            items: intersectPreviewItems(first.skills.items, others.map(preview => preview.skills.items)) },
        mcp: { ...first.mcp, detected: [], items: intersectPreviewItems(first.mcp.items, others.map(preview => preview.mcp.items)) },
    };
}

/** Draft selection and demanded preview through the canonical capability Action. */
export function useNewSessionCapabilities(draft: CapabilityPreviewContext & Readonly<{
    /** In recipient order, including recipients that share a policy context. */
    policyContexts?: readonly CapabilityPreviewContext[];
    portableOnly?: boolean; enabled?: boolean;
    agentAcceptsUserMcp?: boolean;
    selection: SessionCapabilitySelectionV1;
    setSelection: React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>;
}>) {
    const [demanded, setDemanded] = React.useState(false);
    const enabled = draft.enabled !== false;
    const active = useActiveServerSnapshot(!draft.targetServerId);
    const targetServerId = draft.targetServerId ?? active.serverId;
    const primaryServerId = normalizeCredentialScopeServerId(targetServerId);
    const primaryScope = useServerCredentialAccountScopeBinding(targetServerId);
    const { binding } = primaryScope;
    const execution = useMountedActionExecution(binding?.scope);
    const candidateTargets = React.useMemo(() => {
        const contexts = draft.policyContexts?.length ? draft.policyContexts : [{
            machineId: draft.machineId, directory: draft.directory, agentId: draft.agentId,
            targetServerId: draft.targetServerId, projectKey: draft.projectKey, profileId: draft.profileId,
        }];
        return contexts.map(context => {
            const serverId = normalizeCredentialScopeServerId(context.targetServerId ?? targetServerId);
            const machineId = draft.portableOnly ? EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 : context.machineId;
            const directory = draft.portableOnly ? '' : context.directory.trim();
            const projectKey = draft.portableOnly ? undefined : context.projectKey;
            return { serverId, machineId, directory, projectKey, agentId: context.agentId, profileId: context.profileId,
                key: JSON.stringify([serverId, machineId, directory, projectKey, context.agentId, context.profileId]) };
        });
    }, [draft.policyContexts, draft.machineId, draft.directory, draft.agentId, draft.targetServerId, draft.projectKey, draft.profileId, draft.portableOnly, targetServerId]);
    const targetKeys = JSON.stringify(candidateTargets.map(target => target.key));
    // An authoring render can rebuild recipient descriptors without changing the demanded Machine inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const targets = React.useMemo(() => candidateTargets, [targetKeys]);
    const lead = targets[0]!;
    const sharedNativeSource = targets.every(target =>
        target.serverId === lead.serverId && target.machineId === lead.machineId && target.agentId === lead.agentId);
    const otherHomeIds = React.useMemo(() => targets.map(target => target.serverId).filter(id => id !== primaryServerId), [targets, primaryServerId]);
    const otherScopes = useServerCredentialAccountScopeStates(demanded && enabled ? otherHomeIds : NO_HOMES);
    const requests = React.useMemo(() => new Map(targets.map(target => [
        target.key, { target, scope: target.serverId === primaryServerId ? primaryScope : otherScopes.get(target.serverId) },
    ])), [targets, primaryServerId, primaryScope, otherScopes]);
    const contextKey = JSON.stringify([targetKeys, [...requests.values()].map(({ scope }) =>
        [scope?.binding?.accountId, scope?.binding?.revision])]);
    const [previewState, setPreviewState] = React.useState<Readonly<{ contextKey: string; value: Preview; mcp: McpPreview | null;
        policies: readonly Preview[] | undefined }> | null>(null);
    const preview = previewState?.contextKey === contextKey ? previewState.value : null;
    const mcpPreview = previewState?.contextKey === contextKey ? previewState.mcp : null;
    const policyPreviews = previewState?.contextKey === contextKey ? previewState.policies : undefined;
    const [previewStatus, setPreviewStatus] = React.useState<CapabilityPreviewStatus>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const [unsupported, setUnsupported] = React.useState(false);
    const requestRef = React.useRef(0);
    const pendingRequest = React.useRef<number | null>(null);
    const requestedFacts = React.useRef<Readonly<{ contextKey: string; factsKey: string }> | null>(null);
    const selection = React.useMemo(() => SessionCapabilitySelectionAuthoringV1Schema.parse(draft.selection), [draft.selection]);
    const previewSelection = requests.size === 1 ? selection : DEFAULT_SELECTION;
    const setItem = React.useCallback((kind: 'skill' | 'mcp_server' | 'native_skill', id: string, state: 'on' | 'off' | 'inherit') => {
        draft.setSelection(current => {
            const next = setSessionCapabilitySelectionItem(current, kind, id, state);
            return areSessionCapabilitySelectionsEquivalentV1(current, next) ? current : next;
        });
    }, [draft.setSelection]);
    const refresh = React.useCallback(async (factsKey?: string) => {
        if (typeof factsKey === 'string' && requestedFacts.current?.contextKey === contextKey && requestedFacts.current.factsKey === factsKey) return;
        requestedFacts.current = typeof factsKey === 'string' ? { contextKey, factsKey } : null;
        const request = ++requestRef.current;
        if (!enabled || targets.some(target => !target.machineId || !target.agentId)) {
            pendingRequest.current = null;
            setPreviewStatus('idle'); setError(null); setUnsupported(false);
            return;
        }
        const boundRequests = [];
        for (const { target, scope } of requests.values()) {
            if (scope?.binding) {
                boundRequests.push({ target, binding: scope.binding });
                continue;
            }
            pendingRequest.current = null;
            const reason = scope?.resolution.kind ?? 'unknown_home';
            setPreviewStatus(reason === 'resolving' || reason === 'bound' ? 'loading' : 'error');
            setError(reason === 'resolving' || reason === 'bound' ? null : reason);
            setUnsupported(false);
            return;
        }
        if (!execution.ready) return;
        pendingRequest.current = request;
        setPreviewStatus('loading'); setError(null); setUnsupported(false);
        try {
            const previews = await Promise.all(boundRequests.map(async ({ target, binding }) => {
                const input = { machineId: target.machineId!, agentId: target.agentId,
                    ...(target.directory ? { directory: target.directory } : {}),
                    ...(target.projectKey ? { projectKey: target.projectKey } : {}),
                    ...(target.profileId ? { profileId: target.profileId } : {}),
                    capabilitySelection: previewSelection,
                };
                const receipt = target.serverId === primaryServerId
                    ? await execution.execute('sessions.spawn.capabilities.preview', input)
                    : await execution.executeCaptured(binding, 'sessions.spawn.capabilities.preview', input);
                const parsed = receipt.ok ? SpawnCapabilitiesPreviewOutputV1Schema.safeParse(receipt.result) : null;
                if (parsed?.success && parsed.data.ok) return { key: target.key, preview: parsed.data } as const;
                const error = !receipt.ok ? receipt.errorCode ?? receipt.error : parsed?.success && !parsed.data.ok ? parsed.data.reason : 'invalid_action_output';
                return { key: target.key, error } as const;
            }));
            if (request !== requestRef.current) return;
            const failed = previews.find(item => 'error' in item);
            if (typeof failed?.error === 'string') {
                const message = failed.error;
                const unreachable = message === 'machine_unreachable' || isMachineRequestReachabilityFailure({ code: message });
                setError(message); setPreviewStatus(unreachable && sharedNativeSource ? 'unreachable' : 'error');
                setUnsupported(isRpcMethodNotFoundError({ rpcErrorCode: message }));
            } else {
                const byKey = new Map(previews.flatMap(item => 'preview' in item && item.preview ? [[item.key, item.preview] as const] : []));
                const all = [...byKey.values()];
                const response = intersectPolicyPreviews(all[0]!, all.slice(1));
                const completeRenderingProjection = response.mcp.items.every(item => item.preview !== undefined);
                setPreviewState(current => ({ contextKey, value: response,
                    policies: all.length > 1 ? targets.map(target => byKey.get(target.key)!) : undefined,
                    mcp: completeRenderingProjection ? { ok: true, builtIn: [], detected: response.mcp.detected,
                        managed: response.mcp.items.flatMap(item => item.preview ? [item.preview] : []) }
                        : current?.contextKey === contextKey ? current.mcp : null }));
                setPreviewStatus('ready');
            }
        } catch (failure) {
            if (request !== requestRef.current) return;
            setUnsupported(isRpcMethodNotFoundError(failure));
            setError(failure instanceof Error ? failure.message : String(failure));
            setPreviewStatus(isMachineRequestReachabilityFailure(failure) && sharedNativeSource ? 'unreachable' : 'error');
        } finally {
            if (pendingRequest.current === request) pendingRequest.current = null;
        }
    }, [enabled, targets, requests, primaryServerId, execution.ready, execution.execute, execution.executeCaptured, previewSelection, contextKey, sharedNativeSource]);
    React.useEffect(() => {
        if (demanded) void refresh();
        return () => { requestRef.current += 1; };
    }, [demanded, refresh]);
    const demandPreview = React.useCallback(() => {
        // Intent events share pending work; changed inputs and Retry remain fresh.
        if (pendingRequest.current !== null) return;
        if (demanded) void refresh();
        else setDemanded(true);
    }, [demanded, refresh]);
    const retry = React.useCallback(async (factsKey?: string) => {
        if (!demanded) { setDemanded(true); return; }
        await refresh(factsKey);
    }, [demanded, refresh]);
    const mcpPreviewError = preview?.mcp.items.some(item => item.preview === undefined) ? 'invalid_action_output' : null;
    return { selection, setItem, preview, policyPreviews, sharedNativeSource, mcpPreview, mcpPreviewError, previewStatus, lastKnownPreview: preview,
        error, unsupported, demandPreview, refresh: retry };
}
