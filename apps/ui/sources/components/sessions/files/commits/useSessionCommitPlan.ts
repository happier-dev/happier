import * as React from 'react';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { getSessionDraftSnapshot, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import type { CommitProposal } from './commitProposal';
import { buildCommitHookFixPrompt } from './commitHookFixPrompt';
import { useScmCommitPlan } from './useScmCommitPlan';

const PENDING = { kind: 'workingTree' } as const;

/** The actual Session supplies its authority and composer to the shared saved commit-plan owner. */
export function useSessionCommitPlan(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    enabled: boolean;
    branch: string | null;
    onOpenComposer?: () => void;
}>) {
    const comparison = params.enabled ? PENDING : null;
    const bound = useSessionScmDiffSummaryBinding({ sessionId: params.sessionId, serverId: params.serverId, comparison, output: 'commitPlan' });
    const onAskHookFailure = React.useCallback((proposal: CommitProposal) => {
        const scope = bound.scope;
        const prompt = buildCommitHookFixPrompt(proposal);
        if (!scope || !prompt || !bound.isCurrent() || !bound.canSend || !params.onOpenComposer) return;
        const existing = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: params.sessionId })?.document.composer.text.value;
        const text = typeof existing === 'string' && existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${prompt}` : prompt;
        writeExistingSessionDraft({ scope, sessionId: params.sessionId, patch: { text,
            routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: null }) } }, materializationIntent: 'userEdit' });
        params.onOpenComposer();
    }, [bound.scope, bound.isCurrent, bound.canSend, params.onOpenComposer, params.sessionId]);
    return useScmCommitPlan({ bound,
        ...(params.onOpenComposer ? { onAskHookFailure } : {}) });
}
