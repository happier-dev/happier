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
import { affectsSelectedWorkflowDefinition } from '../library/workflowLibraryReads';

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
    const [retryVersion, wakeRead] = React.useReducer((value: number) => value + 1, 0);
    const [read, setRead] = React.useState<Readonly<{
        referenceKey: string; scopeKey: string | null; children: Readonly<Record<string, WorkflowDefinitionV1>>;
        problem: WorkflowProblemPresentation | null; isCurrent: () => boolean;
    }> | null>(null);
    const readRef = React.useRef(read);
    readRef.current = read;
    const references = React.useMemo(() => {
        const refs = [...new Set([...JSON.parse(referenceKey) as string[], ...Object.keys(read?.children ?? EMPTY_CHILDREN)])]
            .map(parseWorkflowDefinitionRefV1);
        return { definitionIds: refs.flatMap(ref => ref?.kind === 'artifact' ? [ref.artifactId] : []),
            hasPluginReferences: refs.some(ref => ref?.kind === 'plugin') };
    }, [read?.children, referenceKey]);
    const refresh = React.useRef<Readonly<{ definitionIds: ReadonlySet<string> | null; pluginSourcesChanged: boolean }> | null>(null);
    const retryRead = React.useCallback(() => {
        refresh.current = { definitionIds: null, pluginSourcesChanged: true };
        wakeRead();
    }, []);
    React.useEffect(() => {
        if (!enabled || !hasReferences || !scope || !lifetime) return;
        return subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)) return;
            const recovering = event.source === 'connected' || event.source === 'snapshot';
            const changedIds = event.changedWorkflowDefinitionIds === undefined && !recovering ? []
                : references.definitionIds.filter(id => affectsSelectedWorkflowDefinition(event, lifetime, id));
            // Only explicit source changes and recovery refresh Machine contributions.
            // A coarse unrelated wake and saved-record edits supply no such evidence.
            const pluginSourcesChanged = (recovering || event.workflowDefinitionsAffect === false)
                && event.workflowPluginSourcesAffect === true && references.hasPluginReferences;
            if (changedIds.length === 0 && !pluginSourcesChanged) return;
            const pending = refresh.current;
            refresh.current = { definitionIds: pending?.definitionIds === null ? null
                : new Set([...(pending?.definitionIds ?? []), ...changedIds]),
                pluginSourcesChanged: pluginSourcesChanged || pending?.pluginSourcesChanged === true };
            wakeRead();
        }, { reconnect: 'refresh' });
    }, [enabled, hasReferences, lifetime, references, scope]);
    React.useEffect(() => {
        if (!enabled) {
            // The next presentation catches up changes missed while unsubscribed.
            refresh.current = { definitionIds: null, pluginSourcesChanged: true };
            return;
        }
        if (!hasReferences || (lifetime !== null && !lifetime.isCurrent())) return;
        const currentness = lifetime;
        const controller = new AbortController();
        const retirement = currentness?.onRetire(() => { controller.abort(); setRead(null); });
        const isScopeCurrent = () => currentness?.isCurrent() ?? true;
        const isCurrent = () => !controller.signal.aborted && isScopeCurrent();
        const previous = readRef.current;
        const previousChildren = previous?.scopeKey === scopeKey && previous.isCurrent() ? previous.children : undefined;
        const requestedRefresh = refresh.current;
        void readWorkflowFlowChildren(referenceDefinition, {
            signal: controller.signal,
            previousChildren,
            changedDefinitionIds: requestedRefresh?.definitionIds === null ? undefined
                : requestedRefresh?.definitionIds ?? (previousChildren ? new Set() : undefined),
            pluginSourcesChanged: requestedRefresh?.pluginSourcesChanged ?? previousChildren === undefined,
            // Built-ins are local catalog data. Only Account-backed readers need a bound lifetime;
            // without one the resolver still settles other references as source_unavailable.
            ...(currentness === null ? {} : {
                readArtifact: (definitionId: string, signal?: AbortSignal) => getWorkflowDefinition({ definitionId, signal,
                    ...(accountLifetime === undefined ? {} : { accountLifetime }) }),
                readPluginWorkflows: async (workflow: string) => (await listWorkflowDefinitions({ workflow, signal: controller.signal,
                    ...(accountLifetime === undefined ? {} : { accountLifetime }) })).pluginWorkflows ?? [],
            }),
        }).then((children) => {
            if (isCurrent()) {
                if (refresh.current === requestedRefresh) refresh.current = null;
                setRead({ referenceKey, scopeKey, children, problem: null, isCurrent: isScopeCurrent });
            }
        }, (error: unknown) => {
            if (isCurrent()) setRead({ referenceKey, scopeKey, children: previousChildren ?? EMPTY_CHILDREN,
                problem: resolveWorkflowProblemPresentation(error), isCurrent: isScopeCurrent });
        });
        return () => { controller.abort(); retirement?.dispose(); };
    }, [accountLifetime, enabled, hasReferences, lifetime, referenceDefinition, referenceKey, retryVersion, scopeKey]);
    const visible = enabled && read?.referenceKey === referenceKey && read.scopeKey === scopeKey && read.isCurrent() ? read : null;
    return { children: visible?.children ?? EMPTY_CHILDREN,
        problem: visible?.problem ?? null,
        loading: enabled && hasReferences && visible === null, retry: retryRead };
}
