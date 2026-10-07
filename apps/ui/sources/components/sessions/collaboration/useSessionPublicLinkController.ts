import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SharingAuthoritySession } from '@/sync/domains/social/sessionSharingMutationAuthority';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SessionAccessApiError, SessionAccessApprovalPendingError, createSessionAccessClient } from '@/sync/api/session/sessionAccessApi';
import { migrateSessionForSharing } from '@/components/sessions/access/migrateSessionForSharing';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import {
    mergeSessionPublicLinkWithCachedBearer,
    type SessionPublicLinkPublication,
} from '@/sync/domains/social/sessionPublicLinkPublication';
import { assertSessionSharingMutationAuthority } from '@/sync/domains/social/sessionSharingMutationAuthority';
import type { ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { presentSessionAccessFailure } from '@/components/sessions/access/presentSessionAccessFailure';
import { useSessionAccessApprovalHold } from '@/components/sessions/access/useSessionAccessApprovalHold';
import { subscribeSessionPublicLinkInvalidation } from '@/sync/domains/social/sessionPublicLinkInvalidation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
    resolvePreferredShareableServerUrl,
    resolveValidatedShareableServerUrl,
} from '@/sync/domains/server/url/shareableServerUrl';
import { buildStoredContentPublicShareUrlV1 } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';

type PublicLinkState = Readonly<{
    epoch: number;
    publication: SessionPublicLinkPublication | null;
    loaded: boolean;
    loading: boolean;
    error: boolean;
}>;

export type SessionPublicLinkControllerInput = Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    session: SharingAuthoritySession | null;
    availability: ExternalSessionSharingAvailability;
    publicLinkEnabled: boolean;
    authorityCurrent?: boolean;
}>;

export type SessionPublicLinkCreateOptions = Readonly<{ expiresInDays?: number; maxUses?: number; isConsentRequired: boolean }>;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function useSessionPublicLinkController(input: SessionPublicLinkControllerInput) {
    const { scope, sessionId, availability, session, publicLinkEnabled, authorityCurrent = true } = input;
    const canManage = publicLinkEnabled && session?.access?.capabilities.managePublicLink === true;
    const allowed = canManage && availability.sharingPresentation.shareable;
    const scopeKey = JSON.stringify([serverAccountScopeKeySuffix(scope), sessionId, allowed]);
    const lifecycle = useRef({ scopeKey, epoch: 0, mounted: true });
    const token = useRef<string | null>(null);
    const currentPublication = useRef<SessionPublicLinkPublication | null>(null);
    if (lifecycle.current.scopeKey !== scopeKey) {
        lifecycle.current = { scopeKey, epoch: lifecycle.current.epoch + 1, mounted: true };
        token.current = null;
        currentPublication.current = null;
    }
    const epoch = lifecycle.current.epoch;
    const currentSession = useRef(session);
    currentSession.current = session;
    // Card callbacks can outlive the render that bound them (a confirmation is
    // awaited in between). Read the current authority through the same mutable
    // fence used for the exact Session, so a retained control cannot replay a
    // stale mutation after a transient or definitive snapshot change.
    const authorityCurrentRef = useRef(authorityCurrent);
    authorityCurrentRef.current = authorityCurrent;
    const requestRevision = useRef(0);
    const [state, setState] = useState<PublicLinkState>({ epoch, publication: null, loaded: false, loading: false, error: false });
    const isCurrent = useCallback(() => lifecycle.current.mounted && lifecycle.current.epoch === epoch, [epoch]);
    const assertCurrent = useCallback(() => {
        if (!isCurrent() || !authorityCurrentRef.current || !allowed || !currentSession.current) throw new HappyError(t('errors.permissionDenied'), false);
        assertSessionSharingMutationAuthority(currentSession.current, 'managePublicLink');
    }, [allowed, authorityCurrent, isCurrent]);
    /**
     * One Action-backed publication client per request.
     *
     * Publication is an independently released boundary, so the collaboration
     * availability decision above must not withdraw it; the caller's
     * `publicLinkEnabled` decision and the Home's own capability check remain
     * the authority.
     */
    const client = useCallback((options?: Readonly<{ onLinkIssued?: (issued: Readonly<{ lookupId: string; secret: string }>) => void }>) => createSessionAccessClient({
        // Rebuilt from the qualified fields so a fresh prop object cannot
        // restart the read loop through a changed callback identity.
        scope: { serverId: scope.serverId, accountId: scope.accountId },
        sessionId,
        availability: 'unavailable',
        isCurrent,
        ...(options?.onLinkIssued ? { onPublicLinkIssued: options.onLinkIssued } : {}),
    }), [isCurrent, scope.accountId, scope.serverId, sessionId]);
    const applyAuthoritativePublication = useCallback((publication: SessionPublicLinkPublication | null) => {
        ++requestRevision.current;
        token.current = publication?.token ?? null;
        currentPublication.current = publication;
        setState({ epoch, publication, loaded: true, loading: false, error: false });
    }, [epoch]);
    useEffect(() => {
        lifecycle.current.mounted = true;
        return () => {
            lifecycle.current.mounted = false;
            token.current = null;
            currentPublication.current = null;
        };
    }, []);

    const reload = useCallback(async () => {
        if (!authorityCurrent || !allowed || !isCurrent()) return;
        const revision = ++requestRevision.current;
        setState((previous) => ({ ...(previous.epoch === epoch ? previous : { epoch, publication: null, loaded: false }), loading: true, error: false }));
        try {
            assertCurrent();
            const publication = await client().getPublicLink();
            if (!isCurrent() || requestRevision.current !== revision) return;
            const merged = mergeSessionPublicLinkWithCachedBearer({
                previousPublication: currentPublication.current,
                cachedToken: token.current,
                outcome: { ok: true, publication },
            });
            token.current = merged.cachedToken;
            currentPublication.current = merged.publication;
            setState({ epoch, publication: merged.publication, loaded: true, loading: false, error: false });
        } catch {
            if (!isCurrent() || requestRevision.current !== revision) return;
            setState((previous) => ({ ...previous, loading: false, error: true }));
        }
    }, [allowed, assertCurrent, authorityCurrent, client, epoch, isCurrent]);
    useEffect(() => { void reload(); }, [reload]);
    useEffect(() => {
        if (!authorityCurrent || !allowed) return;
        return subscribeSessionPublicLinkInvalidation(
            { serverId: scope.serverId, sessionId },
            () => { void reload(); },
        );
    }, [allowed, authorityCurrent, reload, scope.serverId, sessionId]);

    const presentFailure = useCallback((error: unknown): never => {
        const issue = presentSessionAccessFailure(error, { outcomeUnknown: true });
        throw new HappyError(issue.message, issue.retryable, {
            status: error instanceof SessionAccessApiError ? error.status : undefined,
            code: issue.code,
        });
    }, []);

    // The one publication change the canonical Action policy routed to an
    // approval Artifact, settled once through the shared continuation owner; the
    // section renders it until then instead of an unknown outcome.
    const approval = useSessionAccessApprovalHold({
        scopeKey, scope: { serverId: scope.serverId, accountId: scope.accountId },
    });
    const holdApproval = approval.hold;
    const holdForApproval = useCallback((
        pending: SessionAccessApprovalPendingError,
        actionId: 'session.public_link.create' | 'session.public_link.remove',
        expectedInput: unknown,
        onSucceeded: () => Promise<void>,
    ) => {
        // The card cannot show a publication that does not exist yet; its
        // approval line is where this change is followed now.
        holdApproval(pending, actionId, expectedInput, {
            isCurrent,
            onSucceeded,
            onFailed: (issue) => {
                if (!issue) return;
                // Only the authoritative reader can say what exists now.
                void reload();
                Modal.alert(t('common.error'), issue.message);
            },
        });
    }, [holdApproval, isCurrent, reload]);

    const create = useCallback(async (options: SessionPublicLinkCreateOptions): Promise<SessionPublicLinkPublication | null> => {
        assertCurrent();
        const desired = {
            expiresAt: options.expiresInDays ? Date.now() + options.expiresInDays * MILLISECONDS_PER_DAY : null,
            maxUses: options.maxUses ?? null,
            isConsentRequired: options.isConsentRequired,
        };
        // A historical (layout-0) Session is migrated by its owner before any
        // public projection exists, or the link would open to nothing (PA-L2/L4).
        if (readSessionMetadataLayoutVersion(currentSession.current?.metadataLayoutVersion) === 0) {
            try {
                await migrateSessionForSharing({
                    scope: { serverId: scope.serverId, accountId: scope.accountId }, sessionId, isCurrent,
                });
            } catch {
                throw new HappyError(t('errors.operationFailed'), true);
            }
            assertCurrent();
        }
        const input = {
            ...(desired.expiresAt === null ? {} : { expiresAt: desired.expiresAt }),
            ...(desired.maxUses === null ? {} : { maxUses: desired.maxUses }),
            isConsentRequired: desired.isConsentRequired,
        };
        const issued: { material: Readonly<{ lookupId: string; secret: string }> | null } = { material: null };
        let created: SessionPublicLinkPublication | null = null;
        try {
            const settings = await client({ onLinkIssued: (material) => { issued.material = material; } }).createPublicLink(input);
            assertCurrent();
            if (!issued.material || !settings.isolatedOrigin || settings.keyDerivation !== 'fragment_v1') throw new SessionAccessApiError('outcome_unknown');
            created = { ...settings, token: issued.material.lookupId,
                publicUrl: buildStoredContentPublicShareUrlV1({ origin: settings.isolatedOrigin, ...issued.material }),
            };
        } catch (error) {
            if (!created) {
                if (error instanceof SessionAccessApprovalPendingError && isCurrent()) {
                    // Approval settles at its trusted host and returns the link
                    // to its caller. This sheet reloads publication settings;
                    // that read cannot recover the fragment secret.
                    holdForApproval(error, 'session.public_link.create', { sessionId, ...input }, reload);
                    return null;
                }
                if (!(error instanceof SessionAccessApiError) && !(error instanceof HappyError)) throw error;
                return presentFailure(error);
            }
        }
        assertCurrent();
        applyAuthoritativePublication(created);
        return created;
    }, [applyAuthoritativePublication, assertCurrent, client, holdForApproval, isCurrent, presentFailure, reload, scope.accountId, scope.serverId, sessionId]);

    const remove = useCallback(async (): Promise<void> => {
        assertCurrent();
        try {
            await client().removePublicLink();
        } catch (error) {
            if (error instanceof SessionAccessApprovalPendingError && isCurrent()) {
                holdForApproval(error, 'session.public_link.remove', { sessionId }, async () => {
                    applyAuthoritativePublication(null);
                    await reload();
                });
                return;
            }
            if (error instanceof SessionAccessApiError && error.code === 'outcome_unknown') {
                // The DELETE may already have committed. Only the authoritative
                // reader can settle that; a failed read proves nothing.
                try {
                    const publication = await client().getPublicLink();
                    assertCurrent();
                    const merged = mergeSessionPublicLinkWithCachedBearer({
                        previousPublication: currentPublication.current,
                        cachedToken: token.current,
                        outcome: { ok: true, publication },
                    });
                    applyAuthoritativePublication(merged.publication);
                    if (publication === null) {
                        return;
                    }
                } catch {
                    // Fall through to the unresolved-outcome presentation.
                }
            }
            if (!(error instanceof SessionAccessApiError) && !(error instanceof HappyError)) throw error;
            return presentFailure(error);
        }
        assertCurrent();
        applyAuthoritativePublication(null);
        await reload();
    }, [applyAuthoritativePublication, assertCurrent, client, holdForApproval, isCurrent, presentFailure, reload, sessionId]);

    const publication = state.epoch === epoch && allowed ? state.publication : null;
    // The Home's own shareable address rides along in the link, so a viewer opening it reaches
    // this Home even when it is not the app's default.
    const shareableServerUrl = useMemo(() => {
        const profile = getServerProfileById(scope.serverId);
        if (!profile) return null;
        const validatedShareableServerUrl = resolveValidatedShareableServerUrl({
            shareableServerUrl: profile.shareableServerUrl,
            validatedAgainstServerUrl: profile.shareableServerUrlValidatedAgainstServerUrl,
            currentServerUrl: profile.serverUrl,
        });
        return resolvePreferredShareableServerUrl({
            preferredShareableServerUrl: validatedShareableServerUrl,
            canonicalServerUrl: profile.serverUrl,
            activeServerUrl: null,
        });
    }, [scope.serverId]);
    const currentPendingApproval = allowed ? approval.pendingApproval : null;
    return {
        publicShare: publication, canManage,
        hasLoaded: allowed && state.epoch === epoch && state.loaded,
        loading: allowed && (state.epoch !== epoch || !state.loaded || state.loading) && !state.error,
        error: allowed && state.epoch === epoch && state.error,
        // One publication change at a time: an open approval holds every control,
        // and a snapshot that is not current withdraws them without hiding the link.
        canMutate: authorityCurrent && allowed && state.epoch === epoch && state.loaded && !state.error && !currentPendingApproval,
        pendingApproval: currentPendingApproval,
        openPendingApproval: approval.openPendingApproval,
        shareableServerUrl,
        reload, create, remove,
    };
}
