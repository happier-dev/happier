import * as React from 'react';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';

import type { createSessionAccessActionChip } from '@/components/sessions/agentInput/definitions/createSessionAccessActionChip';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { reconcileSessionAccessDraftForHome } from '@/sync/domains/session/access/sessionAccessDraftReconciliation';

import { SessionAccessEditor } from './SessionAccessEditor';
import { useNewSessionAccessDraftController } from './useNewSessionAccessDraftController';
import { useHasSessionShareCandidates } from './sessionShareCandidateAvailability';

export type NewSessionAccessDraftState = Readonly<{
    /** The exact value that travels as `SessionSpawnNewInputV2.initialAccess`. */
    access: SessionInitialAccessDraftV1 | null;
    primaryTeamId: string | null;
    applyTeamCredentialPolicy: (teamId: string, requireVisibility: boolean) => void;
    /** Whether an existing Teams/people owner currently has someone to share with. */
    hasShareCandidates: boolean;
    /**
     * Chip parameters for the New Session composer, or `null` when unavailable. On every layout the editor opens in
     * the composer's own popover: the chip's popover, or a push inside the "+" menu (native QA: a phone overlay boxed
     * into the docked composer left the editor ~40 pt).
     */
    chip: Parameters<typeof createSessionAccessActionChip>[0] | null;
}>;

type DemandedSessionAccessEditorProps = React.ComponentProps<typeof SessionAccessEditor>
    & Readonly<{ onDemand: (demanded: boolean) => void }>;

/**
 * The editor as the composer's popover mounts it, reporting for its mounted
 * lifetime that an open presentation needs Home candidates. The collapsed chip
 * renders none of this, so the directory stays idle until someone opens it.
 */
function DemandedSessionAccessEditor({ onDemand, ...editor }: DemandedSessionAccessEditorProps): React.ReactElement {
    React.useEffect(() => {
        onDemand(true);
        return () => onDemand(false);
    }, [onDemand]);
    return <SessionAccessEditor {...editor} />;
}

function sameAccessDraft(
    left: SessionInitialAccessDraftV1 | null,
    right: SessionInitialAccessDraftV1 | null,
): boolean {
    if (left === right) return true;
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The New Session composer's access owner.
 *
 * It holds the creation draft, reconciles it when the target Home changes, and
 * projects the one chip both composer presentations render. The chip label is
 * the editor's own summary, so the collapsed and expanded states can never
 * describe different audiences.
 */
export function useNewSessionAccessDraft(input: Readonly<{
    targetServerId: string | null;
    initialAccess?: SessionInitialAccessDraftV1 | null;
    initialPrimaryTeamId?: string | null;
    /**
     * Revision of the synchronized New Session document that supplied the two
     * initial values. It lets an explicit repository conflict decision hydrate
     * this mounted editor without allowing an older echo to replace a newer
     * device edit.
     */
    sourceRevision?: number | null;
    /**
     * Live repository conflict presence for the two synchronized authoring
     * fields. Conflict changes wake this mounted projection, but the repository
     * resolution is still only the source snapshot it describes: a later edit
     * made in this mounted editor wins until its exact value is observed back
     * from the repository.
     */
    sourceAccessConflict?: boolean | null;
    sourcePrimaryTeamConflict?: boolean | null;
}>): NewSessionAccessDraftState {
    const serverId = input.targetServerId ?? null;
    const [access, setAccess] = React.useState<SessionInitialAccessDraftV1 | null>(input.initialAccess ?? null);
    const [primaryTeamId, setPrimaryTeamId] = React.useState<string | null>(input.initialPrimaryTeamId ?? null);
    const [homeReconciled, setHomeReconciled] = React.useState(false);
    const previousServerId = React.useRef(serverId);
    const accessRef = React.useRef(access);
    const primaryTeamIdRef = React.useRef(primaryTeamId);
    const accessHasNewerLocalEdit = React.useRef(false);
    const primaryTeamHasNewerLocalEdit = React.useRef(false);
    const observedSource = React.useRef({
        serverId,
        revision: input.sourceRevision ?? null,
        access: input.initialAccess ?? null,
        primaryTeamId: input.initialPrimaryTeamId ?? null,
    });
    const observedAccessConflict = React.useRef(input.sourceAccessConflict === true);
    const observedPrimaryTeamConflict = React.useRef(input.sourcePrimaryTeamConflict === true);
    accessRef.current = access;
    primaryTeamIdRef.current = primaryTeamId;

    if (previousServerId.current !== serverId) {
        const changedHome = previousServerId.current !== serverId;
        const reconciled = reconcileSessionAccessDraftForHome({
            access, previousServerId: previousServerId.current, nextServerId: serverId,
        });
        previousServerId.current = serverId;
        observedSource.current = {
            serverId,
            revision: input.sourceRevision ?? null,
            access: input.initialAccess ?? null,
            primaryTeamId: input.initialPrimaryTeamId ?? null,
        };
        observedAccessConflict.current = input.sourceAccessConflict === true;
        observedPrimaryTeamConflict.current = input.sourcePrimaryTeamConflict === true;
        if (reconciled.changed) {
            accessHasNewerLocalEdit.current = true;
            setAccess(reconciled.access);
        }
        if (changedHome && primaryTeamId !== null) {
            primaryTeamHasNewerLocalEdit.current = true;
            setPrimaryTeamId(null);
        }
        setHomeReconciled(changedHome && (reconciled.removedCount > 0 || primaryTeamId !== null));
    } else {
        const nextAccessConflict = input.sourceAccessConflict === true;
        const nextPrimaryTeamConflict = input.sourcePrimaryTeamConflict === true;
        const revisionChanged = input.sourceRevision !== undefined
            && input.sourceRevision !== null
            && observedSource.current.revision !== input.sourceRevision;
        // A same-field conflict surfaces without a revision bump (the
        // repository preserves the device value while flagging the divergence),
        // so the editor must observe its presence and later reconcile the
        // chosen repository value without erasing an edit made after that
        // conflict snapshot.
        if (!revisionChanged
            && nextAccessConflict === observedAccessConflict.current
            && nextPrimaryTeamConflict === observedPrimaryTeamConflict.current) {
            // No synchronized change for either field; keep newer device edits.
        } else {
            const sourceAccess = input.initialAccess ?? null;
            const sourcePrimaryTeamId = input.initialPrimaryTeamId ?? null;
            observedSource.current = {
                serverId,
                revision: revisionChanged && input.sourceRevision !== undefined && input.sourceRevision !== null
                    ? input.sourceRevision
                    : observedSource.current.revision,
                access: sourceAccess,
                primaryTeamId: sourcePrimaryTeamId,
            };
            observedAccessConflict.current = nextAccessConflict;
            observedPrimaryTeamConflict.current = nextPrimaryTeamConflict;

            if (sameAccessDraft(access, sourceAccess)) {
                accessHasNewerLocalEdit.current = false;
            } else if (!accessHasNewerLocalEdit.current) {
                setAccess(sourceAccess);
            }

            if (primaryTeamId === sourcePrimaryTeamId) {
                primaryTeamHasNewerLocalEdit.current = false;
            } else if (!primaryTeamHasNewerLocalEdit.current) {
                setPrimaryTeamId(sourcePrimaryTeamId);
            }
        }
    }

    const updateAccess = React.useCallback((next: SessionInitialAccessDraftV1 | null) => {
        if (sameAccessDraft(accessRef.current, next)) return;
        accessHasNewerLocalEdit.current = !sameAccessDraft(observedSource.current.access, next);
        setHomeReconciled(false);
        setAccess(next);
    }, []);
    const updatePrimaryTeamId = React.useCallback((next: string | null) => {
        if (primaryTeamIdRef.current === next) return;
        primaryTeamHasNewerLocalEdit.current = observedSource.current.primaryTeamId !== next;
        setHomeReconciled(false);
        setPrimaryTeamId(next);
    }, []);
    const applyTeamCredentialPolicy = React.useCallback((teamId: string, requireVisibility: boolean) => {
        updatePrimaryTeamId(teamId);
        if (!requireVisibility) return;
        const current = accessRef.current?.grants ?? [];
        // The credential requires only that this Team can see the Session. It is
        // not a level decision, so an explicit grant the creator (or the Team
        // policy floor owned by the draft controller) already chose is preserved
        // rather than silently reduced to the safe default for a new Team.
        if (current.some((grant) => grant.subject.kind === 'team' && grant.subject.teamId === teamId)) return;
        updateAccess({
            grants: [
                ...current,
                {
                    subject: { kind: 'team', teamId },
                    accessLevel: 'view',
                    canApprovePermissions: false,
                },
            ],
        });
    }, [updateAccess, updatePrimaryTeamId]);

    const resolution = useServerCredentialAccountScopeResolution(serverId);
    // Draft candidate reads and eventual authority-bearing grants are action admission and intentionally fail closed.
    const availability = useSessionCollaborationAvailability(serverId ?? '');
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const hasShareCandidates = useHasSessionShareCandidates({
        serverId,
        enabled: scope !== null && availability === 'available',
    });
    // The composer's collapsed chip needs only the authored-grant summary, so
    // candidate discovery stays with the presentation that is actually open. The
    // mounted editor reports through this one signal; the directory keeps its
    // already acquired pages while undemanded, so reopening does not refetch.
    const [popoverDemand, setPopoverDemand] = React.useState(0);
    const demandEditor = React.useCallback((demanded: boolean) => {
        setPopoverDemand((current) => Math.max(0, current + (demanded ? 1 : -1)));
    }, []);
    const controller = useNewSessionAccessDraftController({
        scope: scope ?? { serverId: serverId ?? '', accountId: '' },
        access,
        primaryTeamId,
        availability,
        homeReconciled,
        demanded: popoverDemand > 0,
        onChange: updateAccess,
        onPrimaryTeamIdChange: updatePrimaryTeamId,
    });
    const chip = React.useMemo<NewSessionAccessDraftState['chip']>(() => {
        // A restored shared draft must remain reachable even if this Home can no
        // longer create shared Sessions. The read-only editor provides the explicit
        // recovery to Private instead of silently discarding authority-bearing input.
        const hasRecoverableDraft = Boolean(access?.grants.length || primaryTeamId !== null || homeReconciled);
        if (!scope || ((!hasShareCandidates || availability === 'unavailable') && !hasRecoverableDraft)) return null;
        return {
            label: controller.model.summary.label,
            accessibilityLabel: controller.model.summary.accessibilityLabel,
            pending: controller.placementPending,
            // The host's render form, so Escape drains an access sub-step first,
            // then closes this popover and returns focus to the real chip trigger.
            popoverContent: ({ requestClose }) => (
                <DemandedSessionAccessEditor
                    onDemand={demandEditor}
                    model={controller.model}
                    actions={controller.actions}
                    query={controller.query}
                    presentation="compact"
                    onRequestClose={requestClose}
                    testID="session-access-editor:composer"
                />
            ),
        };
    }, [access?.grants.length, availability, controller.actions, controller.model, controller.placementPending, controller.query, demandEditor, hasShareCandidates, homeReconciled, primaryTeamId, scope]);

    // An unresolved scope hides the control; it never discards an authored
    // draft, which is authority-bearing creation input.
    return React.useMemo(
        () => ({ access, primaryTeamId, chip, applyTeamCredentialPolicy, hasShareCandidates }),
        [access, applyTeamCredentialPolicy, chip, hasShareCandidates, primaryTeamId],
    );
}
