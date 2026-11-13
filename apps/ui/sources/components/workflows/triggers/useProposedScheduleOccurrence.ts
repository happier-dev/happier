import * as React from 'react';
import type { AutomationSchedulePreviewResult } from '@happier-dev/protocol/automations/automationSchedule';
import { previewAutomationSchedule } from '@/sync/api/automations/apiAutomations';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveWorkflowProblemPresentation } from '../presentation/workflowProblemPresentation';

type Preview = AutomationSchedulePreviewResult | Readonly<{ status: 'loading' }> | Readonly<{ status: 'failed'; message: string }>;

/** One cancellable read per changed draft; no idle polling or client-side schedule evaluation. */
export function useProposedScheduleOccurrence(schedule: unknown | null, explicitLifetime?: ServerAccountScopeLifetime | null): Preview | null {
    const inherited = useWorkflowAccountLifetime(explicitLifetime);
    const active = useActiveServerAccountScopeLifetime();
    const lifetime = inherited === undefined ? active : inherited;
    const key = schedule === null ? null : JSON.stringify(schedule);
    const [read, setRead] = React.useState<Readonly<{ key: string; lifetime: ServerAccountScopeLifetime; value: Preview }> | null>(null);
    React.useEffect(() => {
        if (key === null || !lifetime) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        void (async () => {
            const account = await captureLazyActionAccountContext(lifetime.scope.serverId, controller.signal);
            try {
                const value = await previewAutomationSchedule(account.credentials, JSON.parse(key), account, controller.signal);
                if (!controller.signal.aborted) setRead({ key, lifetime, value });
            } finally { account.dispose(); }
        })().catch((error: unknown) => {
            if (!controller.signal.aborted) setRead({ key, lifetime, value: { status: 'failed', message: resolveWorkflowProblemPresentation(error).message } });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [key, lifetime]);
    if (key === null || !lifetime) return null;
    return read?.key === key && read.lifetime === lifetime ? read.value : { status: 'loading' };
}
