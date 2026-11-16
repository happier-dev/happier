import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';

/**
 * Everything a Team section needs, resolved once by the shared Team shell.
 *
 * `scope` and `address` are the exact Home, Account and Team the screen was
 * opened for. Sections pass them to every read and mutation rather than
 * re-resolving a target, which is what keeps a Home change elsewhere in the app
 * from retargeting work started here.
 *
 * `team.capabilities` is the server's projection for this viewer and is the only
 * thing a section may use to decide whether to render a control. A section never
 * reconstructs authority from `team.viewerRole`: an archived Team, a suspended
 * membership or an inactive Account each withdraw capabilities the role implies.
 */
export type TeamSectionContext = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    homeName: string;
    team: TeamSummaryV1;
    /**
     * Host readiness alone: false while the shown Team is stale or its Home is
     * unreachable. Lifecycle actions that are legitimate *because* a Team or
     * Group is archived — restore — gate on this, not on {@link canMutate},
     * whose archived rule would withdraw the one action archiving leaves.
     *
     * It is readiness, not custody: a restore control still has to exclude
     * {@link approvalPending} itself, or an unresolved approval for that exact
     * restore would leave the control live and let one restore be requested
     * twice.
     */
    mutationsAvailable: boolean;
    archived: boolean;
    /**
     * Whether an ordinary Team write may be offered. An archived Team is
     * read-only for every role regardless of capability, and deciding that once
     * here keeps four sections from each re-deriving the same rule and
     * eventually disagreeing about it.
     */
    canMutate: boolean;
    /**
     * Whether the shell currently holds an unresolved shared-Action approval.
     *
     * Sections render their own "waiting for approval" state from this rather
     * than latching a local flag: the shell already observes the artifact and
     * releases it on execution, rejection and failure, so a terminal decision
     * clears every section at once instead of stranding one of them.
     */
    approvalPending: boolean;
    /** Re-reads this exact Team; used by retry and after a rejected mutation. */
    refresh: () => void;
    /** Registers a deferred Action approval created by a Team mutation. */
    requestApproval: (registration: ActionApprovalRegistration) => void;
    /** Settles self-removal at the destination host, even after its roster row unmounts. */
    settleLeave: (outcome: Readonly<{ kind: 'succeeded' }> | Readonly<{ kind: 'failed'; message: string | null }>) => void;
}>;

/**
 * The meta line under a Team sub-page's title: which Team it is about (unless the title already
 * names it) and which Home holds it. `TeamSection`'s own header and a page that draws its own
 * header (Invitations) both take it from here, so sibling pages never differ.
 */
export function teamPageHeaderMeta(input: Readonly<{
    pageTitle: string;
    teamName: string | null;
    homeName?: string;
}>): readonly PageHeaderMetaFact[] {
    return [
        ...(input.teamName && input.teamName !== input.pageTitle ? [{ key: 'team', text: input.teamName }] : []),
        ...(input.homeName !== undefined ? [{ key: 'home', icon: 'house' as const, text: input.homeName }] : []),
    ];
}
