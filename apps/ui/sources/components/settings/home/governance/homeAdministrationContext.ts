import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

/**
 * Everything a Home Administration section needs, resolved once by the shared
 * shell.
 *
 * `scope` is the exact Home and Account the screen was opened for. Sections pass
 * it to every mutation rather than re-resolving a target, which is what keeps a
 * Home change elsewhere in the app from retargeting work started here.
 */
export type HomeAdministrationContext = Readonly<{
    scope: ServerAccountScope;
    /** Current credential ownership for retained Home projections. */
    credentialLifetime?: ServerAccountScopeLifetime | null;
    homeName: string;
    projection: HomeGovernanceProjectionV1;
    /** False while the shown projection is stale or the Home is unreachable. */
    mutationsAvailable: boolean;
    /**
     * Whether the shell currently holds an unresolved shared-Action approval.
     *
     * Sections render their own "waiting for approval" state from this rather
     * than latching a local flag: the shell already observes the artifact and
     * releases it on execution, rejection and failure, so a terminal decision
     * clears every section at once instead of stranding one of them.
     */
    approvalPending: boolean;
    /** Registers the shared Action artifact so it stays reachable and blocks duplicate writes. */
    requestApproval?: (registration: ActionApprovalRegistration) => void;
    /** Re-reads this exact Home; used by retry and after a rejected mutation. */
    refresh: () => void;
    /**
     * The exact Home and Account credential current right now, for a destructive confirmation to
     * capture when it opens (`confirmForCapturedAccount`). `null` while the credential is re-checked;
     * absent outside the shell (section tests), which a destructive action treats as unavailable.
     */
    captureDestructiveTarget?: () => ServerAccountScopeLifetime | null;
}>;
