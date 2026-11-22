import { readActionAutomationSkipReasonV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { formatAutomaticCheckSkipNotice } from '@/components/approvals/formatAutomaticCheckSkipNotice';
import { readWorkflowReferenceHeaderTitles } from '@/components/workflows/presentation/workflowReferenceHeaderTitles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal/ModalManager';
import { t } from '@/text';

/** Present the Action owner's settled notices without loading Workflow steps or rerunning checks. */
export async function presentActionAutomationSkipNotice(
    result: Pick<ActionExecuteResult, 'automationNotices'>,
    lifetime?: ServerAccountScopeLifetime | null,
): Promise<void> {
    const notices = result.automationNotices ?? [];
    const skipped = notices.filter(notice => notice.code === 'action_automation_skipped');
    const notChecked = notices.some(notice => notice.code === 'action_automations_not_checked');
    if ((!notChecked && skipped.length === 0) || lifetime?.isCurrent() === false) return;
    const names = new Map<string, string>();
    if (lifetime && skipped.length > 0) {
        const ids = [...new Set(skipped.map(notice => notice.workflowId))];
        const titles = await readWorkflowReferenceHeaderTitles(ids, lifetime).catch(() => []);
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
    if (notChecked) lines.add(t('workflows.triggers.checks.notChecked'));
    Modal.alert(t('workflows.triggers.section.title'), [...lines].join('\n'), [{ text: t('common.ok'), style: 'cancel' }]);
}
