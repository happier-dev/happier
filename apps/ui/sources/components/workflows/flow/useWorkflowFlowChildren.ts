import * as React from 'react';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useWorkflowDefinitionLibrary } from '@/components/workflows/library/workflowLibraryReads';
import { resolveWorkflowProblemPresentation, type WorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { readWorkflowFlowChildren } from './readWorkflowFlowChildren';

const EMPTY_CHILDREN: Readonly<Record<string, WorkflowDefinitionV1>> = Object.freeze({});

/** Demand-only editor preview. It neither changes the draft nor supplies Run snapshot authority. */
export function useWorkflowFlowChildren(definition: WorkflowDefinitionV1 | null, enabled: boolean) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope === null ? null : serverAccountScopeKeySuffix(scope);
    // Prompt edits do not re-read unchanged references. The actual definitions remain with their owners.
    const referenceKey = JSON.stringify(definition === null ? [] : [...new Set(walkWorkflowBlocks(definition.blocks)
        .flatMap((block) => block.kind === 'workflow' ? [block.workflowRef] : []))]);
    const referenceDefinition = React.useMemo((): WorkflowDefinitionV1 => ({ version: 1, inputs: [], defaults: {},
        blocks: (JSON.parse(referenceKey) as string[]).map((workflowRef, index) => ({ kind: 'workflow', id: `preview-${index}`, workflowRef, input: {} })),
    }), [referenceKey]);
    const hasReferences = referenceDefinition.blocks.length > 0;
    const library = useWorkflowDefinitionLibrary({ enabled: enabled && hasReferences });
    const [retryVersion, retryRead] = React.useReducer((value: number) => value + 1, 0);
    const [read, setRead] = React.useState<Readonly<{
        referenceKey: string; scopeKey: string | null; children: Readonly<Record<string, WorkflowDefinitionV1>>;
        problem: WorkflowProblemPresentation | null; usedPluginLibrary: boolean;
        pluginWorkflows: typeof library.pluginWorkflows; isCurrent: () => boolean;
    }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !hasReferences) return;
        const currentness = captureActiveServerAccountScopeCurrentness();
        const controller = new AbortController();
        const retirement = currentness.onRetire(() => { controller.abort(); setRead(null); });
        const isCurrent = () => !controller.signal.aborted && currentness.isCurrent();
        let usedPluginLibrary = false;
        void readWorkflowFlowChildren(referenceDefinition, {
            signal: controller.signal,
            readArtifact: (definitionId, signal) => getWorkflowDefinition({ definitionId, signal }),
            readPluginWorkflows: async () => { usedPluginLibrary = true; return library.pluginWorkflows; },
        }).then((children) => {
            if (isCurrent()) setRead({ referenceKey, scopeKey, children, problem: null, usedPluginLibrary,
                pluginWorkflows: library.pluginWorkflows, isCurrent: currentness.isCurrent });
        }, (error: unknown) => {
            if (isCurrent()) setRead({ referenceKey, scopeKey, children: EMPTY_CHILDREN,
                problem: resolveWorkflowProblemPresentation(error), usedPluginLibrary,
                pluginWorkflows: library.pluginWorkflows, isCurrent: currentness.isCurrent });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [enabled, hasReferences, library.pluginWorkflows, library.status, lifetime, referenceDefinition, referenceKey, retryVersion, scopeKey]);
    const visible = enabled && read?.referenceKey === referenceKey && read.scopeKey === scopeKey && read.isCurrent() ? read : null;
    // A newly loaded page must be resolved before a previous page's missing-child result can page again.
    const awaitingPluginProjection = visible?.usedPluginLibrary === true && visible.pluginWorkflows !== library.pluginWorkflows;
    const needsPluginPage = visible?.usedPluginLibrary === true && visible.problem?.code === 'source_unavailable'
        && !awaitingPluginProjection && library.status === 'loaded' && library.hasMore;
    React.useEffect(() => {
        if (needsPluginPage && !library.loadingMore && !library.loadMoreFailed) library.loadMore();
    }, [needsPluginPage, library.loadingMore, library.loadMoreFailed, library.loadMore]);
    const waitingForPlugins = visible?.usedPluginLibrary === true
        && (awaitingPluginProjection || library.status === 'loading' || (needsPluginPage && !library.loadMoreFailed));
    const retry = React.useCallback(() => {
        if (visible?.usedPluginLibrary) {
            if (library.loadMoreFailed) library.loadMore();
            else library.retry();
        }
        retryRead();
    }, [library.loadMore, library.loadMoreFailed, library.retry, visible?.usedPluginLibrary]);
    return { children: visible?.children ?? EMPTY_CHILDREN,
        problem: waitingForPlugins ? null : visible?.usedPluginLibrary && library.status === 'failed'
            ? library.failure : visible?.problem ?? null,
        loading: enabled && hasReferences && (visible === null || waitingForPlugins), retry };
}
