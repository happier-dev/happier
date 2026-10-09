import * as React from 'react';
import { ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessGrantsListResponseV1Schema, type ArtifactAccessGrantRowV1, type ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { getWidgetSharedInputIssuesV1, readWidgetConnectedAccountPurposeV1, readWidgetSurfaceArtifactV1, WidgetInstanceActionOutputSchemasV1,
    type WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import type { DocumentPrivateChoice, DocumentShareKind } from './documentShareAdapter';
import type {
    ShareAccessLevel,
    ShareGrantRowModel,
    ShareOperationModel,
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
type PrivateChoice = DocumentPrivateChoice & Readonly<{ ref: WidgetInstanceRefV1;
    inputPath?: string; binding?: unknown; purpose?: string }>;
type DashboardReview = Readonly<{ phase: 'initial' | 'ready' | 'error'; choices: readonly PrivateChoice[]; issue?: ShareUiError }>;
const NO_PRIVATE_CHOICES: readonly PrivateChoice[] = [];

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

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

/**
 * The documents adapter's controller: one Artifact's grants, read and written only through the
 * `artifact.access.grants.*` Actions. The Action host validates the kind and ownership; every
 * acknowledged response replaces the roster, so the sheet never shows a guess.
 */
export function useDocumentShareController(input: Readonly<{ artifactId: string; kind?: DocumentShareKind; scope: ServerAccountScope }>): Readonly<{
    model: ShareSheetModel;
    actions: ShareSheetActions;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    loading: boolean;
    retryContent(): void;
    grants: readonly ArtifactAccessGrantRowV1[];
    privateChoices: readonly DocumentPrivateChoice[];
}> {
    const { artifactId, scope } = input;
    const viewerProfile = useShareViewerProfile(scope);
    const dashboard = input.kind === 'widget-area-layout.v1';
    const identity = `${scope.serverId}:${scope.accountId}:${artifactId}`;
    const [execute] = React.useState(() => createFrontDoorActionExecute());
    const [state, setState] = React.useState<State>({ phase: 'initial', response: null, operations: {}, confirming: new Set() });
    const [query, setQuery] = React.useState('');
    const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
    const [revision, setRevision] = React.useState(0);
    const [review, setReview] = React.useState<DashboardReview>({ phase: dashboard ? 'initial' : 'ready', choices: NO_PRIVATE_CHOICES });
    const [repairs, setRepairs] = React.useState<Readonly<Record<string, ShareOperationModel>>>({});
    const lastMutation = React.useRef(new Map<string, Mutation>());
    const current = React.useRef<string | null>(identity);
    current.current = identity;
    React.useEffect(() => {
        current.current = identity;
        return () => { if (current.current === identity) current.current = null; };
    }, [identity]);

    const readDashboard = React.useCallback(async (): Promise<DashboardReview> => {
        const result = await execute('artifact.get', { artifactId }, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null);
        const opened = result?.ok ? ArtifactActionOutputSchemasV1['artifact.get'].safeParse(result.result) : null;
        const document = opened?.success ? opened.data.artifact : null;
        const layout = document && document.artifactId === artifactId ? readWidgetSurfaceArtifactV1(document) : null;
        if (!layout || !document || typeof document.body !== 'string' || layout.surface.serverId !== scope.serverId) {
            return { phase: 'error', choices: NO_PRIVATE_CHOICES,
                issue: presentDocumentShareFailure(result && !result.ok ? readFailureCode(result) : 'invalid_widget_area_record') };
        }
        // Scan original stored JSON: the tolerant layout projection deliberately drops additive
        // fields, but those fields must never hide a private selection from review.
        const stored = record(JSON.parse(document.body));
        const entries = Array.isArray(stored?.instances) ? stored.instances : [];
        const registry = getConnectedServiceRegistrySnapshot();
        const groups = await Promise.all(layout.instances.map(async ({ instance }, at): Promise<PrivateChoice[]> => {
            const original = record(record(entries[at])?.instance);
            const issues = getWidgetSharedInputIssuesV1(original);
            if (issues.length === 0) return [];
            const ref = { surface: { ...layout.surface, artifactId }, instanceId: instance.id };
            const descriptor = issues.some(issue => issue.inputPath)
                ? await import('@/sync/ops/actions/widgetInputActionDeps').then(owner => owner.readWidgetShareInputDescriptorV1({ ref, instance, scope })).catch(() => null)
                : null;
            const widget = instance.displayName ?? descriptor?.title
                ?? (instance.definition.kind === 'inline' ? instance.definition.definition.name : instance.id);
            return issues.map(issue => {
                const declared = issue.inputPath && descriptor ? readWidgetConnectedAccountPurposeV1({
                    descriptor, resources: descriptor.resourceDeclarations ?? [], path: issue.inputPath,
                }) : null;
                const selectedService = issue.service;
                const purpose = declared && selectedService && declared.serviceRefs.some(service =>
                    service.pluginId === selectedService.pluginId && service.localId === selectedService.localId)
                    ? declared.purpose.purpose : undefined;
                return { id: JSON.stringify([instance.id, issue.path]), widget, ref,
                    ...(issue.inputPath ? { inputPath: issue.inputPath, binding: record(original?.bindings)?.[issue.inputPath] } : {}),
                    ...(purpose ? { purpose } : {}),
                    ...(issue.service ? { service: resolveQualifiedConnectedServiceRegistryDisplayName(registry, issue.service, t) } : {}) };
            });
        }));
        return { phase: 'ready', choices: groups.flat() };
    }, [artifactId, execute, scope.serverId, scope.accountId]);

    const loadReview = React.useCallback(async () => {
        if (!dashboard) {
            setReview({ phase: 'ready', choices: NO_PRIVATE_CHOICES });
            return;
        }
        const next = await readDashboard();
        if (current.current !== identity) return;
        setReview(previous => next.phase === 'error' ? { ...next, choices: previous.choices } : next);
    }, [dashboard, identity, readDashboard]);

    const load = React.useCallback(async () => {
        const result = await execute('artifact.access.grants.list', { artifactId }, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null);
        if (current.current !== identity) return;
        const parsed = result?.ok ? ArtifactAccessGrantsListResponseV1Schema.safeParse(result.result) : null;
        setState((previous) => parsed?.success
            ? { ...previous, phase: 'ready', response: parsed.data, issue: undefined }
            : { ...previous, phase: 'error', issue: presentDocumentShareFailure(result ? readFailureCode(result) : 'artifact_access_failed') });
    }, [artifactId, execute, identity, scope.serverId, scope.accountId]);
    React.useEffect(() => { void load(); void loadReview(); }, [load, loadReview]);

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
        if (current.current !== identity) return;
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
    }, [artifactId, execute, identity, scope.serverId, scope.accountId]);

    const response = state.response;
    const isOwner = response?.access === 'owner';
    const editable = isOwner || response?.access === 'admin';
    const grants = response?.grants ?? NO_GRANTS;
    const repairChoice = React.useCallback(async (choice: PrivateChoice, repair: 'remove' | 'viewer') => {
        if (!editable || !choice.inputPath || current.current !== identity) return;
        setRepairs(previous => ({ ...previous, [choice.id]: { kind: 'saving' } }));
        const fresh = await readDashboard();
        if (current.current !== identity) return;
        const selected = fresh.choices.find(candidate => candidate.id === choice.id);
        const unchanged = fresh.phase === 'ready' && selected && sameStrictJsonValue(selected.binding, choice.binding)
            && (repair === 'remove' || choice.purpose !== undefined && selected.purpose === choice.purpose);
        const actionId = repair === 'remove' ? 'widgets.item.inputs.reset' : 'widgets.item.inputs.set';
        const payload = selected && (repair === 'remove' ? { ref: selected.ref, paths: [choice.inputPath] }
            : { ref: selected.ref, bindings: { [choice.inputPath]: { kind: 'viewer', purpose: selected.purpose } }, paths: [choice.inputPath] });
        const result = unchanged ? await execute(actionId, payload, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null) : null;
        if (current.current !== identity) return;
        const acknowledged = result?.ok ? WidgetInstanceActionOutputSchemasV1[actionId].safeParse(result.result) : null;
        if (acknowledged?.success) {
            await loadReview();
            if (current.current !== identity) return;
            setRepairs(previous => { const { [choice.id]: _settled, ...remaining } = previous; return remaining; });
        } else {
            setReview(previous => fresh.phase === 'ready' ? fresh : { ...fresh, choices: previous.choices });
            setRepairs(previous => ({ ...previous, [choice.id]: { kind: 'error', error:
                presentDocumentShareFailure(result ? readFailureCode(result) : unchanged ? 'widget_repair_failed' : 'widget_instance_changed') } }));
        }
    }, [editable, execute, identity, loadReview, readDashboard, scope.serverId, scope.accountId]);
    const privateChoices = React.useMemo<readonly DocumentPrivateChoice[]>(() => review.choices.map(choice => {
        const operation = repairs[choice.id];
        return { id: choice.id, widget: choice.widget, ...(choice.service ? { service: choice.service } : {}),
            ...(choice.inputPath && review.phase === 'ready' ? { removeChoice: () => { void repairChoice(choice, 'remove'); },
                ...(choice.purpose ? { letViewersPick: () => { void repairChoice(choice, 'viewer'); } } : {}) } : {}),
            ...(operation?.kind === 'saving' ? { loading: true } : {}),
            ...(operation?.kind === 'error' ? { issue: operation.error } : {}) };
    }), [repairChoice, repairs, review]);
    const rows = React.useMemo<readonly ShareGrantRowModel[]>(() => grants.map((row) => {
        const principal = presentSharePrincipal({ ref: row.principal, name: row.display.name,
            username: row.display.username, viewerAccountId: scope.accountId,
            profile: row.principal.kind === 'account' && row.principal.accountId === scope.accountId ? viewerProfile : null });
        const operation = state.operations[principal.key] ?? IDLE;
        return {
            grant: row.principal,
            principal,
            level: { kind: 'editable', value: row.accessLevel, options: isOwner ? ['view', 'edit', 'admin'] : ['view', 'edit'] },
            removal: state.confirming.has(principal.key) ? { kind: 'confirming', consequences: [] } : { kind: 'allowed' },
            operation,
        };
    }), [grants, isOwner, state.operations, state.confirming, scope.accountId, viewerProfile]);
    const owner = response && response.ownerAccountId === scope.accountId ? { principal: presentSharePrincipal({
        ref: { kind: 'account', accountId: response.ownerAccountId },
        profile: viewerProfile, viewerAccountId: scope.accountId,
    }) } : null;

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
        ...(state.issue || review.issue ? { issue: state.issue ?? review.issue } : {}),
        ...(notice ? { notice } : {}),
        loading: state.phase === 'initial' || review.phase === 'initial',
        retryContent: () => { void load(); void loadReview(); },
        grants,
        privateChoices,
    };
}
