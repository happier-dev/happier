import * as React from 'react';
import type { WorkflowRunAcceptedContextV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';

/** Opens an unsaved editor draft. Saving the draft remains the editor's explicit action. */
export function useSaveRunAsWorkflow(params: Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    serverId?: string;
    isCurrent: () => boolean;
}>) {
    const router = useDestinationRouter();
    const { accountLifetime, serverId, isCurrent } = params;
    return React.useCallback(({ run, definition, acceptedContext }: Readonly<{
        run: WorkflowRunSummaryV1 | null;
        definition: WorkflowDefinitionV1 | null;
        acceptedContext: WorkflowRunAcceptedContextV1 | null;
    }>) => {
        if (run === null || definition === null || acceptedContext === null) return;
        if (accountLifetime === null || !accountLifetime.isCurrent() || !isCurrent()) return;
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({ run, definition, acceptedContext }),
            serverId ? accountLifetime : undefined);
        router.push({ pathname: '/workflows/new', params: { reviewedRunSeedId: seedId,
            ...(serverId ? { serverId } : {}) } } as never);
    }, [accountLifetime, serverId, isCurrent, router]);
}
