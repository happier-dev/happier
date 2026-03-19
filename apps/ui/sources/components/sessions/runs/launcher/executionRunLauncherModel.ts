import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { t } from '@/text';

export const EXECUTION_RUN_LAUNCH_INTENTS = ['review', 'plan', 'delegate'] as const;

export type ExecutionRunIntent = (typeof EXECUTION_RUN_LAUNCH_INTENTS)[number];

export function normalizeExecutionRunIntent(value: unknown, fallback: ExecutionRunIntent = 'review'): ExecutionRunIntent {
    const raw = typeof value === 'string' ? value.trim() : Array.isArray(value) ? String(value[0] ?? '').trim() : '';
    if (raw === 'review' || raw === 'plan' || raw === 'delegate') return raw;
    return fallback;
}

export function defaultPermissionModeForExecutionRunIntent(intent: ExecutionRunIntent): PermissionMode {
    if (intent === 'review') return 'read-only';
    if (intent === 'plan') return 'read-only';
    return 'safe-yolo';
}

export function createExecutionRunLauncherDetailsTab(intent?: ExecutionRunIntent): DetailsTab {
    return {
        key: intent ? `execution-run-launcher:${intent}` : 'execution-run-launcher',
        kind: 'executionRunLauncher',
        title: intent === 'plan'
            ? t('executionRuns.newRun.intents.plan')
            : intent === 'delegate'
                ? t('executionRuns.newRun.intents.delegate')
                : intent === 'review'
                    ? t('executionRuns.newRun.intents.review')
                    : t('executionRuns.newRun.headerTitle'),
        resource: {
            kind: 'executionRunLauncher',
            ...(intent ? { intent } : {}),
        },
    };
}
