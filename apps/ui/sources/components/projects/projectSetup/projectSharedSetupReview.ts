import type { ProjectSharedSetupChangeV1 } from '@happier-dev/protocol/projects/projectSetupChangeV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectManifestActionClient } from './projectManifestActionClient';
import type { ProjectSharedSetupUpdateRequest } from './projectSetupConsentDecision';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export type ProjectSharedSetupReviewResult =
    | Readonly<{ kind: 'initial' }>
    | Readonly<{ kind: 'unavailable'; code: string }>
    | Readonly<{ kind: 'ready'; change: ProjectSharedSetupChangeV1; request: ProjectSharedSetupUpdateRequest | null }>;
export type ProjectSharedSetupReviewSnapshot = ProjectSharedSetupReviewResult & Readonly<{ pending: boolean }>;

/** A selected Source review is explicit demand. Accept/Keep remain owned by the existing Scripts controller. */
export function createProjectSharedSetupReview(input: Readonly<{
    client: ProjectManifestActionClient;
    projectRef: ProjectSharedSetupUpdateRequest['projectRef'];
    expectedRevision: ProjectSharedSetupUpdateRequest['expectedRevision'];
    sourceId: string;
}>) {
    let state: ProjectSharedSetupReviewSnapshot = { kind: 'initial', pending: false };
    let pending: Promise<void> | null = null;
    let active = true;
    const listeners = new Set<() => void>();
    const publish = (next: ProjectSharedSetupReviewSnapshot) => { if (active) { state = next; for (const listener of listeners) listener(); } };
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { active = false; state = { kind: 'initial', pending: false }; for (const listener of listeners) listener(); listeners.clear(); },
        refresh(): Promise<void> {
            if (pending) return pending;
            if (!active) return Promise.resolve();
            publish({ ...state, pending: true });
            pending = (async () => {
                try {
                    const inspected = await input.client.reviewSharedSetup(input.sourceId);
                    const change = inspected.sharedSetupChange;
                    if (!change) { publish({ kind: 'unavailable', code: 'project_setup_review_unavailable', pending: false }); return; }
                    // An equal refresh keeps the exact displayed facts and review request identities.
                    if (state.kind === 'ready' && sameStrictJsonValue(state.change, change)) {
                        publish({ ...state, pending: false }); return;
                    }
                    publish({ kind: 'ready', change, pending: false, request: change.kind === 'changed'
                        ? { projectRef: input.projectRef, expectedRevision: input.expectedRevision, review: change } : null });
                } catch (error) { publish({ kind: 'unavailable', code: readActionErrorCodeV1(error) ?? 'action_failed', pending: false }); }
                finally { pending = null; }
            })();
            return pending;
        },
    };
}
