import { automationConsentReferenceSelect, readAutomationDefinitionConsentFor } from './automationActionTriggerConfiguration';
import { ACCOUNT_DISPLAY_PROFILE_SELECT, resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import { parseAutomationStoredWorkflowDefinitionRecipeV2, AutomationStoredWorkflowDefinitionV2ReadSchema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { summarizeWorkflowTriggerRowsV1, type WorkflowTriggerSummaryV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { resolveWorkflowRunAdmissionRecipientAccountIdsInTx, resolveWorkflowRunVisibilityScopesInTx } from '@/app/workflows/workflowRunAccess';
import { afterTx, inTx, inReadSnapshot, type Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { markAccountsChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { automationDefinitionListItemSelect } from './automationPersistenceSelect';
import { toAutomationDefinitionListItemApiDto } from './automationApiProjection';
import { loadAutomationEventStatusProjections } from './automationEventStatusProjection';
import { loadAutomationSessionLifecycleStatusProjections } from './automationSessionLifecycleStatusProjection';
import type { AutomationListItem } from './automationTypes';
import { readArtifactHeadersForCallerInTx, resolveArtifactAudienceInTx,
    type ArtifactHeaderForCaller } from '@/app/artifacts/artifactAccessService';
import { automationActionIndexSelect, readAutomationActionWorkflowRevisionsInTx, projectAutomationActionIndexRows,
    type AutomationActionIndexDefinition } from './automationActionIndex';
import { emitAutomationUpsert } from './automationChangePublisher';
import type { ActionAutomationIndexSelectionV1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import type { Prisma } from '@prisma/client';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

export type WorkflowSummaryArtifactAccess = Pick<ArtifactHeaderForCaller, 'ownerAccountId' | 'access'>;

/** Preserve the Artifact owner's admitted sharing facts for selected rows, without another access read. */
export async function readWorkflowSummaryArtifactAccessInTx(tx: Tx, input: Readonly<{
    accountId: string; workflowDefinitionIds: readonly string[];
}>): Promise<ReadonlyMap<string, WorkflowSummaryArtifactAccess>> {
    if (input.workflowDefinitionIds.length === 0) return new Map();
    const headers = await readArtifactHeadersForCallerInTx(tx, {
        actorAccountId: input.accountId, artifactIds: input.workflowDefinitionIds,
    });
    const access = new Map<string, WorkflowSummaryArtifactAccess>();
    for (const item of headers) {
        if (item.read.ok) access.set(item.artifactId, {
            ownerAccountId: item.read.artifact.ownerAccountId, access: item.read.artifact.access,
        });
    }
    return access;
}

/** Candidate-scoped Artifact admission includes direct-person grants without a Team selection. */
export async function readVisibleWorkflowSummaryIdsInTx(tx: Tx, input: Readonly<{
    accountId: string; workflowDefinitionIds: readonly string[];
}>): Promise<ReadonlySet<string>> {
    return new Set((await readWorkflowSummaryArtifactAccessInTx(tx, input)).keys());
}

function readSelectedTeam(row: Readonly<{ templateCiphertext: string; account: { encryptionMode: unknown } }>): string | null {
    const parsed = parseAutomationStoredWorkflowDefinitionRecipeV2(row.templateCiphertext);
    if (parsed.kind !== 'available') return null;
    const recipe = parsed.recipe;
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    if (mode.status !== 'ready' || (mode.mode === 'plain' ? recipe.workflow.t !== 'plain' : recipe.workflow.t !== 'encrypted')) return null;
    // Retained plain recipes carry this fact in the explicit plain arm. Encrypted
    // predecessors without public audience metadata remain private until re-saved.
    return (recipe.workflow.t === 'plain'
        ? AutomationStoredWorkflowDefinitionV2ReadSchema.parse(recipe.workflow.v).visibleTeamId
        : recipe.visibleTeamId) ?? null;
}

export type SharedWorkflowSummaryDefinition = Readonly<{
    accountId: string; workflowDefinitionId: string | null; scopeSessionId: string | null;
    templateCiphertext: string; account: { encryptionMode: unknown };
}>;

/** Publication admission and invalidation consume the same selected audience. */
export async function readSharedWorkflowTriggerSummaryRecipientsInTx(tx: Tx, row: SharedWorkflowSummaryDefinition): Promise<string[]> {
    if (row.scopeSessionId !== null || row.workflowDefinitionId === null) return [];
    const visibleTeamId = readSelectedTeam(row);
    if (visibleTeamId === null) return [];
    return resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx, {
        accountId: row.accountId, sourceArtifactId: row.workflowDefinitionId, visibleTeamId,
    });
}

/** Reuse Artifact invalidation so every mounted library consumer refreshes without private Automation events. */
export async function markSharedWorkflowTriggerSummaryChangedInTx(tx: Tx, automationId: string): Promise<void> {
    const row = await tx.automation.findUnique({ where: { id: automationId }, select: {
        accountId: true, workflowDefinitionId: true, scopeSessionId: true, templateCiphertext: true,
        account: { select: { encryptionMode: true } },
    } });
    if (!row || row.workflowDefinitionId === null) return;
    const recipients = await readSharedWorkflowTriggerSummaryRecipientsInTx(tx, row);
    await markAccountsChanged(tx, { accountIds: recipients.filter(id => id !== row.accountId),
        kind: 'artifact', entityId: row.workflowDefinitionId });
}

/** Team schedule facts share the Run audience owner; private trigger details stay Account-only. */
export async function readSharedWorkflowTriggerSummaries(input: Readonly<{
    accountId: string; workflowDefinitionIds: readonly string[];
}>): Promise<WorkflowTriggerSummaryV1[]> {
    if (input.workflowDefinitionIds.length === 0) return [];
    const rows = await inTx(async tx => {
        const scopes = await resolveWorkflowRunVisibilityScopesInTx(tx, {
            actorAccountId: input.accountId, sourceArtifactIds: input.workflowDefinitionIds,
        });
        if (scopes.length === 0) return [];
        const teamsBySource = new Map(scopes.map(scope => [scope.sourceArtifactId, scope.visibleTeamIds]));
        const candidates = await tx.automation.findMany({ where: { accountId: { not: input.accountId }, deletedAt: null,
            scopeSessionId: null, workflowDefinitionId: { in: [...teamsBySource.keys()] } },
            select: { ...automationDefinitionListItemSelect, templateCiphertext: true, account: { select: { encryptionMode: true, ...ACCOUNT_DISPLAY_PROFILE_SELECT } } } });
        // Match the canonical definition readers: stored trigger rows use the
        // current Automation domain, while Prisma retains legacy enum members.
        return candidates.filter(row => {
            const visibleTeamId = readSelectedTeam(row);
            return visibleTeamId !== null && row.workflowDefinitionId !== null
                && teamsBySource.get(row.workflowDefinitionId)?.includes(visibleTeamId) === true;
        }).map(row => ({ definition: row as AutomationListItem,
            setUpBy: { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) } }));
    });
    const [events, lifecycle] = await Promise.all([
        loadAutomationEventStatusProjections({ automations: rows.map(row => row.definition) }),
        loadAutomationSessionLifecycleStatusProjections({ automations: rows.map(row => row.definition) }),
    ]);
    return [...summarizeWorkflowTriggerRowsV1(rows.map(({ definition, setUpBy }) => ({
        ...toAutomationDefinitionListItemApiDto(definition, null, events, lifecycle.get(definition.id)), setUpBy,
    }))).values()];
}

export async function readAutomationActionIndex(input: Readonly<{
    accountId: string; selection?: ActionAutomationIndexSelectionV1;
}>) {
    const selectedScopes = input.selection ? [
        ...[...new Set(input.selection.automationIds)].map(id => ({ id })),
        ...[...new Set(input.selection.workflowDefinitionIds)].map(workflowDefinitionId => ({ workflowDefinitionId })),
    ] : undefined;
    if (selectedScopes?.length === 0) return { v: 1 as const, rows: [] };
    return inReadSnapshot(async tx => {
        const eligible = { enabled: true, deletedAt: null,
            OR: [{ accountId: input.accountId }, { scopeSessionId: null, workflowDefinitionId: { not: null },
                triggers: { some: { kind: 'action', enabled: true, deletedAt: null, reachesOthers: true,
                    subjectKey: { not: null }, subjectKind: { not: 'plugin' } } } }],
        } satisfies Prisma.AutomationWhereInput;
        // Enter through the Action index on every provider; correlated Automation
        // predicates otherwise make SQLite scan unrelated schedule definitions.
        // Seven predicates plus SQLite's LIMIT/OFFSET bindings leave the rest for selected ids.
        const scopes = selectedScopes ? portableQueryChunks({ values: selectedScopes, bindingsPerValue: 1, fixedBindings: 9 })
            : [undefined];
        const candidateIds = new Set<string>();
        for (const scope of scopes) {
            const automationIds = scope?.flatMap(item => 'id' in item ? [item.id] : []) ?? [];
            const workflowDefinitionIds = scope?.flatMap(item => 'workflowDefinitionId' in item ? [item.workflowDefinitionId] : []) ?? [];
            const automationWhere = scope ? { AND: [eligible, { OR: [
                    ...(automationIds.length ? [{ id: { in: automationIds } }] : []),
                    ...(workflowDefinitionIds.length ? [{ workflowDefinitionId: { in: workflowDefinitionIds } }] : []),
                ] }] } : eligible;
            const candidateWhere = { kind: 'action', enabled: true, deletedAt: null,
                automation: { is: automationWhere } } satisfies Prisma.AutomationTriggerWhereInput;
            const rows = await tx.automationTrigger.findMany({ where: candidateWhere,
                select: { automationId: true }, distinct: ['automationId'] });
            for (const row of rows) candidateIds.add(row.automationId);
        }
        const candidates: AutomationActionIndexDefinition[] = [];
        for (const ids of portableQueryChunks({ values: [...candidateIds], bindingsPerValue: 1, fixedBindings: 3 })) {
            candidates.push(...await tx.automation.findMany({ where: { id: { in: [...ids] } }, select: automationActionIndexSelect }));
        }
        const sharedIds = [...new Set(candidates.flatMap(row => row.accountId !== input.accountId
            && row.workflowDefinitionId !== null ? [row.workflowDefinitionId] : []))];
        const visible = await readVisibleWorkflowSummaryIdsInTx(tx, { accountId: input.accountId, workflowDefinitionIds: sharedIds });
        const admitted = candidates.filter(row => row.accountId === input.accountId
            || (row.workflowDefinitionId !== null && visible.has(row.workflowDefinitionId)));
        const revisions = await readAutomationActionWorkflowRevisionsInTx(tx, admitted);
        return { v: 1 as const, rows: admitted.flatMap(row => projectAutomationActionIndexRows(row, revisions,
            row.accountId !== input.accountId)) };
    });
}

export type AutomationActorConsentReference = Readonly<{
    automationId: string;
    triggerId: string;
    consentFor: NonNullable<ReturnType<typeof readAutomationDefinitionConsentFor>>;
}>;

/** Selected history retains every actor reference; activation and currentness have separate owners. */
export async function readAutomationActorConsentReferencesInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sourceTriggers: readonly Readonly<{ automationId: string; triggerId: string }>[];
}>): Promise<readonly AutomationActorConsentReference[]> {
    const references = new Map<string, AutomationActorConsentReference>();
    for (const sourceTriggers of portableQueryChunks({ values: input.sourceTriggers,
        bindingsPerValue: 2, fixedBindings: 2 })) {
        const rows = await tx.automationTrigger.findMany({ where: {
            kind: 'action', automation: { is: { accountId: input.accountId } },
            OR: sourceTriggers.map(source => ({ consentForAutomationId: source.automationId,
                consentForTriggerId: source.triggerId })),
        }, select: { id: true, automationId: true, ...automationConsentReferenceSelect } });
        for (const row of rows) {
            const consentFor = readAutomationDefinitionConsentFor([row]);
            if (consentFor) references.set(row.id, { automationId: row.automationId, triggerId: row.id, consentFor });
        }
    }
    return [...references.values()];
}

export type AutomationMutationPublication = Readonly<{
    previous: AutomationActionIndexDefinition | null;
    current: AutomationActionIndexDefinition | null;
}>;

/** Routing changes carry complete replacements; ordinary editor changes retain their upsert. */
export async function publishAutomationMutationInTx(tx: Tx, input: AutomationMutationPublication & Readonly<{
    ownerCursor: AccountChangePublication;
}>): Promise<void> {
    const definition = input.current ?? input.previous;
    if (!definition) return;
    const revisions = await readAutomationActionWorkflowRevisionsInTx(tx,
        [input.previous, input.current].filter((row): row is AutomationActionIndexDefinition => row !== null));
    const oldOwn = input.previous ? projectAutomationActionIndexRows(input.previous, revisions) : [];
    const newOwn = input.current ? projectAutomationActionIndexRows(input.current, revisions) : [];
    const currentDefinition = input.current;
    if (currentDefinition && currentDefinition.deletedAt == null) {
        afterTx(tx, () => emitAutomationUpsert({ accountId: definition.accountId, automation: currentDefinition,
            cursor: input.ownerCursor.resolveCursor(),
            ...(JSON.stringify(oldOwn) !== JSON.stringify(newOwn)
                ? { actionIndex: { automationId: definition.id, rows: newOwn } } : {}),
        }));
    }
    const oldShared = input.previous ? projectAutomationActionIndexRows(input.previous, revisions, true) : [];
    const newShared = input.current ? projectAutomationActionIndexRows(input.current, revisions, true) : [];
    if (JSON.stringify(oldShared) === JSON.stringify(newShared)) return;
    const oldWorkflowId = oldShared.length ? input.previous?.workflowDefinitionId : null;
    const newWorkflowId = newShared.length ? input.current?.workflowDefinitionId : null;
    const oldAudience = oldWorkflowId ? await resolveArtifactAudienceInTx(tx, oldWorkflowId) : [];
    const newAudience = newWorkflowId === oldWorkflowId ? oldAudience
        : newWorkflowId ? await resolveArtifactAudienceInTx(tx, newWorkflowId) : [];
    const previous = new Set(oldAudience);
    const current = new Set(newAudience);
    const recipients = [...new Set([...oldAudience, ...newAudience])].filter(id => id !== definition.accountId);
    const changes = recipients.flatMap(accountId => {
        const before = previous.has(accountId) ? oldShared : [];
        const rows = current.has(accountId) ? newShared : [];
        return JSON.stringify(before) === JSON.stringify(rows) ? [] : [{ accountId, rows }];
    });
    const cursors = await markAccountsChanged(tx, { accountIds: changes.map(change => change.accountId),
        kind: 'artifact', entityId: newWorkflowId ?? oldWorkflowId! });
    for (const change of changes) {
        const cursor = cursors.find(cursor => cursor.accountId === change.accountId)!;
        afterTx(tx, () => emitAutomationUpsert({ accountId: change.accountId, automation: definition,
            cursor: cursor.resolveCursor(), actionIndex: { automationId: definition.id, rows: change.rows } }));
    }
}
