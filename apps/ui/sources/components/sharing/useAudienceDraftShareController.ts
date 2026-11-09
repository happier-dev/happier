import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { presentSharePrincipal } from './sharePrincipalPresentation';
import { useShareViewerProfile } from './useShareViewerProfile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type {
    ShareGrantRowModel,
    ShareOperationModel,
    SharePrincipalPresentation,
    ShareSheetActions,
    ShareSheetModel,
    ShareUiReason,
} from './shareSheetTypes';

const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_OPERATIONS: Readonly<Record<string, ShareOperationModel>> = Object.freeze({});
const NO_TEAM_CONTEXTS: readonly [] = [];
const ALLOWED_REMOVAL = { kind: 'allowed' } as const;
const NO_NAMES: Readonly<Record<string, SharePrincipalPresentation>> = Object.freeze({});

/** Who a draft audience reaches before its host's one write: people, Teams and Groups. */
export type ShareAudienceDraft = readonly PrincipalRefV1[];

/**
 * A local draft audience edited on the one share sheet. Adding and removing change the draft only;
 * the host's commit is the one write. Every row is locked at the host's single level.
 */
export function useAudienceDraftShareController(input: Readonly<{
    scope: ServerAccountScope;
    draft: ShareAudienceDraft;
    onChange: (draft: ShareAudienceDraft) => void;
    disabled: boolean;
    /** Why every row has one level, in the host's words. */
    lockReason: ShareUiReason;
    /** Names for principals the host already knows (for example a retained audience). */
    retainedNames?: Readonly<Record<string, SharePrincipalPresentation>>;
}>): Readonly<{ model: ShareSheetModel; actions: ShareSheetActions; notice?: ShareUiReason }> {
    const { scope, draft, onChange, disabled, lockReason } = input;
    const retainedNames = input.retainedNames ?? NO_NAMES;
    const viewerProfile = useShareViewerProfile(scope);
    const [query, setQuery] = React.useState('');
    const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
    // Names come from the host's retained audience, then from the candidate row the person chose.
    const [chosenNames, setChosenNames] = React.useState<Readonly<Record<string, SharePrincipalPresentation>>>({});
    // Directory rows are resolved once and cached by the list, so the handlers they captured outlive
    // the draft that produced them. Reading the current draft through a ref keeps every choice additive.
    const draftRef = React.useRef(draft);
    draftRef.current = draft;

    const directory = useSessionAccessDirectory({
        scope,
        availability: 'available',
        contextTeams: NO_TEAM_CONTEXTS,
        operations: NO_OPERATIONS,
        revision: 0,
        enabled: true,
    });

    // The rows a search returned, by key. Only a chosen row's name enters state, when it is added, so
    // a search never re-renders the sheet.
    const seen = React.useRef(new Map<string, SharePrincipalPresentation>());
    const sections = React.useMemo(() => directory.sections.map((section) => section.resolveCandidates ? {
        ...section,
        resolveCandidates: async (search: string, signal: AbortSignal) => {
            const candidates = await section.resolveCandidates!(search, signal);
            for (const candidate of candidates) seen.current.set(candidate.principal.key, candidate.principal);
            return candidates;
        },
    } : section), [directory.sections]);
    const directorySectionsRef = React.useRef(directory.sections);
    directorySectionsRef.current = directory.sections;

    const grants = React.useMemo<readonly ShareGrantRowModel[]>(() => draft.map((ref) => {
        const key = sessionAccessSubjectKey(ref);
        const known = retainedNames[key] ?? chosenNames[key];
        const profile = ref.kind === 'account' && ref.accountId === scope.accountId ? viewerProfile : null;
        return {
            grant: ref,
            principal: profile ? presentSharePrincipal({ ref, name: known?.displayName, profile, viewerAccountId: scope.accountId })
                : known ?? presentSharePrincipal({ ref, viewerAccountId: scope.accountId }),
            level: { kind: 'locked', value: 'view', reason: lockReason },
            removal: ALLOWED_REMOVAL,
            operation: IDLE,
        };
    }), [chosenNames, draft, lockReason, retainedNames, scope.accountId, viewerProfile]);

    const actions = React.useMemo<ShareSheetActions>(() => {
        const remove = (grant: PrincipalRefV1) => {
            const key = sessionAccessSubjectKey(grant);
            onChange(draftRef.current.filter((principal) => sessionAccessSubjectKey(principal) !== key));
        };
        return {
            setQuery,
            retryDirectory: directory.retry,
            loadMore: directory.loadMore,
            addPrincipal: (principal) => {
                const key = sessionAccessSubjectKey(principal);
                if (draftRef.current.some((existing) => sessionAccessSubjectKey(existing) === key)) return;
                const presentation = seen.current.get(key) ?? directorySectionsRef.current
                    .flatMap((section) => section.candidates)
                    .find((candidate) => candidate.principal.key === key)?.principal;
                if (presentation) setChosenNames((current) => current[key] === presentation ? current : { ...current, [key]: presentation });
                onChange([...draftRef.current, principal]);
            },
            // Nothing is written until Save, so there is no mutation to retry and no level to change.
            retryMutation: () => {},
            setAccessLevel: () => {},
            // A draft removal has no consequence until Save, which is the confirmation.
            requestRemove: remove,
            confirmRemove: remove,
            cancelRemove: () => {},
            explain: setNotice,
        };
    }, [directory.loadMore, directory.retry, onChange]);

    return {
        model: {
            revision: 0,
            draft: true,
            editable: !disabled,
            stale: false,
            owner: null,
            grants,
            directory: { query, sections },
        },
        actions,
        ...(notice ? { notice } : {}),
    };
}
