import * as React from 'react';

import type { createSessionAccessActionChip } from '@/components/sessions/agentInput/definitions/createSessionAccessActionChip';
import type { SessionCollaborationHandoff } from '@/components/sessions/collaboration/sessionCollaborationIntent';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildSessionContextFacts } from '@/sync/domains/session/presentation/sessionContextPresentation';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { observeTeam } from '@/sync/engine/teams/teamsDirectoryEngine';
import { subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';

import { LiveSessionAccessEditor } from './LiveSessionAccessEditor';
import { projectSessionAccessChipSummary } from './projectSessionAccessChipSummary';

export type SessionAccessComposerChipParams = Parameters<typeof createSessionAccessActionChip>[0];

/**
 * The existing-Session composer's access chip owner, and the sibling of
 * `useNewSessionAccessDraft`'s chip projection.
 *
 * It exists so the in-Session composer gets the same stable chip parameters the
 * New Session composer already gets. The Session shell re-renders on every
 * transcript change; rebuilding these parameters there would give the whole
 * composer action row a new identity on each of those renders.
 *
 * The label names only the Session's authored Team context and its policy lock.
 * The Session record carries effective access, never a grant census, so the chip
 * must not derive `Private` or a total from rows it was never given; the audience
 * appears when the editor mounts and reads the authoritative list.
 *
 * The chip is withheld only for a Session with no qualified target. A Home
 * without the collaboration vertical keeps its control and lets the mounted
 * editor state the update/availability reason, exactly as the New Session draft
 * composer keeps its recovery path rather than silently dropping the control.
 */
export function useSessionAccessComposerChip(input: Readonly<{
    /** The exact Session, or `null` when this composer has no qualified target. */
    target: SessionAddress | null;
    /**
     * The Session's current server access projection, consumed only for the
     * compact summary. This chip never fetches a grant roster.
     */
    access?: NormalizedSessionAccessProjection | null;
    /**
     * Supplied only by a host that navigates to the Collaboration surface instead
     * of anchoring the compact editor to the chip.
     */
    onOpen?: (() => void) | null;
    /**
     * The handoff an anchored compact editor offers from inside its popover, so
     * the desktop composer is not a dead end. It forwards the editor's own
     * root-step query, which is all the destination's separate controller
     * cannot rebuild for itself.
     */
    onOpenFullSurface?: ((handoff: SessionCollaborationHandoff) => void) | null;
}>): SessionAccessComposerChipParams | null {
    const serverId = input.target?.serverId ?? null;
    const sessionId = input.target?.sessionId ?? null;
    const onOpen = input.onOpen ?? null;
    const onOpenFullSurface = input.onOpenFullSurface ?? null;
    const primaryTeamId = input.access?.primaryTeamId ?? null;
    // The Home's own explanation of this viewer's access already carries the
    // policy fact the grant row locks on, so no roster read is needed for it.
    const requiredByTeamPolicy = input.access?.sources?.some(
        (source) => source.kind === 'team' && source.requiredByTeamPolicy,
    ) === true;

    const resolution = useServerCredentialAccountScopeResolution(serverId);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    // Team context is deliberately not the audience, so this observes the
    // authored primary Team rather than reusing the audience-keyed surface hook;
    // the name itself still comes from the one Session context-fact owner.
    const observedTeamKey = scope && primaryTeamId
        ? JSON.stringify([scope.serverId, scope.accountId, primaryTeamId])
        : null;
    React.useEffect(() => {
        if (!scope || !primaryTeamId) return;
        return observeTeam(scope, { serverId: scope.serverId, teamId: primaryTeamId });
        // Exact observer identity; unrelated scope object churn keeps one observer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [observedTeamKey]);
    const readContextLabel = React.useCallback(() => (scope && primaryTeamId && serverId && sessionId
        ? buildSessionContextFacts({
            address: { serverId, sessionId },
            audienceContext: { kind: 'team', teamId: primaryTeamId },
            audienceScope: scope,
        }).audience?.label ?? ''
        : ''), [primaryTeamId, scope, serverId, sessionId]);
    const contextLabel = React.useSyncExternalStore(subscribeTeamsSnapshots, readContextLabel, readContextLabel);

    // Resolved outside the memo so a language change reaches the chip label.
    const summary = projectSessionAccessChipSummary({
        grants: [],
        audienceComplete: false,
        requiredByTeamPolicy,
        ...(contextLabel ? { contextLabel } : {}),
    });
    // This compact projection holds neither the audience nor its default grants.
    // Keep ordinary placement rather than inferring differing access from the
    // viewer's role, Team label or policy lock; the opened editor owns the roster.
    const label = summary.label;
    const accessibilityLabel = summary.accessibilityLabel;

    return React.useMemo<SessionAccessComposerChipParams | null>(() => {
        if (!serverId || !sessionId) return null;
        return {
            label,
            accessibilityLabel,
            requiredByTeamPolicy,
            popoverContent: ({ requestClose }) => (
                <LiveSessionAccessEditor
                    target={{ serverId, sessionId }}
                    presentation="compact"
                    onRequestClose={requestClose}
                    {...(onOpenFullSurface
                        ? { onOpenFullSurface: (handoff: SessionCollaborationHandoff) => { requestClose(); onOpenFullSurface(handoff); } }
                        : {})}
                    testID="session-access-editor:composer"
                />
            ),
            ...(onOpen ? { onOpen } : {}),
        };
    }, [accessibilityLabel, label, onOpen, onOpenFullSurface, requiredByTeamPolicy, serverId, sessionId]);
}
