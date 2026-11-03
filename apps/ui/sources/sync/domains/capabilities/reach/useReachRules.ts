import * as React from 'react';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useReachRulesState, type ExecuteReachRules } from './useReachRulesState';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { publishPromptLibrarySkillRulesDraft } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { t } from '@/text';
import { resolveSkillReachV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { resolveReachV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { useSkillFeatureEnabled } from '@/sync/domains/skills/useSkillFeatureEnabled';

export type { ReachRulesWriteResult } from './useReachRulesState';
export function useReachRules(kind: 'skill' | 'mcp_server', itemId: string, requestedScope?: ServerAccountScope | null) {
    const catalog = useReachRulesCatalog(kind, itemId, requestedScope);
    const isFeatureEnabled = useSkillFeatureEnabled(kind === 'skill' ? catalog.scope?.serverId : null);
    const resolveReach = React.useCallback<typeof resolveReachV1>((rules, context) => kind === 'skill'
        ? resolveSkillReachV1(itemId, rules, context, isFeatureEnabled) : resolveReachV1(rules, context), [kind, itemId, isFeatureEnabled]);
    const execution = useMountedActionExecution(catalog.scope);
    const execute = React.useCallback<ExecuteReachRules>((actionId, input) => execution.execute(actionId, input), [execution.execute]);
    const key = JSON.stringify([catalog.scope?.serverId, catalog.scope?.accountId, kind, itemId]);
    const publish = React.useCallback((rules: ReachRulesV1 | null) => {
        if (kind === 'skill' && catalog.scope) publishPromptLibrarySkillRulesDraft(catalog.scope, itemId, rules);
    }, [kind, catalog.scope, itemId]);
    const state = useReachRulesState({ key, kind, itemId, rules: catalog.acknowledgedRules,
        status: catalog.status, revision: catalog.revision, valueAvailable: catalog.valueAvailable }, execute, publish);
    const change = React.useCallback((input: ReachRulesChangeV1, options?: Readonly<{ message?: string }>) => {
        const pending = state.change(input);
        const noticeKey = `reach:${key}`;
        void pending.then(result => {
            if (!result.ok) return;
            publishPresentationNotice({ key: noticeKey, message: options?.message ?? t('capabilities.control.title'), severity: 'info',
                undo: { label: t('bots.undo'), run: () => {
                    void state.undoLast().then(result => {
                        if (!result.ok) publishPresentationNotice({ key: noticeKey, message: t('capabilities.control.changeFailed'), severity: 'error' });
                    });
                } } });
        });
        return pending;
    }, [state.change, state.undoLast, key]);
    const newerReceipt = state.revision !== 'absent' && (catalog.revision === 'absent' || state.revision > catalog.revision);
    return { ...state, rules: kind === 'skill' && !newerReceipt ? catalog.rules : state.rules, change, resolveReach };
}
