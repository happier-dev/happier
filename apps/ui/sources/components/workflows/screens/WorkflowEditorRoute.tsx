import * as React from 'react';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows';

import { useLocalSearchParams, useOpenAppSection, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { WorkflowBuiltinEditorHostScreen, WorkflowPluginEditorHostScreen } from './WorkflowCatalogEditorHostScreen';
import { WorkflowEditorHostScreen, type WorkflowEditorSource, type WorkflowSavedEntryIntent } from './WorkflowEditorHostScreen';
import { WorkflowMissingDefinitionState } from './WorkflowMissingDefinitionState';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { WorkflowAccountLifetimeProvider } from '../workflowAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Create and saved URLs are two identities of the same mounted editor. */
export function WorkflowEditorRoute(): React.ReactElement {
    const openSection = useOpenAppSection();
    const pathname = usePathname();
    const params = useLocalSearchParams<{
        id?: string | string[]; intent?: string | string[]; importJson?: string;
        reviewedRunSeedId?: string; newSessionDraftSeedId?: string; triggerWorkflowSeedId?: string;
        definitionDraftSeedId?: string; example?: string; builtin?: string;
        agentRevisionSeedId?: string; authoringSessionId?: string;
        serverId?: string | string[];
    }>();
    const serverId = readSessionRouteServerId(params);
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const lastBinding = React.useRef<ServerAccountScopeLifetime | null>(null);
    // A same-Account credential recheck retires authority, not the mounted draft.
    // Unknown, signed-out and different-Account resolutions cannot inherit its bytes.
    const displayBinding = binding ?? (resolution.kind === 'bound'
        && areServerAccountScopesEqual(lastBinding.current?.scope, resolution.scope) ? lastBinding.current : null);
    lastBinding.current = displayBinding;
    if (serverId && !displayBinding) return <WorkflowsGate>{resolution.kind === 'resolving'
        ? <SurfaceStateCard kind="loading" title={t('workflows.editor.loadingTitle')} />
        : <WorkflowMissingDefinitionState testID="workflow-detail-unavailable"
            onOpenCollection={() => openSection('/workflows', true)} />}</WorkflowsGate>;
    let source: WorkflowEditorSource;
    if (pathname === '/workflows/new') {
        // Only opaque seed handles travel in the URL; private definition and
        // placement remain in the existing Account-scoped temporary store.
        const seed = (value: string | undefined) => typeof value === 'string' && value.length > 0 ? value : undefined;
        const reviewedRunSeedId = seed(params.reviewedRunSeedId);
        const newSessionDraftSeedId = seed(params.newSessionDraftSeedId);
        const triggerWorkflowSeedId = seed(params.triggerWorkflowSeedId);
        source = {
            kind: 'new',
            ...(typeof params.example === 'string' ? { exampleKey: params.example } : {}),
            ...(typeof params.builtin === 'string' ? { builtinId: params.builtin } : {}),
            ...(params.importJson === '1' ? { requestImport: true } : {}),
            ...(reviewedRunSeedId === undefined ? {} : { reviewedRunSeedId }),
            ...(newSessionDraftSeedId === undefined ? {} : { newSessionDraftSeedId }),
            ...(triggerWorkflowSeedId === undefined ? {} : { triggerWorkflowSeedId }),
            ...(typeof params.definitionDraftSeedId === 'string' ? { definitionDraftSeedId: params.definitionDraftSeedId } : {}),
        };
    } else {
        const definitionId = Array.isArray(params.id) ? params.id[0] : params.id;
        const rawIntent = Array.isArray(params.intent) ? params.intent[0] : params.intent;
        const intent: WorkflowSavedEntryIntent | undefined = rawIntent === 'run' || rawIntent === 'schedule' ? rawIntent : undefined;
        if (definitionId === undefined || definitionId.length === 0) {
            return <WorkflowsGate><WorkflowMissingDefinitionState testID="workflow-detail-invalid"
                onOpenCollection={() => openSection('/workflows', true)} /></WorkflowsGate>;
        }
        const reference = parseWorkflowDefinitionRefV1(definitionId);
        if (reference?.kind === 'plugin') {
            return <WorkflowsGate><WorkflowAccountLifetimeProvider value={serverId ? displayBinding : undefined}>
                <WorkflowPluginEditorHostScreen workflow={definitionId} {...(intent === 'run' ? { intent } : {})} />
            </WorkflowAccountLifetimeProvider></WorkflowsGate>;
        }
        if (reference?.kind === 'builtin') {
            return <WorkflowsGate><WorkflowAccountLifetimeProvider value={serverId ? displayBinding : undefined}>
                <WorkflowBuiltinEditorHostScreen workflow={definitionId} {...(intent === 'run' ? { intent } : {})} />
            </WorkflowAccountLifetimeProvider></WorkflowsGate>;
        }
        source = {
            kind: 'saved', definitionId,
            ...(intent === undefined ? {} : { intent }),
            ...(typeof params.agentRevisionSeedId === 'string' ? { agentRevisionSeedId: params.agentRevisionSeedId } : {}),
            ...(typeof params.authoringSessionId === 'string' ? { authoringSessionId: params.authoringSessionId } : {}),
        };
    }
    return <WorkflowsGate><WorkflowEditorHostScreen source={source}
        {...(serverId ? { accountLifetime: displayBinding } : {})} /></WorkflowsGate>;
}
