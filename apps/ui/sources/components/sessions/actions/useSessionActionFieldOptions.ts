import * as React from 'react';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { projectInputOptionsDependencies } from '@happier-dev/protocol/inputs';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useStableValueBySignature } from '@/components/sessions/transcript/items/stableValueBySignature';
import { useExecutionRunsBackendsForMachine, useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useSessionHasActionDrafts } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import { useInputFieldOptions, type InputFieldOptionsRequest } from './useInputFieldOptions';
import { buildSessionActionFieldOptionsHeightSignature, type ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';

function useSessionOptionRequests(sessionId: string, serverId: string | null | undefined): readonly InputFieldOptionsRequest[] {
    const address = normalizeSessionAddress(serverId, sessionId);
    const addressKey = address ? sessionAddressKey(address) : null;
    const selectRequests = React.useMemo(() => {
        let previousDrafts: unknown;
        let previousSignature = '[]';
        return (state: ReturnType<ReturnType<typeof getStorage>['getState']>) => {
            const drafts = addressKey ? state.sessionActionDraftsByAddressKey[addressKey] : undefined;
            if (drafts === previousDrafts) return previousSignature;
            previousDrafts = drafts;
            previousSignature = JSON.stringify((drafts ?? []).flatMap((draft) => {
                const id = ActionIdSchema.safeParse(draft.actionId);
                if (!id.success) return [];
                const input = projectInputOptionsDependencies(draft.input ?? {});
                return resolveEffectiveActionInputFields(getActionSpec(id.data), draft.input ?? {})
                    .filter((field) => field.optionsSourceId !== undefined || field.inputType !== undefined)
                    .map((field) => ({ field, actionId: id.data, draftInput: input }));
            }));
            return previousSignature;
        };
    }, [addressKey]);
    const signature = getStorage()(selectRequests);
    return React.useMemo(() => JSON.parse(signature) as readonly InputFieldOptionsRequest[], [signature]);
}

/** Card paint and transcript measurements consume the same demanded Action-option reads. */
export function useSessionActionFieldOptions(sessionId: string, preferredServerId?: string | null): ResolveSessionActionFieldOptions {
    const serverId = usePreferredServerIdForSession({ serverId: preferredServerId, sessionId }, true);
    const requests = useSessionOptionRequests(sessionId, serverId);
    const enabledAgentIds = useEnabledAgentIds();
    const backends = useExecutionRunsBackendsForSession(sessionId, serverId, requests.length > 0);
    return useInputFieldOptions({ sessionId, serverId, requests, enabled: requests.length > 0,
        refreshKey: JSON.stringify([enabledAgentIds, backends]) }).resolveOptions;
}

/** Machine-targeted forms resolve declared fields only while their owning surface demands them. */
export function useActionFieldOptionsForMachine(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    enabled: boolean;
    requests: readonly InputFieldOptionsRequest[];
}>): ResolveSessionActionFieldOptions {
    const enabledAgentIds = useEnabledAgentIds();
    const backends = useExecutionRunsBackendsForMachine({ ...params, enabled: params.enabled && params.requests.length > 0 });
    return useInputFieldOptions({ ...params, refreshKey: JSON.stringify([enabledAgentIds, backends]) }).resolveOptions;
}

/** Preserve height locality: availability changes can change controls without changing row geometry. */
export function useSessionActionFieldOptionsForRowHeight(sessionId: string, sessionServerId?: string | null): ResolveSessionActionFieldOptions {
    const serverId = usePreferredServerIdForSession({ serverId: sessionServerId, sessionId }, true);
    const hasActionDrafts = useSessionHasActionDrafts({ serverId, sessionId });
    const requests = useSessionOptionRequests(sessionId, serverId);
    const enabledAgentIds = useEnabledAgentIds();
    const backends = useExecutionRunsBackendsForSession(sessionId, serverId, hasActionDrafts && requests.length > 0);
    const resolved = useInputFieldOptions({ sessionId, serverId, requests, enabled: hasActionDrafts && requests.length > 0,
        refreshKey: JSON.stringify([enabledAgentIds, backends]) });
    const lists = Object.fromEntries(resolved.snapshot.map((state, index) => [String(index), state.options]));
    // Loading/disabled availability is not geometry. A source failure adds an in-flow notice.
    const heightSignature = JSON.stringify([buildSessionActionFieldOptionsHeightSignature(lists),
        resolved.snapshot.map((state) => state.status === 'failed')]);
    return useStableValueBySignature(resolved.resolveOptions, heightSignature);
}
