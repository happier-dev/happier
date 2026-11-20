import { readActionAutomationSkipReasonV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { formatAutomaticCheckSkipNotice } from '@/components/approvals/formatAutomaticCheckSkipNotice';
import { Modal } from '@/modal/ModalManager';
import { t } from '@/text';

/** Present the Action owner's settled skips without loading or rerunning its checks. */
export function presentActionAutomationSkipNotice(result: Pick<ActionExecuteResult, 'automationNotices'>): void {
    const skipped = result.automationNotices?.filter(notice => notice.code === 'action_automation_skipped');
    if (!skipped?.length) return;
    // Every skip names "a check", so checks skipped for the same reason read as one line, said once.
    const message = [...new Set(skipped.map(notice => formatAutomaticCheckSkipNotice({
        reason: readActionAutomationSkipReasonV1(notice), workflow: t('workflows.triggers.checks.aCheck'),
    })))].join('\n');
    Modal.alert(t('workflows.triggers.section.title'), message, [{ text: t('common.ok'), style: 'cancel' }]);
}
