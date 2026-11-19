import { ProjectSetupConsentFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ProjectSetupConsentFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { currentWorkspaceSource, runWithWorkspaceSourceDemand } from '@/workspaces/source/workspaceSource';
import type { ActionOperationReviewContinuation, ActionOperationSetupDecision } from './actionOperationTypes';
import { isDeepStrictEqual } from 'node:util';

/** The existing occurrence owns execution; this owner only retains its human setup review. */
export function createActionOperationSetupReview(input: Readonly<{
  signal: AbortSignal;
  publish(details: ProjectSetupConsentFailureDetailsV1 | undefined): void;
}>) {
  let resume = () => {};
  let refresh = async () => {};
  let decide = async (_decision: ActionOperationSetupDecision) => {};
  const operationReview: ActionOperationReviewContinuation = {
    async waitForResume(details, producer) {
      const parsed = ProjectSetupConsentFailureDetailsV1Schema.parse(details);
      let currentDetails = parsed;
      input.signal.throwIfAborted();
      // A later inspection or consent RPC runs in its own request scope.
      const source = currentWorkspaceSource();
      await new Promise<void>((resolve, reject) => {
        let current = true;
        let refreshing: Promise<void> | undefined;
        const cleanup = () => {
          current = false;
          input.signal.removeEventListener('abort', abort);
          resume = () => {};
          refresh = async () => {};
          decide = async () => {};
          input.publish(undefined);
        };
        const abort = () => { cleanup(); reject(input.signal.reason); };
        const complete = () => { if (current) { cleanup(); resolve(); } };
        resume = () => {
          if (refreshing) void refreshing.then(complete, () => undefined);
          else complete();
        };
        const inspect = (decision?: ActionOperationSetupDecision): Promise<void> => {
          if (!producer || !current) return Promise.resolve();
          // Reads join; a human choice remeasures after any in-flight read.
          if (refreshing) return decision ? refreshing.then(() => inspect(decision)) : refreshing;
          refreshing = (async () => {
            const reviewed = await runWithWorkspaceSourceDemand(source, () => producer.review(decision));
            if (!current || input.signal.aborted) return;
            if (!reviewed) { complete(); return; }
            const next = ProjectSetupConsentFailureDetailsV1Schema.parse(reviewed);
            if (!isDeepStrictEqual(currentDetails, next)) {
              currentDetails = next;
              input.publish(next);
            }
          })().catch(error => {
            if (current) { cleanup(); reject(error); }
          }).finally(() => { refreshing = undefined; });
          return refreshing;
        };
        refresh = () => inspect();
        decide = decision => inspect(decision);
        input.signal.addEventListener('abort', abort, { once: true });
        input.publish(parsed);
      });
    },
  };
  return Object.freeze({ operationReview, resume: () => resume(), refresh: () => refresh(),
    decide: (decision: ActionOperationSetupDecision) => decide(decision) });
}
