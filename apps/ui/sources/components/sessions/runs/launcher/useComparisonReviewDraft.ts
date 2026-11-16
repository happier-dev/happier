import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { findMachineAgentForBackendTarget } from '@/agents/machineAgents/machineAgentCatalog';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import { resolveReviewWalkthroughPlan, type ReviewWalkthroughEngine } from '@/sync/domains/reviews/reviewWalkthroughPlan';
import type { ScmReviewComparisonSelector } from '@/sync/domains/scm/diffSummary/selection';
import { listReviewWalkthroughEngines, startReviewOfComparison } from '@/sync/ops/reviews/reviewWalkthrough';
import { t } from '@/text';

/** Declarative comparison context; instructions and reviewer choices stay in the Run draft. */
export type ComparisonReviewDraftInput = Readonly<{
    cwd: string;
    comparison: ScmReviewComparisonSelector;
    comparisonId?: string | null;
    scopeLabel: string;
    scopeDetail?: string | null;
    defaultWalkthrough: boolean;
    preselectedEngineIds?: readonly string[];
    /** The existing comparison pane receives the accepted reviewers and captured walkthrough. */
    origin?: Readonly<{ scopeId: string; tab: DetailsTab }>;
}>;

/** Comparison and narrator policy only. R owns Who, instructions, launch options and submission. */
export function useComparisonReviewDraft(params: Readonly<{
    sessionId: string | null;
    machineId?: string;
    serverId: string | null;
    comparisonReview: ComparisonReviewDraftInput | null;
    engineIds: readonly string[];
    actionInput: Record<string, unknown>;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    machineInventory: Pick<MachineAgentsSnapshot, 'agents' | 'status'>;
    onRetryInventory?: () => void;
}>) {
    const [listedEngines, setListedEngines] = React.useState<readonly ReviewWalkthroughEngine[] | null>(null);
    const [enginesError, setEnginesError] = React.useState<string | null>(null);
    const walkthrough = Array.isArray(params.actionInput.outputs)
        ? params.actionInput.outputs.includes('walkthrough') : params.comparisonReview?.defaultWalkthrough ?? false;
    const narrator = params.actionInput.narrator;
    const narratorEngineId = narrator && typeof narrator === 'object' && 'engineId' in narrator && typeof narrator.engineId === 'string'
        ? narrator.engineId : null;
    const enabled = params.comparisonReview !== null;
    // The retained draft uses [] to remember an explicit findings-only choice.
    // The Action represents that choice by omitting outputs.
    const launchInput = React.useMemo(() => {
        if (!enabled || !Array.isArray(params.actionInput.outputs) || params.actionInput.outputs.length > 0) return params.actionInput;
        const { outputs: _outputs, ...input } = params.actionInput;
        return input;
    }, [enabled, params.actionInput]);
    const machineInventory = params.machineInventory;
    React.useEffect(() => {
        if (!enabled) return;
        let current = true;
        void listReviewWalkthroughEngines({ sessionId: params.sessionId, machineId: params.machineId, serverId: params.serverId }).then(listed => {
            if (!current) return;
            if (!listed.ok) { setEnginesError(listed.error); return; }
            setListedEngines(listed.engines);
            setEnginesError(null);
        });
        return () => { current = false; };
    }, [enabled, params.sessionId, params.machineId, params.serverId]);
    const engines = React.useMemo(() => listedEngines?.map(engine => ({ ...engine,
        machineAgent: findMachineAgentForBackendTarget(machineInventory.agents, resolveReviewEngineTarget(engine.engineId)),
        machineInventoryStatus: machineInventory.status,
    })) ?? [], [listedEngines, machineInventory.agents, machineInventory.status]);
    const plan = React.useMemo(() => resolveReviewWalkthroughPlan({ engines, selectedEngineIds: params.engineIds,
        walkthrough, narratorEngineId }), [engines, params.engineIds, walkthrough, narratorEngineId]);
    const submit = React.useCallback(async (submission: Readonly<{
        start: (actionId: 'review.start', input: Record<string, unknown>, operationId: string) => Promise<ActionExecuteResult>;
        input: Record<string, unknown>;
        instructions: string;
        operationId: string;
    }>) => {
        if (!params.comparisonReview) throw new Error(t('common.unavailable'));
        let actionResult: ActionExecuteResult | null = null;
        let capturedComparisonId = typeof submission.input.comparisonId === 'string' ? submission.input.comparisonId : null;
        const retainCapturedComparison = () => {
            if (capturedComparisonId) params.setActionInput(previous => ({ ...previous, comparisonId: capturedComparisonId }));
        };
        const comparison = await startReviewOfComparison({ ...params.comparisonReview,
            comparisonId: params.comparisonReview.comparisonId ?? params.comparisonReview.comparison.comparisonId ?? capturedComparisonId,
            sessionId: params.sessionId, machineId: params.machineId, serverId: params.serverId, plan,
            instructions: submission.instructions.trim() || t('reviewWalkthrough.dialog.defaultInstructions'),
            launchInput: submission.input,
            start: async input => {
                capturedComparisonId = typeof input.comparisonId === 'string' ? input.comparisonId : null;
                try {
                    actionResult = await submission.start('review.start', input, submission.operationId);
                } catch (error) {
                    retainCapturedComparison();
                    throw error;
                }
                return actionResult;
            },
        });
        // Accepted work clears the original draft currentness. Only a held/refused attempt
        // retains its captured source for the person's next explicit retry.
        if (!comparison.ok) retainCapturedComparison();
        return { comparison, actionResult, capturedComparisonId };
    }, [params.comparisonReview, params.sessionId, params.machineId, params.serverId, params.setActionInput, plan]);
    // One identity while nothing it shows changes: the walkthrough chip's content and revision read it.
    const { setActionInput, onRetryInventory } = params;
    const scopeLabel = params.comparisonReview?.scopeLabel ?? '';
    const scopeDetail = params.comparisonReview?.scopeDetail;
    const inventoryFailed = machineInventory.status === 'error';
    const fields = React.useMemo(() => ({
        scopeLabel, scopeDetail,
        plan, walkthrough, onToggleWalkthrough: () => setActionInput(previous => ({ ...previous, outputs: walkthrough ? [] : ['walkthrough'] })),
        onSelectNarrator: (engineId: string) => setActionInput(previous => ({ ...previous, narrator: { engineId } })),
        error: enginesError ?? (inventoryFailed ? t('machineAgents.unknown') : null),
        onRetry: inventoryFailed ? onRetryInventory : undefined,
    }), [enginesError, inventoryFailed, onRetryInventory, plan, scopeDetail, scopeLabel, setActionInput, walkthrough]);
    return { plan, engines, enginesError, submit, fields, launchInput };
}
