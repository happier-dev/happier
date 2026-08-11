import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { t } from '@/text';

import {
    buildSessionActionFieldOptionsResolver,
    type ResolveSessionActionFieldOptions,
} from './sessionActionFieldOptions';

function resolveAgentLabel(agentId: string): string {
    return t(getAgentCore(agentId as AgentId).displayNameKey);
}

/** The card's resolver: the full paint, including the snapshot-derived `disabled` flags. */
export function useSessionActionFieldOptions(sessionId: string): ResolveSessionActionFieldOptions {
    const enabledAgentIds = useEnabledAgentIds();
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId);
    return React.useMemo(
        () => buildSessionActionFieldOptionsResolver({
            enabledAgentIds,
            executionRunsBackends,
            resolveAgentLabel,
        }),
        [enabledAgentIds, executionRunsBackends],
    );
}

/**
 * The transcript's resolver — the NARROWEST subscription that answers "what option set does this
 * draft row paint".
 *
 * `useTranscriptItemsPipeline` produces the size key for EVERY row, so whatever it subscribes to is
 * a cost the whole transcript pays. This takes exactly one narrow settings subscription
 * (`useSetting('backendEnabledByTargetKey')`, inside `useEnabledAgentIds`) and deliberately does NOT
 * take the machine-capabilities snapshot: in this repo that snapshot cannot change a painted
 * option's id or label (see `buildSessionActionFieldOptionsResolver`), and reading it would drag
 * `useExecutionRunsBackendsForSession`'s whole-session `useSession` subscription into the transcript
 * for a flag that only reaches chip opacity.
 *
 * The returned resolver's identity is keyed on the enabled agent id LIST, not on the settings record
 * it is derived from, so a settings write that leaves that list alone cannot churn
 * `buildRowShellSignature` — and every row's size version through it. The list is rebuilt from the
 * dep itself, so there is no stale closure.
 */
export function useSessionActionFieldOptionsForRowHeight(): ResolveSessionActionFieldOptions {
    const enabledAgentIds = useEnabledAgentIds();
    const enabledAgentIdsKey = enabledAgentIds.join('|');
    return React.useMemo(
        () => buildSessionActionFieldOptionsResolver({
            enabledAgentIds: enabledAgentIdsKey.length > 0 ? enabledAgentIdsKey.split('|') : [],
            executionRunsBackends: null,
            resolveAgentLabel,
        }),
        [enabledAgentIdsKey],
    );
}
