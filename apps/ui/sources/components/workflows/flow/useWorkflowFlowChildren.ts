import * as React from 'react';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { resolveWorkflowProblemPresentation, type WorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { getWorkflowDefinition, listWorkflowDefinitions } from '@/sync/domains/workflows/workflowDefinitionActions';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { readWorkflowFlowChildren } from './readWorkflowFlowChildren';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

const EMPTY_CHILDREN: Readonly<Record<string, WorkflowDefinitionV1>> = Object.freeze({});

/** Demand-only editor preview. It neither changes the draft nor supplies Run snapshot authority. */
export function useWorkflowFlowChildren(definition: WorkflowDefinitionV1 | null, enabled: boolean) {
    const accountLifetime = useWorkflowAccountLifetime();
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = accountLifetime === undefined ? activeLifetime : accountLifetime;
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope === null ? null : serverAccountScopeKeySuffix(scope);
    // Prompt edits do not re-read unchanged references. The actual definitions remain with their owners.
    const referenceKey = JSON.stringify(definition === null ? [] : [...new Set(walkWorkflowBlocks(definition.blocks)
        .flatMap((block) => block.kind === 'workflow' ? [block.workflowRef] : []))]);
    const referenceDefinition = React.useMemo((): WorkflowDefinitionV1 => ({ version: 1, inputs: [], defaults: {},
        blocks: (JSON.parse(referenceKey) as string[]).map((workflowRef, index) => ({ kind: 'workflow', id: `preview-${index}`, workflowRef, input: {} })),
    }), [referenceKey]);
    const hasReferences = referenceDefinition.blocks.length > 0;
    const hasPluginReferences = React.useMemo(() => (JSON.parse(referenceKey) as string[])
        .some(workflowRef => parseWorkflowDefinitionRefV1(workflowRef)?.kind === 'plugin'), [referenceKey]);
    const [retryVersion, retryRead] = React.useReducer((value: number) => value + 1, 0);
    const [read, setRead] = React.useState<Readonly<{
        referenceKey: string; scopeKey: string | null; children: Readonly<Record<string, WorkflowDefinitionV1>>;
        problem: WorkflowProblemPresentation | null; isCurrent: () => boolean;
    }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !hasReferences || !scope) return;
        return subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)
                && (event.workflowDefinitionsAffect !== false
                    || (hasPluginReferences && event.workflowPluginSourcesAffect === true))) retryRead();
        }, { reconnect: 'refresh' });
    }, [enabled, hasPluginReferences, hasReferences, scope]);
    React.useEffect(() => {
        if (!enabled || !hasReferences || (lifetime !== null && !lifetime.isCurrent())) return;
        const currentness = lifetime;
        const controller = new AbortController();
        const retirement = currentness?.onRetire(() => { controller.abort(); setRead(null); });
        const isScopeCurrent = () => currentness?.isCurrent() ?? true;
        const isCurrent = () => !controller.signal.aborted && isScopeCurrent();
        void readWorkflowFlowChildren(referenceDefinition, {
            signal: controller.signal,
            // Built-ins are local catalog data. Only Account-backed readers need a bound lifetime;
            // without one the resolver still settles other references as source_unavailable.
            ...(currentness === null ? {} : {
                readArtifact: (definitionId: string, signal?: AbortSignal) => getWorkflowDefinition({ definitionId, signal,
                    ...(accountLifetime === undefined ? {} : { accountLifetime }) }),
                readPluginWorkflows: async (workflow: string) => (await listWorkflowDefinitions({ workflow, signal: controller.signal,
                    ...(accountLifetime === undefined ? {} : { accountLifetime }) })).pluginWorkflows ?? [],
            }),
        }).then((children) => {
            if (isCurrent()) setRead({ referenceKey, scopeKey, children, problem: null, isCurrent: isScopeCurrent });
        }, (error: unknown) => {
            if (isCurrent()) setRead({ referenceKey, scopeKey, children: EMPTY_CHILDREN,
                problem: resolveWorkflowProblemPresentation(error), isCurrent: isScopeCurrent });
        });
        return () => { controller.abort(); retirement?.dispose(); };
    }, [accountLifetime, enabled, hasReferences, lifetime, referenceDefinition, referenceKey, retryVersion, scopeKey]);
    const visible = enabled && read?.referenceKey === referenceKey && read.scopeKey === scopeKey && read.isCurrent() ? read : null;
    return { children: visible?.children ?? EMPTY_CHILDREN,
        problem: visible?.problem ?? null,
        loading: enabled && hasReferences && visible === null, retry: retryRead };
}
