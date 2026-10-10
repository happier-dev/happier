import * as React from 'react';
import type { AccountDisplayProfileV1, PrincipalRefV1, SavedSecretCatalogAudienceV1 } from '@happier-dev/protocol';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type {
    ShareGrantRowModel,
    ShareOperationModel,
    SharePrincipalPresentation,
    ShareSheetActions,
    ShareSheetModel,
    ShareUiReason,
} from '../shareSheetTypes';
import type { SavedSecretGrantDraft } from './savedSecretGrantDraft';

const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_OPERATIONS: Readonly<Record<string, ShareOperationModel>> = Object.freeze({});
const NO_TEAM_CONTEXTS: readonly [] = [];
const ALLOWED_REMOVAL = { kind: 'allowed' } as const;

function audiencePresentations(audience: SavedSecretCatalogAudienceV1 | undefined, viewerAccountId: string, viewerProfile: AccountDisplayProfileV1 | null): Readonly<Record<string, SharePrincipalPresentation>> {
    const values: Record<string, SharePrincipalPresentation> = {};
    for (const account of audience?.accounts ?? []) {
        const ref: PrincipalRefV1 = { kind: 'account', accountId: account.accountId };
        values[sessionAccessSubjectKey(ref)] = presentSharePrincipal({ ref,
            profile: account.accountId === viewerAccountId && viewerProfile ? viewerProfile : account,
            avatarUrl: account.avatarUrl, viewerAccountId });
    }
    for (const team of audience?.teams ?? []) {
        const ref: PrincipalRefV1 = { kind: 'team', teamId: team.teamId };
        values[sessionAccessSubjectKey(ref)] = presentSharePrincipal({ ref, name: team.name });
    }
    for (const group of audience?.groups ?? []) {
        const ref: PrincipalRefV1 = { kind: 'group', teamId: group.teamId, groupId: group.groupId };
        values[sessionAccessSubjectKey(ref)] = presentSharePrincipal({ ref, name: group.name, teamName: group.teamName });
    }
    return values;
}

/**
 * The Saved Secret adapter's controller: a local draft of who the secret reaches, edited on the one
 * share sheet. Adding and removing change the draft only; the host's Save is the one write, through
 * the existing Saved Secret grant Actions. A secret has one level, so every row is locked at "Can use".
 */
export function useSavedSecretShareController(input: Readonly<{
    scope: ServerAccountScope;
    draft: SavedSecretGrantDraft;
    onChange: (draft: SavedSecretGrantDraft) => void;
    disabled: boolean;
    retainedAudience?: SavedSecretCatalogAudienceV1;
}>): Readonly<{ model: ShareSheetModel; actions: ShareSheetActions; notice?: ShareUiReason }> {
    const { scope, draft, onChange, disabled, retainedAudience } = input;
    const viewerProfile = useShareViewerProfile(scope);
    const [query, setQuery] = React.useState('');
    const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
    // Names come from the audience the Home returned, then from the candidate row the person chose.
    const [chosenNames, setChosenNames] = React.useState<Readonly<Record<string, SharePrincipalPresentation>>>({});
    const retainedNames = React.useMemo(() => audiencePresentations(retainedAudience, scope.accountId, viewerProfile), [retainedAudience, scope.accountId, viewerProfile]);
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

    const lockReason = React.useMemo<ShareUiReason>(() => ({ code: 'saved_secret_single_level', message: t('shareSheet.secrets.oneLevel') }), []);
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
