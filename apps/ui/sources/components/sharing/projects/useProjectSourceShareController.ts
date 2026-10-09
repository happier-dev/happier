import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { ProjectSourcesController } from '@/components/projects/sources/projectSourcesController';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type { ShareGrantRowModel, ShareOperationModel, ShareSheetActions, ShareSheetModel, ShareUiReason } from '../shareSheetTypes';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';

const NO_TEAMS: readonly [] = [];
const IDLE: ShareOperationModel = { kind: 'idle' };
const EMPTY_OPERATIONS: Readonly<Record<string, ShareOperationModel>> = {};
const EMPTY_CONFIRMING: ReadonlySet<string> = new Set();

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
    const [query, setQuery] = React.useState('');
    const [operations, setOperations] = React.useState(EMPTY_OPERATIONS);
    const [confirming, setConfirming] = React.useState<ReadonlySet<string>>(new Set());
    const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
    const lastIntent = React.useRef(new Map<string, Readonly<{ principal: PrincipalRefV1; add: boolean }>>());
    const identity = serverAccountScopedResourceKey(scope, source?.id ?? '');
    const operationIdentity = React.useRef(identity);
    const scopedOperations = operationIdentity.current === identity ? operations : EMPTY_OPERATIONS;
    const scopedConfirming = operationIdentity.current === identity ? confirming : EMPTY_CONFIRMING;
    const directory = useSessionAccessDirectory({ scope, availability: 'available', contextTeams: NO_TEAMS,
        operations: scopedOperations, revision: source?.revision ?? 0,
        enabled: input.enabled && sourceState.canManage && sourceState.detailStatus === 'ready' && source !== null });
    const currentIdentity = React.useRef(identity);
    currentIdentity.current = identity;
    React.useEffect(() => { operationIdentity.current = identity; setOperations(EMPTY_OPERATIONS); setConfirming(EMPTY_CONFIRMING);
        lastIntent.current.clear(); setQuery(''); setNotice(undefined); }, [identity]);

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
        setConfirming((previous) => { const next = new Set(previous); next.delete(key); return next; });
        if (result?.ok) {
            lastIntent.current.delete(key);
            setOperations((previous) => { const { [key]: _done, ...next } = previous; return next; });
        } else {
            const code = result && !result.ok ? result.error : controller.getSnapshot().issue ?? 'source_save_failed';
            setOperations((previous) => ({ ...previous, [key]: { kind: 'error', error: {
                code, message: t('errors.operationFailed'), retryable: code !== 'source_conflict' && code !== 'outcome_unknown',
            } } }));
        }
    }, [controller]);

    const grants = React.useMemo<readonly ShareGrantRowModel[]>(() => {
        const knownPrincipals = new Map(directory.sections.flatMap(section => section.candidates)
            .map(candidate => [candidate.principal.key, candidate.principal] as const));
        return (source?.audience ?? []).map((grant) => {
            const known = knownPrincipals.get(sessionAccessSubjectKey(grant.principal));
            const principal = presentSharePrincipal({ ref: grant.principal, name: known?.displayName,
                teamName: known?.secondaryLabel, viewerAccountId: scope.accountId,
                profile: grant.principal.kind === 'account' && grant.principal.accountId === scope.accountId ? viewerProfile : null });
            return { grant: grant.principal, principal,
                level: { kind: 'editable', value: 'view', options: ['view'] },
                removal: scopedConfirming.has(principal.key) ? { kind: 'confirming', consequences: [] } : { kind: 'allowed' },
                operation: scopedOperations[principal.key] ?? IDLE };
        });
    }, [source?.audience, scopedConfirming, scopedOperations, directory.sections, scope.accountId, viewerProfile]);
    const ownerRef = source ? { kind: 'account' as const, accountId: source.createdByAccountId } : null;
    const model: ShareSheetModel = {
        revision: source?.revision ?? 0, editable: sourceState.canManage && sourceState.detailStatus === 'ready'
            && source !== null && sourceState.conflict === null && sourceState.mutation === 'idle',
        stale: sourceState.detailStatus === 'offline', owner: ownerRef ? { principal: presentSharePrincipal({ ref: ownerRef,
            viewerAccountId: scope.accountId, profile: ownerRef.accountId === scope.accountId ? viewerProfile : null }) } : null,
        grants, directory: { query: operationIdentity.current === identity ? query : '', sections: directory.sections },
    };
    const actions: ShareSheetActions = {
        setQuery, retryDirectory: directory.retry, loadMore: directory.loadMore,
        addPrincipal: (principal) => { void mutate(principal, true); },
        retryMutation: (principal) => { const intent = lastIntent.current.get(sessionAccessSubjectKey(principal)); if (intent) void mutate(intent.principal, intent.add); },
        setAccessLevel: () => {},
        requestRemove: (principal) => setConfirming((previous) => new Set([...previous, sessionAccessSubjectKey(principal)])),
        confirmRemove: (principal) => { void mutate(principal, false); },
        cancelRemove: (principal) => setConfirming((previous) => { const next = new Set(previous); next.delete(sessionAccessSubjectKey(principal)); return next; }),
        explain: setNotice,
    };
    return { model, actions, notice: operationIdentity.current === identity ? notice : undefined };
}
