import { readActionAutomationSkipReasonV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { formatAutomaticCheckSkipNotice } from '@/components/approvals/formatAutomaticCheckSkipNotice';
import { readWorkflowReferenceHeaderTitles } from '@/components/workflows/presentation/workflowReferenceHeaderTitles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal/ModalManager';
import { t } from '@/text';

/** Present the Action owner's settled skips without loading their steps or rerunning them. */
export async function presentActionAutomationSkipNotice(
    result: Pick<ActionExecuteResult, 'automationNotices'>,
    lifetime?: ServerAccountScopeLifetime | null,
): Promise<void> {
    const skipped = result.automationNotices?.filter(notice => notice.code === 'action_automation_skipped');
    if (!skipped?.length) return;
    const names = new Map<string, string>();
    if (lifetime) {
        if (!lifetime.isCurrent()) return;
        const ids = [...new Set(skipped.map(notice => notice.workflowId))];
        const titles = await readWorkflowReferenceHeaderTitles(ids, lifetime).catch(() => []);
        if (!lifetime.isCurrent()) return;
        for (const [index, id] of ids.entries()) {
            const title = titles[index];
            if (title) names.set(id, title);
        }
    }
    // Multiple triggers for the same Workflow and reason still produce one line.
    const message = [...new Set(skipped.map(notice => formatAutomaticCheckSkipNotice({
        reason: readActionAutomationSkipReasonV1(notice), workflow: names.get(notice.workflowId) ?? t('workflows.triggers.checks.aCheck'),
    })))].join('\n');
    Modal.alert(t('workflows.triggers.section.title'), message, [{ text: t('common.ok'), style: 'cancel' }]);
}
