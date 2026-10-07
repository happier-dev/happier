import * as React from 'react';
import { ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessGrantsListResponseV1Schema, type ArtifactAccessGrantRowV1, type ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import type {
    ShareAccessLevel,
    ShareGrantRowModel,
    ShareOperationModel,
    SharePrincipalPresentation,
    ShareSheetActions,
    ShareSheetModel,
    ShareUiError,
    ShareUiReason,
} from '../shareSheetTypes';

type Mutation =
    | Readonly<{ actionId: 'artifact.access.grants.set'; principal: PrincipalRefV1; accessLevel: ShareAccessLevel }>
    | Readonly<{ actionId: 'artifact.access.grants.remove'; principal: PrincipalRefV1 }>;

type State = Readonly<{
    phase: 'initial' | 'ready' | 'error';
    response: ArtifactAccessGrantsListResponseV1 | null;
    issue?: ShareUiError;
    operations: Readonly<Record<string, ShareOperationModel>>;
    confirming: ReadonlySet<string>;
}>;

const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_TEAM_CONTEXTS: readonly [] = [];
const NO_GRANTS: readonly ArtifactAccessGrantRowV1[] = [];

function readFailureCode(result: unknown): string {
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    return typeof record.errorCode === 'string' ? record.errorCode : typeof record.error === 'string' ? record.error : 'artifact_access_failed';
}

/** One message per Artifact grant failure; codes stay the host's, words stay here. */
function presentDocumentShareFailure(code: string): ShareUiError {
    switch (code) {
        case 'unsupported_action':
        case 'artifact_access_unavailable':
        case 'artifact_kind_not_shareable':
        case 'not_authenticated':
            return { code, message: t('shareSheet.documents.errors.unavailable'), retryable: false };
        case 'artifact_access_forbidden':
            return { code, message: t('shareSheet.documents.errors.ownerOnly'), retryable: false };
        case 'artifact_not_found':
            return { code, message: t('shareSheet.documents.errors.notFound'), retryable: false };
        case 'artifact_access_revoked':
            return { code, message: t('shareSheet.documents.errors.noAccess'), retryable: false };
        case 'artifact_subject_not_found':
        case 'artifact_subject_ineligible':
        case 'artifact_owner_grant_invalid':
            return { code, message: t('shareSheet.documents.errors.subjectUnavailable'), retryable: false };
        default:
            return { code, message: t('shareSheet.documents.errors.failed'), retryable: true };
    }
}

function presentGrantPrincipal(row: ArtifactAccessGrantRowV1): SharePrincipalPresentation {
    const ref = row.principal;
    const username = row.display.username ?? undefined;
    const displayName = row.display.name || (username ? `@${username}` : t('shareSheet.person'));
    const secondaryLabel = ref.kind === 'account' && username ? `@${username}` : undefined;
    return {
        ref, key: sessionAccessSubjectKey(ref), displayName,
        ...(secondaryLabel ? { secondaryLabel } : {}),
        ...(ref.kind === 'account' ? { avatar: { id: ref.accountId } } : {}),
        accessibilityLabel: secondaryLabel ? `${displayName}, ${secondaryLabel}` : displayName,
    };
}

/**
 * The documents adapter's controller: one Artifact's grants, read and written only through the
 * `artifact.access.grants.*` Actions. The Action host validates the kind and ownership; every
 * acknowledged response replaces the roster, so the sheet never shows a guess.
 */
export function useDocumentShareController(input: Readonly<{ artifactId: string; scope: ServerAccountScope }>): Readonly<{
    model: ShareSheetModel;
    actions: ShareSheetActions;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    loading: boolean;
    retryContent(): void;
    grants: readonly ArtifactAccessGrantRowV1[];
}> {
    const { artifactId, scope } = input;
    const [execute] = React.useState(() => createFrontDoorActionExecute());
    const [state, setState] = React.useState<State>({ phase: 'initial', response: null, operations: {}, confirming: new Set() });
    const [query, setQuery] = React.useState('');
    const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
    const [revision, setRevision] = React.useState(0);
    const lastMutation = React.useRef(new Map<string, Mutation>());
    const current = React.useRef(artifactId);
    current.current = artifactId;

    const load = React.useCallback(async () => {
        const result = await execute('artifact.access.grants.list', { artifactId }, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null);
        if (current.current !== artifactId) return;
        const parsed = result?.ok ? ArtifactAccessGrantsListResponseV1Schema.safeParse(result.result) : null;
        setState((previous) => parsed?.success
            ? { ...previous, phase: 'ready', response: parsed.data, issue: undefined }
            : { ...previous, phase: 'error', issue: presentDocumentShareFailure(result ? readFailureCode(result) : 'artifact_access_failed') });
    }, [artifactId, execute, scope.serverId, scope.accountId]);
    React.useEffect(() => { void load(); }, [load]);

    const mutate = React.useCallback(async (mutation: Mutation) => {
        const key = sessionAccessSubjectKey(mutation.principal);
        lastMutation.current.set(key, mutation);
        setState((previous) => ({ ...previous, operations: { ...previous.operations,
            [key]: { kind: mutation.actionId === 'artifact.access.grants.remove' ? 'removing' : 'saving' } } }));
        const payload = mutation.actionId === 'artifact.access.grants.set'
            ? { artifactId, principal: mutation.principal, accessLevel: mutation.accessLevel }
            : { artifactId, principal: mutation.principal };
        const result = await execute(mutation.actionId, payload, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null);
        if (current.current !== artifactId) return;
        const parsed = result?.ok ? ArtifactAccessGrantMutationResponseV1Schema.safeParse(result.result) : null;
        setState((previous) => {
            const { [key]: _settled, ...operations } = previous.operations;
            const confirming = new Set(previous.confirming);
            confirming.delete(key);
            if (parsed?.success) {
                const { changed: _changed, access, ...response } = parsed.data;
                if (access === null) {
                    lastMutation.current.clear();
                    return { phase: 'ready', response: null, operations: {}, confirming: new Set(),
                        issue: presentDocumentShareFailure('artifact_access_revoked') };
                }
                lastMutation.current.delete(key);
                return { ...previous, phase: 'ready', response: { ...response, access }, operations, confirming, issue: undefined };
            }
            return { ...previous, confirming,
                operations: { ...operations, [key]: { kind: 'error', error: presentDocumentShareFailure(result ? readFailureCode(result) : 'artifact_access_failed') } } };
        });
        setRevision((value) => value + 1);
    }, [artifactId, execute, scope.serverId, scope.accountId]);

    const response = state.response;
    const isOwner = response?.access === 'owner';
    const editable = isOwner || response?.access === 'admin';
    const grants = response?.grants ?? NO_GRANTS;
    const rows = React.useMemo<readonly ShareGrantRowModel[]>(() => grants.map((row) => {
        const principal = presentGrantPrincipal(row);
        const operation = state.operations[principal.key] ?? IDLE;
        return {
            grant: row.principal,
            principal,
            level: { kind: 'editable', value: row.accessLevel, options: isOwner ? ['view', 'edit', 'admin'] : ['view', 'edit'] },
            removal: state.confirming.has(principal.key) ? { kind: 'confirming', consequences: [] } : { kind: 'allowed' },
            operation,
        };
    }), [grants, isOwner, state.operations, state.confirming]);
    const owner = response && response.ownerAccountId === scope.accountId ? { principal: {
        ref: { kind: 'account' as const, accountId: response.ownerAccountId },
        key: sessionAccessSubjectKey({ kind: 'account', accountId: response.ownerAccountId }),
        displayName: t('shareSheet.you'),
        avatar: { id: response.ownerAccountId },
        accessibilityLabel: t('shareSheet.you'),
    } } : null;

    const directory = useSessionAccessDirectory({
        scope,
        availability: 'available',
        contextTeams: NO_TEAM_CONTEXTS,
        operations: state.operations,
        revision,
        enabled: editable,
    });

    const actions = React.useMemo<ShareSheetActions>(() => ({
        setQuery,
        retryDirectory: directory.retry,
        loadMore: directory.loadMore,
        addPrincipal: (principal) => { void mutate({ actionId: 'artifact.access.grants.set', principal, accessLevel: 'view' }); },
        retryMutation: (grant) => {
            const mutation = lastMutation.current.get(sessionAccessSubjectKey(grant));
            if (mutation) void mutate(mutation);
        },
        setAccessLevel: (grant, accessLevel) => { void mutate({ actionId: 'artifact.access.grants.set', principal: grant, accessLevel }); },
        requestRemove: (grant) => setState((previous) => ({ ...previous,
            confirming: new Set([...previous.confirming, sessionAccessSubjectKey(grant)]) })),
        confirmRemove: (grant) => { void mutate({ actionId: 'artifact.access.grants.remove', principal: grant }); },
        cancelRemove: (grant) => setState((previous) => {
            const confirming = new Set(previous.confirming);
            confirming.delete(sessionAccessSubjectKey(grant));
            return { ...previous, confirming };
        }),
        explain: setNotice,
    }), [directory.loadMore, directory.retry, mutate]);

    return {
        model: {
            revision,
            editable,
            stale: state.phase === 'error' && response !== null,
            owner,
            grants: rows,
            directory: { query, sections: editable ? directory.sections : [] },
        },
        actions,
        ...(state.issue ? { issue: state.issue } : {}),
        ...(notice ? { notice } : {}),
        loading: state.phase === 'initial',
        retryContent: () => { void load(); },
        grants,
    };
}
