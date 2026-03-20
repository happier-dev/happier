import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

export function resolveSessionSubagentPrimaryTitle(subagent: SessionSubagent): string {
    const rawTitle = subagent.display.title?.trim();
    if (rawTitle && !(subagent.kind === 'execution_run' && rawTitle === subagent.runRef?.runId)) {
        return rawTitle;
    }

    if (subagent.kind === 'execution_run') {
        const intent = subagent.runRef?.intent?.trim();
        if (intent === 'review' || intent === 'plan' || intent === 'delegate') {
            return t('executionRuns.details.titles.executionRunWithIntent', {
                intent: t(`session.subagents.intent.${intent}` as const),
            });
        }
        return t('executionRuns.details.titles.executionRun');
    }

    return rawTitle || subagent.id;
}
