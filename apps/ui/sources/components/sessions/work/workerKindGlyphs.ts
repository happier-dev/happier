import type { WorkerUpdateV1 } from '@happier-dev/protocol';
import { HAPPIER_WORK_KIND_GLYPHS, resolveHappierWorkKindPresentation } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';

import type { IconName } from '@/components/ui/icons/Icon';

/**
 * The glyph of a worker that has no agent mark to show, by the kind of worker it is: a session or a
 * background run (Work rows use the same glyphs). A role that pins no engine is marked by the kind of
 * worker it starts.
 */
export const WORKER_KIND_GLYPHS = HAPPIER_WORK_KIND_GLYPHS satisfies Record<WorkerUpdateV1['workerKind'], IconName>;

export function describeWorkKind(kind: WorkerUpdateV1['workerKind']): string {
    return resolveHappierWorkKindPresentation(kind, {
        session: t('sessionWork.kinds.session'), execution_run: t('sessionWork.kinds.backgroundRun'),
        workflow_run: t('sessionWork.kinds.workflowRun'),
    }).label;
}
