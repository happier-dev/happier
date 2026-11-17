import * as React from 'react';
import { ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessGrantsListResponseV1Schema, type ArtifactAccessGrantRowV1, type ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { flattenWidgetLayoutWidgetsV1, getWidgetSharedInputIssuesV1, readWidgetConnectedAccountPurposeV1, readWidgetSurfaceArtifactV1, WidgetInstanceActionOutputSchemasV1,
    type WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { useResourceGrantGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
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
type GrantMutationResult = Readonly<{ ok: true }> | Readonly<{ ok: false; error: ShareUiError }>;
export type DocumentAudienceShareResult =
    | Readonly<{ ok: true; shared: readonly PrincipalRefV1[] }>
    | Readonly<{ ok: false; shared: readonly PrincipalRefV1[]; error: ShareUiError }>;

type State = Readonly<{
    phase: 'initial' | 'ready' | 'error';
    response: ArtifactAccessGrantsListResponseV1 | null;
    reviewedIdentity?: string;
    issue?: ShareUiError;
    operations: Readonly<Record<string, ShareOperationModel>>;
    confirmingRemoval: string | null;
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
function presentDocumentShareFailure(code: string, failure?: unknown): ShareUiError {
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
            return { code, message: resolveActionExecutionErrorMessage(failure ?? { code }, t('shareSheet.documents.errors.failed'), { safeToRetry: true }), retryable: true };
    }
}

/**
 * The documents adapter's controller: one Artifact's grants, read and written only through the
 * `artifact.access.grants.*` Actions. The Action host validates the kind and ownership; every
 * acknowledged response replaces the roster, so the sheet never shows a guess.
 */
/**
 * What removing one grant takes away, from the roster this sheet already holds (plan 12 §2, lab
 * p-overview SHARED). The roster has no per-member preview, so a removal that another grant may still
 * cover says that access stays instead of claiming everyone loses it.
 */
function removalConsequences(removed: PrincipalRefV1, name: string, grants: readonly ArtifactAccessGrantRowV1[], dashboard: boolean): readonly string[] {
    const others = grants.filter(row => sessionAccessSubjectKey(row.principal) !== sessionAccessSubjectKey(removed));
    const coveredElsewhere = removed.kind === 'account' ? others.some(row => row.principal.kind !== 'account') : others.length > 0;
    return [
        removed.kind === 'account' ? t('shareSheet.removeLosesPerson', { name }) : t('shareSheet.removeLosesMembers', { name }),
        ...(coveredElsewhere ? [t('shareSheet.removeKeepsOtherAccess')] : []),
        ...(dashboard ? [t('shareSheet.removeKeepsTheirWork')] : []),
    ];
}

export function useDocumentShareController(input: Readonly<{ artifactId: string; kind?: DocumentShareKind; scope: ServerAccountScope;
    requestedAudience?: readonly PrincipalRefV1[];
}> | null): Readonly<{
    model: ShareSheetModel;
    actions: ShareSheetActions;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    loading: boolean;
    retryContent(): void;
    grants: readonly ArtifactAccessGrantRowV1[];
    /** The admitted roster's owner and grant principals, for sharing a linked document. */
    audience: readonly PrincipalRefV1[] | undefined;
    /** Undefined until the grant owner has completed the requested review. */
    missingAudience: readonly PrincipalRefV1[] | undefined;
    /** Apply only the owner's reviewed missing audience, returning acknowledged partial progress. */
    shareMissingAudience(): Promise<DocumentAudienceShareResult>;
    privateChoices: readonly DocumentPrivateChoice[];
}> {
    const artifactId = input?.artifactId ?? null;
    const scope = input?.scope ?? null;
    const viewerProfile = useShareViewerProfile(scope);
    const dashboard = input?.kind === 'widget-area-layout.v1';
    const audienceRef = React.useRef(input?.requestedAudience);
    if (!sameStrictJsonValue(audienceRef.current ?? null, input?.requestedAudience ?? null)) audienceRef.current = input?.requestedAudience;
    const requestedAudience = audienceRef.current;
    const identity = scope ? JSON.stringify([scope.serverId, scope.accountId, artifactId, requestedAudience]) : null;
    const [execute] = React.useState(() => createFrontDoorActionExecute());
    const [state, setState] = React.useState<State>({ phase: 'initial', response: null, operations: {}, confirmingRemoval: null });
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
        if (!scope || !artifactId) return { phase: 'ready', choices: NO_PRIVATE_CHOICES };
        // Widget layouts are internal documents: the widget owner's native Artifact transport
        // admits their read, while generic artifact.get deliberately refuses internal kinds.
        const document = await import('@/sync/ops/actions/actionAccountContext').then(async owner => {
            const account = await owner.captureLazyActionAccountContext(scope.serverId);
            try {
                account.assertCurrent();
                if (account.accountId !== scope.accountId) return null;
                const row = await account.homeHubArtifactTransport.read(artifactId);
                account.assertCurrent();
                return row;
            } finally { account.dispose(); }
        }).catch(() => null);
        const layout = document && document.artifactId === artifactId ? readWidgetSurfaceArtifactV1(document) : null;
        if (!layout || !document || typeof document.body !== 'string' || layout.surface.serverId !== scope.serverId) {
            return { phase: 'error', choices: NO_PRIVATE_CHOICES,
                issue: presentDocumentShareFailure('invalid_widget_area_record') };
        }
        // Scan original stored JSON: the tolerant layout projection deliberately drops additive
        // fields, but those fields must never hide a private selection from review.
        const stored = record(JSON.parse(document.body));
        const entries: unknown[] = Array.isArray(stored?.items) ? stored.items : [];
        const originalWidgets = entries.flatMap(entry => {
            const item = record(entry);
            return item?.kind === 'group' && Array.isArray(item.children) ? item.children : [entry];
        });
        const registry = getConnectedServiceRegistrySnapshot();
        const groupChoices: PrivateChoice[] = layout.items.flatMap(item => {
            if (item.kind !== 'group') return [];
            const original = record(entries.find(entry => record(entry)?.kind === 'group' && record(entry)?.id === item.id));
            // Children are reviewed as widgets below; retain every other raw group field.
            const { children: _children, ...group } = original ?? {};
            return getWidgetSharedInputIssuesV1(group).map(issue => ({
                id: JSON.stringify([item.id, issue.path]), widget: item.title ?? item.id,
                ref: { surface: { ...layout.surface, artifactId }, instanceId: item.id },
                ...(issue.service ? { service: resolveQualifiedConnectedServiceRegistryDisplayName(registry, issue.service, t) } : {}),
            }));
        });
        const groups = await Promise.all(flattenWidgetLayoutWidgetsV1(layout.items).map(async ({ instance }): Promise<PrivateChoice[]> => {
            const original = record(record(originalWidgets.find(entry => record(record(entry)?.instance)?.id === instance.id))?.instance);
            const issues = getWidgetSharedInputIssuesV1(original);
            if (issues.length === 0) return [];
            const ref = { surface: { ...layout.surface, artifactId }, instanceId: instance.id };
            const descriptor = issues.some(issue => issue.inputPath)
                ? await import('@/sync/ops/actions/widgetInputActionDeps').then(owner => owner.readWidgetShareInputDescriptorV1({ ref, instance, scope })).catch(() => null)
                : null;
            const widget = resolveWidgetInstanceTitle(instance, descriptor);
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
        return { phase: 'ready', choices: [...groupChoices, ...groups.flat()] };
    }, [artifactId, scope?.serverId, scope?.accountId]);

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
        if (!scope || !artifactId || identity === null) return;
        const result = await execute('artifact.access.grants.list', { artifactId,
            ...(requestedAudience === undefined ? {} : { requestedAudience: [...requestedAudience] }) }, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null);
        if (current.current !== identity) return;
        const parsed = result?.ok ? ArtifactAccessGrantsListResponseV1Schema.safeParse(result.result) : null;
        const available = parsed?.success && (requestedAudience === undefined || parsed.data.missingAudience !== undefined);
        setState((previous) => available && parsed?.success
            ? { ...previous, phase: 'ready', response: parsed.data, reviewedIdentity: identity, issue: undefined }
            : { ...previous, phase: 'error', issue: presentDocumentShareFailure(result ? readFailureCode(result) : 'artifact_access_failed', result) });
    }, [artifactId, execute, identity, scope?.serverId, scope?.accountId, requestedAudience]);
    React.useEffect(() => { void load(); void loadReview(); }, [load, loadReview]);

    const mutate = React.useCallback(async (mutation: Mutation, refreshReviewedAudience = true): Promise<GrantMutationResult> => {
        if (!scope || !artifactId) return { ok: false, error: presentDocumentShareFailure('action_account_scope_changed') };
        const key = sessionAccessSubjectKey(mutation.principal);
        lastMutation.current.set(key, mutation);
        setState((previous) => ({ ...previous, confirmingRemoval: null, operations: { ...previous.operations,
            [key]: { kind: mutation.actionId === 'artifact.access.grants.remove' ? 'removing' : 'saving' } } }));
        const payload = mutation.actionId === 'artifact.access.grants.set'
            ? { artifactId, principal: mutation.principal, accessLevel: mutation.accessLevel }
            : { artifactId, principal: mutation.principal };
        const result = await execute(mutation.actionId, payload, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        }).catch(() => null);
        const parsed = result?.ok ? ArtifactAccessGrantMutationResponseV1Schema.safeParse(result.result) : null;
        const issue = parsed?.success ? parsed.data.access === null ? presentDocumentShareFailure('artifact_access_revoked') : null
            : presentDocumentShareFailure(result ? readFailureCode(result) : 'artifact_access_failed', result);
        if (current.current !== identity) return issue ? { ok: false, error: issue } : { ok: true };
        setState((previous) => {
            const { [key]: _settled, ...operations } = previous.operations;
            if (parsed?.success) {
                const { changed: _changed, access, ...response } = parsed.data;
                if (access === null) {
                    lastMutation.current.clear();
                    return { phase: 'ready', response: null, operations: {}, confirmingRemoval: null,
                        issue: presentDocumentShareFailure('artifact_access_revoked') };
                }
                lastMutation.current.delete(key);
                return { ...previous, phase: 'ready', response: { ...response, access }, operations, issue: undefined };
            }
            return { ...previous,
                operations: { ...operations, [key]: { kind: 'error', error: issue! } } };
        });
        if (parsed?.success && requestedAudience !== undefined && refreshReviewedAudience) await load();
        setRevision((value) => value + 1);
        return issue ? { ok: false, error: issue } : { ok: true };
    }, [artifactId, execute, identity, scope?.serverId, scope?.accountId, requestedAudience, load]);

    const response = input === null ? null : state.response;
    const isOwner = response?.access === 'owner';
    const editable = isOwner || response?.access === 'admin';
    const grants = response?.grants ?? NO_GRANTS;
    const audience = React.useMemo<readonly PrincipalRefV1[] | undefined>(() =>
        state.phase === 'ready' && state.reviewedIdentity === identity && response
            ? [{ kind: 'account', accountId: response.ownerAccountId }, ...response.grants.map(row => row.principal)]
            : undefined, [state.phase, state.reviewedIdentity, identity, response]);
    const missingAudience = requestedAudience === undefined || state.phase !== 'ready' || state.reviewedIdentity !== identity
        ? undefined : response?.missingAudience;
    const shareMissingAudience = React.useCallback(async (): Promise<DocumentAudienceShareResult> => {
        if (identity === null || current.current !== identity) return { ok: false, shared: [],
            error: presentDocumentShareFailure('action_account_scope_changed') };
        if (missingAudience === undefined) return { ok: false, shared: [],
            error: state.issue ?? presentDocumentShareFailure('artifact_access_failed') };
        const shared: PrincipalRefV1[] = [];
        for (const principal of missingAudience) {
            const result = await mutate({ actionId: 'artifact.access.grants.set', principal, accessLevel: 'view' }, false);
            if (!result.ok) {
                if (shared.length > 0) await load();
                return { ok: false, shared, error: result.error };
            }
            shared.push(principal);
        }
        if (shared.length > 0) await load();
        return { ok: true, shared };
    }, [identity, missingAudience, state.issue, mutate, load]);
    const groupDisplayNames = useResourceGrantGroupDisplayNames({ scope, grants });
    const repairChoice = React.useCallback(async (choice: PrivateChoice, repair: 'remove' | 'viewer') => {
        if (!scope || !editable || !choice.inputPath || current.current !== identity) return;
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
                presentDocumentShareFailure(result ? readFailureCode(result) : unchanged ? 'widget_repair_failed' : 'widget_instance_changed', result) } }));
        }
    }, [editable, execute, identity, loadReview, readDashboard, scope?.serverId, scope?.accountId]);
    const privateChoices = React.useMemo<readonly DocumentPrivateChoice[]>(() => review.choices.map(choice => {
        const operation = repairs[choice.id];
        return { id: choice.id, widget: choice.widget, ...(choice.service ? { service: choice.service } : {}),
            ...(choice.inputPath && review.phase === 'ready' ? { removeChoice: () => { void repairChoice(choice, 'remove'); },
                ...(choice.purpose ? { letViewersPick: () => { void repairChoice(choice, 'viewer'); } } : {}) } : {}),
            ...(operation?.kind === 'saving' ? { loading: true } : {}),
            ...(operation?.kind === 'error' ? { issue: operation.error } : {}) };
    }), [repairChoice, repairs, review]);
    const rows = React.useMemo<readonly ShareGrantRowModel[]>(() => grants.map((row) => {
        const principal = presentSharePrincipal({ ref: row.principal,
            name: row.principal.kind === 'group' ? groupDisplayNames.get(row.principal.groupId) ?? null : row.display.name,
            username: row.display.username, viewerAccountId: scope?.accountId,
            profile: row.principal.kind === 'account' && row.principal.accountId === scope?.accountId ? viewerProfile : null });
        const operation = state.operations[principal.key] ?? IDLE;
        return {
            grant: row.principal,
            principal,
            level: { kind: 'editable', value: row.accessLevel, options: isOwner ? ['view', 'edit', 'admin'] : ['view', 'edit'] },
            removal: state.confirmingRemoval === principal.key
                ? { kind: 'confirming', consequences: removalConsequences(row.principal, principal.displayName, grants, dashboard) } : { kind: 'allowed' },
            operation,
        };
    }), [grants, groupDisplayNames, isOwner, state.operations, state.confirmingRemoval, scope?.accountId, viewerProfile, dashboard]);
    const owner = response && response.ownerAccountId === scope?.accountId ? { principal: presentSharePrincipal({
        ref: { kind: 'account', accountId: response.ownerAccountId },
        profile: viewerProfile, viewerAccountId: scope?.accountId,
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
        requestRemove: (grant) => {
            const key = sessionAccessSubjectKey(grant);
            if (editable && grants.some(row => sessionAccessSubjectKey(row.principal) === key)) {
                setState(previous => ({ ...previous, confirmingRemoval: key }));
            }
        },
        confirmRemove: (grant) => {
            if (editable && state.confirmingRemoval === sessionAccessSubjectKey(grant)) {
                void mutate({ actionId: 'artifact.access.grants.remove', principal: grant });
            }
        },
        cancelRemove: (grant) => {
            setState(previous => previous.confirmingRemoval === sessionAccessSubjectKey(grant)
                ? { ...previous, confirmingRemoval: null } : previous);
        },
        explain: setNotice,
    }), [directory.loadMore, directory.retry, editable, grants, mutate, state.confirmingRemoval]);

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
        loading: input !== null && (state.phase === 'initial' || review.phase === 'initial'),
        retryContent: () => { void load(); void loadReview(); },
        grants,
        audience,
        missingAudience,
        shareMissingAudience,
        privateChoices,
    };
}
