import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { ProjectSourcesController } from '@/components/projects/sources/projectSourcesController';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type { ShareGrantRowModel, ShareOperationModel, ShareSheetActions, ShareSheetModel, ShareUiReason } from '../shareSheetTypes';
import { isGrantToOwningTeam, presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import { useSharePrincipalNames } from '../sharePrincipalNames';

const NO_TEAMS: readonly [] = [];
const IDLE: ShareOperationModel = { kind: 'idle' };
const EMPTY_OPERATIONS: Readonly<Record<string, ShareOperationModel>> = {};

/** The Source owner supplies a typed issue; keep its recovery sentence in the ShareSheet row. */
export function presentProjectSourceShareFailure(code: string): string | null {
    switch (code) {
        case 'source_conflict': return t('projects.sources.changed');
        case 'outcome_unknown': return t('projects.sources.outcomeUnknown');
        case 'source_access_denied':
        case 'source_unavailable': return t('projects.sources.unavailable');
        case 'home_unreachable': return t('projects.sources.offlineReason', { home: t('common.home') });
        case 'source_backend_unavailable': return t('projects.sources.backendUnavailable');
        case 'source_invalid': return t('projects.sources.addressInvalid');
        case 'source_save_failed': return t('projects.sources.saveFailed');
        default: return null;
    }
}

/** Audience intents use the selected Source's acknowledged revision and its one update Action. */
export function useProjectSourceShareController(input: Readonly<{
    controller: ProjectSourcesController;
    enabled: boolean;
}>) {
    const { controller } = input;
    const scope = controller.scope;
    const viewerProfile = useShareViewerProfile(scope);
    const sourceState = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const source = sourceState.current;
    const subjects = React.useMemo(() => input.enabled
        ? source?.audience.map(grant => grant.principal) ?? null : null, [input.enabled, source?.audience]);
    const { names } = useSharePrincipalNames(subjects, scope.serverId);
    const [query, setQuery] = React.useState('');
    const [operations, setOperations] = React.useState(EMPTY_OPERATIONS);
    const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
    const [confirmingRemoval, setConfirmingRemoval] = React.useState<string | null>(null);
    const lastIntent = React.useRef(new Map<string, Readonly<{ principal: PrincipalRefV1; add: boolean }>>());
    const identity = serverAccountScopedResourceKey(scope, source?.id ?? '');
    const operationIdentity = React.useRef(identity);
    const isCurrentSource = operationIdentity.current === identity;
    const scopedOperations = isCurrentSource ? operations : EMPTY_OPERATIONS;
    const scopedConfirmingRemoval = isCurrentSource ? confirmingRemoval : null;
    const directory = useSessionAccessDirectory({ scope, availability: 'available', contextTeams: NO_TEAMS,
        operations: scopedOperations, revision: source?.revision ?? 0,
        enabled: input.enabled && sourceState.canManage && sourceState.detailStatus === 'ready' && source !== null });
    const currentIdentity = React.useRef(identity);
    currentIdentity.current = identity;
    React.useEffect(() => { operationIdentity.current = identity; setOperations(EMPTY_OPERATIONS);
        lastIntent.current.clear(); setQuery(''); setNotice(undefined); setConfirmingRemoval(null); }, [identity]);

    const mutate = React.useCallback(async (principal: PrincipalRefV1, add: boolean) => {
        const current = controller.getSnapshot();
        if (!current.canManage || current.detailStatus !== 'ready' || !current.current || current.conflict || current.mutation !== 'idle') return;
        const key = sessionAccessSubjectKey(principal);
        const captured = currentIdentity.current;
        lastIntent.current.set(key, { principal, add });
        setOperations((previous) => ({ ...previous, [key]: { kind: add ? 'saving' : 'removing' } }));
        const remaining = current.current.audience.filter((grant) => sessionAccessSubjectKey(grant.principal) !== key);
        const audience = add ? [...remaining, { principal, level: 'view' as const }] : remaining;
        const result = await controller.updateSource({ audience }).catch(() => null);
        if (currentIdentity.current !== captured) return;
        if (result?.ok) {
            lastIntent.current.delete(key);
            setOperations((previous) => { const { [key]: _done, ...next } = previous; return next; });
        } else {
            const code = result && !result.ok ? result.error : controller.getSnapshot().issue ?? 'source_save_failed';
            setOperations((previous) => ({ ...previous, [key]: { kind: 'error', error: {
                code, message: presentProjectSourceShareFailure(code) ?? t('errors.operationFailed'), retryable: code !== 'source_conflict' && code !== 'outcome_unknown',
            } } }));
        }
    }, [controller]);

    const grants = React.useMemo<readonly ShareGrantRowModel[]>(() => {
        return (source?.audience ?? [])
            .filter(({ principal }) => !isGrantToOwningTeam(source?.owner, principal))
            .map((grant) => {
                const principal = presentSharePrincipal({ ref: grant.principal,
                    name: names?.get(sessionAccessSubjectKey(grant.principal)), viewerAccountId: scope.accountId,
                    profile: grant.principal.kind === 'account' && grant.principal.accountId === scope.accountId ? viewerProfile : null });
                return { grant: grant.principal, principal,
                    level: { kind: 'editable', value: 'view', options: ['view'] },
                    removal: principal.key === scopedConfirmingRemoval ? { kind: 'confirming', consequences: [] } : { kind: 'allowed' },
                    operation: scopedOperations[principal.key] ?? IDLE };
            });
    }, [source?.audience, source?.owner, scopedOperations, scopedConfirmingRemoval, names, scope.accountId, viewerProfile]);
    const ownerRef = source ? source.owner ?? { kind: 'account' as const, accountId: source.createdByAccountId } : null;
    const ownerTeamName = ownerRef?.kind === 'team'
        ? source?.audienceTeams?.find(team => team.teamId === ownerRef.teamId)?.name : undefined;
    const model: ShareSheetModel = {
        revision: source?.revision ?? 0, editable: sourceState.canManage && sourceState.detailStatus === 'ready'
            && source !== null && sourceState.conflict === null && sourceState.mutation === 'idle',
        stale: sourceState.detailStatus === 'offline', owner: ownerRef ? { principal: presentSharePrincipal({ ref: ownerRef,
            name: ownerTeamName, viewerAccountId: scope.accountId,
            profile: ownerRef.kind === 'account' && ownerRef.accountId === scope.accountId ? viewerProfile : null }) } : null,
        grants, directory: { query: isCurrentSource ? query : '', sections: directory.sections },
    };
    const actions: ShareSheetActions = {
        setQuery, retryDirectory: directory.retry, loadMore: directory.loadMore,
        addPrincipal: (principal) => { void mutate(principal, true); },
        retryMutation: (principal) => { const intent = lastIntent.current.get(sessionAccessSubjectKey(principal)); if (intent) void mutate(intent.principal, intent.add); },
        setAccessLevel: () => {},
        requestRemove: (principal) => {
            const key = sessionAccessSubjectKey(principal);
            if (model.editable && model.grants.some(row => row.principal.key === key)) setConfirmingRemoval(key);
        },
        confirmRemove: (principal) => {
            if (!model.editable || scopedConfirmingRemoval !== sessionAccessSubjectKey(principal)) return;
            setConfirmingRemoval(null);
            void mutate(principal, false);
        },
        cancelRemove: (principal) => {
            if (scopedConfirmingRemoval === sessionAccessSubjectKey(principal)) setConfirmingRemoval(null);
        },
        explain: setNotice,
    };
    return { model, actions, notice: isCurrentSource ? notice : undefined };
}
