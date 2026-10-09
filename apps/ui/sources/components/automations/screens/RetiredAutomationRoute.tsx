import * as React from 'react';

import { Redirect, useLocalSearchParams, type Href } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveTriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import { AutomationApiError } from '@/sync/api/automations/apiAutomations';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';

/** Old bookmarks resolve through the existing direct read; they never open another editor or write. */
export function RetiredAutomationRoute(): React.ReactElement {
    const params = useLocalSearchParams<{ id?: string }>();
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    const scope = useActiveServerAccountScope();
    if (!id) return <Redirect href="/workflows" />;
    return <ResolveAutomation key={`${scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'}:${id}`} id={id} />;
}

function ResolveAutomation({ id }: Readonly<{ id: string }>): React.ReactElement {
    const [destination, setDestination] = React.useState<Href | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        let cancelled = false;
        const current = () => !cancelled && lifetime?.isCurrent() === true;
        setFailed(false);
        if (!lifetime) { setFailed(true); return; }
        void sync.refreshAutomationDefinitionDetail(id).then((automation) => {
            if (!current()) return;
            setDestination(automation === null
                ? { pathname: '/workflows', params: { automationUnavailable: '1' } }
                : resolveTriggerEditorHref({ automationId: id, serverId: lifetime.scope.serverId,
                    scopeSessionId: automation.scopeSessionId, workflowDefinitionId: automation.workflowDefinitionId }));
        }).catch((error: unknown) => {
            if (!current()) return;
            if (error instanceof AutomationApiError && error.status === 404) {
                setDestination({ pathname: '/workflows', params: { automationUnavailable: '1' } });
            } else setFailed(true);
        });
        return () => { cancelled = true; };
    }, [id, attempt]);
    if (destination !== null) return <Redirect href={destination} />;
    return <SurfaceStateCard testID="retired-automation-read" kind={failed ? 'error' : 'loading'}
        title={t(failed ? 'workflows.loadFailedTitle' : 'workflows.editor.loadingTitle')}
        {...(failed ? { reason: t('workflows.loadFailedBody'), action: {
            testID: 'retired-automation-read-retry', label: t('workflows.retry'), onPress: () => setAttempt((value) => value + 1),
        } } : {})} />;
}
