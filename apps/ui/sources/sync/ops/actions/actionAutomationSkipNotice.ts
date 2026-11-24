import { readActionAutomationSkipReasonV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { formatAutomaticCheckSkipNotice, formatAutomationsNotCheckedNotice } from '@/components/approvals/formatAutomaticCheckSkipNotice';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { SERVER_UNREACHABLE_ERROR_CODE } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { t } from '@/text';
import type { ActionExecutorContext, ActionPrepareResult } from '@happier-dev/protocol/actions/executor/types';

/** The app's execution boundary presents the receipt before a consumer unwraps it. */
export function captureAppActionAutomationPresentation(
    target?: Pick<ActionExecutorContext, 'serverId' | 'surface' | 'authority' | 'expectedAccountId' | 'runtimeAccountId'>,
) {
    const surface = target?.surface ?? 'ui';
    const presentsInApp = surface === 'ui' || surface === 'voice' || surface === 'plugin'
        || (surface === 'rpc' && target?.authority === 'present_user');
    const lifetime = presentsInApp
        ? captureActiveServerAccountScopeLifetime() : null;
    const accountId = target?.expectedAccountId ?? target?.runtimeAccountId;
    const current = lifetime && (!accountId || lifetime.scope.accountId === accountId)
        && (!target?.serverId || areServerProfileIdentifiersEquivalent(target.serverId, lifetime.scope.serverId))
        ? lifetime : null;
    const settled = (result: ActionExecuteResult): ActionExecuteResult => {
        if (result.ok && current && result.automationNotices?.length) void presentActionAutomationSkipNotice(result, current);
        return result;
    };
    return { settled, prepared(prepared: ActionPrepareResult): ActionPrepareResult {
        if (!current) return prepared;
        if (prepared.kind === 'settled') {
            settled(prepared.result);
            return prepared;
        }
        let receipt: Promise<ActionExecuteResult> | undefined;
        return { ...prepared, invocation: { ...prepared.invocation,
            run: () => receipt ??= prepared.invocation.run().then(settled),
        } };
    } };
}

/**
 * Present the Action owner's settled notices without loading Workflow steps or rerunning checks.
 *
 * Every notice here is fail-open: the Action already proceeded and there is nothing to decide, so it
 * is the transient notice, never a dialog. A refusal is a failed result and keeps its own presenter.
 */
export async function presentActionAutomationSkipNotice(
    result: Pick<ActionExecuteResult, 'automationNotices'>,
    lifetime?: ServerAccountScopeLifetime | null,
): Promise<void> {
    const notices = result.automationNotices ?? [];
    const skipped = notices.filter(notice => notice.code === 'action_automation_skipped');
    let notChecked = notices.flatMap(notice => notice.code === 'action_automations_not_checked' ? [notice.reason] : []);
    if ((notChecked.length === 0 && skipped.length === 0) || lifetime?.isCurrent() === false) return;
    if (notChecked.includes(SERVER_UNREACHABLE_ERROR_CODE)) {
        // One fact, once: when the page already says this Home can't be reached, the unreachable note adds nothing.
        const { readHomeShownUnavailable } = await import('@/components/navigation/connectionStatus/HomeReachabilityGate');
        if (readHomeShownUnavailable(lifetime?.scope.serverId)) {
            notChecked = notChecked.filter(reason => reason !== SERVER_UNREACHABLE_ERROR_CODE);
        }
        if (notChecked.length === 0 && skipped.length === 0) return;
    }
    const names = new Map<string, string>();
    if (lifetime && skipped.length > 0) {
        const ids = [...new Set(skipped.map(notice => notice.workflowId))];
        // Loaded only when a skip must be named: the front door stays free of the Workflow presentation graph.
        const titles = await import('@/components/workflows/presentation/workflowReferenceHeaderTitles')
            .then(owner => owner.readWorkflowReferenceHeaderTitles(ids, lifetime)).catch(() => []);
        if (!lifetime.isCurrent()) return;
        for (const [index, id] of ids.entries()) {
            const title = titles[index];
            if (title) names.set(id, title);
        }
    }
    // Multiple triggers for the same Workflow and reason still produce one line.
    const lines = new Set(skipped.map(notice => formatAutomaticCheckSkipNotice({
        reason: readActionAutomationSkipReasonV1(notice), workflow: names.get(notice.workflowId) ?? t('workflows.triggers.checks.aCheck'),
    })));
    for (const reason of notChecked) lines.add(formatAutomationsNotCheckedNotice(reason));
    const message = [...lines].join('\n');
    // The key is the message: the same cause from several Actions in a row replaces one notice instead of stacking.
    publishPresentationNotice({ key: `action-automations:${message}`, message, severity: 'info' });
}
