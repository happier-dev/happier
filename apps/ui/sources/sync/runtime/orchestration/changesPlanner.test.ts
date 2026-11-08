import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
    ChangeEntrySchema,
    ChangeKindSchema,
    buildAccountIdentitiesChangeV1,
    buildConnectedServicesAccountChangeV1,
    PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1,
    TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
} from '@happier-dev/protocol/changes';
import {
    CHANGE_CHECKPOINT_COVERAGE,
    classifyChangeForCheckpoint,
    planSyncActionsFromChanges,
    plannedChangesAffectSessionListQuery,
    plannedChangesAffectProfileCatalog,
    plannedChangesAffectUsageQuery,
    plannedChangesAffectUsageAccounting,
} from './changesPlanner';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import type { HomeAccountChangeEvent } from './homeAccountChange';
import { buildProfilePhysicalKey, PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, PROFILE_TRANSFER_ACCOUNT_KV_KEY } from '@happier-dev/protocol/profiles/profileRecordV1';
import { buildConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import * as changePlanner from './changesPlanner';
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { savedSecretDisclosureActivityEntityIdV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';

it('preserves exact managed rows across mixed pages and keeps access and unknown changes structural', () => {
    const row: ApiChangeEntry = { kind: 'account', entityId: 'managed-one', cursor: 1, changedAt: 0,
        hint: { managedMachinePolicy: true, machineId: 'controller' } };
    const plan = planSyncActionsFromChanges([row, { ...row, cursor: 2 },
        { kind: 'machine', entityId: 'controller', cursor: 3, changedAt: 0 }]);
    expect(plan).toMatchObject({ managedMachineChangedIds: ['managed-one'], invalidate: { settings: false } });
    expect(changePlanner.plannedChangesAffectManagedMachineInventory(plan)).toBe(true);
    for (const change of [
        { kind: 'machineRecipientAccess' as const, entityId: 'controller', cursor: 4, changedAt: 0 },
        { kind: 'account' as const, entityId: 'self', cursor: 4, changedAt: 0 },
        { ...row, hint: { managedMachinePolicy: 'true' } },
    ]) expect(planSyncActionsFromChanges([row, change]).managedMachineChangedIds).toBeUndefined();
});

it('retains accounting for catalog, allowance and managed-policy inputs on mixed pages without suppressing unknown or Session changes', () => {
    const row = (entityId: string, hint?: ApiChangeEntry['hint']): ApiChangeEntry => ({ kind: 'account', entityId, cursor: 12, changedAt: 1, ...(hint ? { hint } : {}) });
    const machine: ApiChangeEntry = { kind: 'machine', entityId: 'fixture-controller', cursor: 11, changedAt: 1 };
    const plan = (changes: ApiChangeEntry[]) => planSyncActionsFromChanges(changes, { isSessionListMember: () => true, afterCursor: 10 });
    const catalogs = ['configurations', 'purposes'] as const;
    const irrelevant = [
        ...catalogs.map(key => row(buildConnectedAccountCatalogPhysicalKeyV1(key), { connectedAccountCatalog: true, key, revision: 5363 })),
        row('fixture-managed-policy', { managedMachinePolicy: true, machineId: machine.entityId }),
        row(PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1),
        row('provider-account-usage-record:paug_v1_abcdefgh'),
        { ...buildConnectedServicesAccountChangeV1(), cursor: 12, changedAt: 1 },
    ];
    for (const change of irrelevant) {
        const planned = plan([machine, change]);
        expect(plannedChangesAffectUsageQuery(planned)).toBe(true);
        expect(plannedChangesAffectUsageAccounting(planned)).toBe(false);
        for (const relevant of [
            row('self'), row('unknown'), row('self', { managedMachinePolicy: true }),
            row('unknown', { managedMachinePolicy: 'true' }),
            row('unknown', { managedMachinePolicy: true, machineId: 1 }),
            row('unknown', { connectedAccountCatalog: true, key: 'configurations', revision: 1 }),
            { kind: 'session' as const, entityId: 'fixture-session', cursor: 13, changedAt: 1 },
        ]) expect(plannedChangesAffectUsageAccounting(plan([change, relevant]))).toBe(true);
    }
});

it('refreshes private Session access evidence for roster changes without replacing Account-owned accounting', () => {
    const share: ApiChangeEntry = { kind: 'share', entityId: 'session-one', cursor: 12, changedAt: 1 };
    const plan = (changes: ApiChangeEntry[]) => planSyncActionsFromChanges(changes, { isSessionListMember: () => true, afterCursor: 10 });
    const roster = plan([share]);
    expect(plannedChangesAffectUsageQuery(roster)).toBe(true);
    expect(plannedChangesAffectUsageAccounting(roster)).toBe(false);
    // A share can accompany a real usage or unknown Account change. Preserve
    // conservative accounting admission for those independent facts.
    for (const change of [
        { kind: 'session' as const, entityId: 'session-two', cursor: 13, changedAt: 1 },
        { kind: 'account' as const, entityId: 'self', cursor: 13, changedAt: 1 },
    ]) expect(plannedChangesAffectUsageAccounting(plan([share, change]))).toBe(true);
});

it.each([
    { kind: 'machineRecipientAccess', entityId: 'machine-one' },
    { kind: 'account', entityId: 'self', hint: { settingsVersion: 8758 } },
    { kind: 'discussion', entityId: 'discussion-one', hint: { v: 1, changes: [], discussions: true } },
    { kind: 'session', entityId: 'session-one', hint: { lastMessageSeq: 14, lastMessageId: 'message-14',
        followReceiverAvailabilityChanged: true, followReceiverAvailabilityChangedAtCursor: 3, pendingExecutionRunIds: [] } },
] satisfies Array<Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>>)(
    'retains accounting for $kind projection wakes while real usage in the same page still refreshes', change => {
        const plan = (changes: ApiChangeEntry[]) => planSyncActionsFromChanges(changes, { afterCursor: 10, isSessionListMember: () => true });
        const projection = { ...change, cursor: 12, changedAt: 1 };
        expect(plannedChangesAffectUsageQuery(plan([projection]))).toBe(true);
        expect(plannedChangesAffectUsageAccounting(plan([projection]))).toBe(false);
        for (const usage of [
            { kind: 'session', entityId: 'session-one', hint: { lastMessageSeq: 15, usageAccountingChanged: true } },
            { kind: 'session', entityId: 'session-one', hint: { usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 11 } },
            { kind: 'account', entityId: 'usage-history' },
        ] satisfies Array<Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>>) {
            expect(plannedChangesAffectUsageAccounting(plan([projection, { ...usage, cursor: 13, changedAt: 2 }]))).toBe(true);
        }
        if (projection.kind === 'session') {
            for (const extra of [{ usageAccountingChanged: true }, { futureUsageFact: true },
                { usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 11 }]) {
                expect(plannedChangesAffectUsageAccounting(plan([{ ...projection, hint: { ...projection.hint, ...extra } }]))).toBe(true);
            }
        }
    },
);

it('keeps retained Session row hints conservative after a generic publication withdraws the accounting proof', () => {
    const plan = (hint: ApiChangeEntry['hint']) => planSyncActionsFromChanges([
        { kind: 'session', entityId: 'session-one', cursor: 12, changedAt: 1, hint },
    ], { afterCursor: 10, isSessionListMember: () => true });
    // retainSessionSourceChangeHint deliberately keeps these row facts while
    // withdrawing usageAccountingChanged on an unknown source publication.
    for (const hint of [
        { archivedAt: 1793587018607 },
        { pendingCount: 0, pendingVersion: 11, pendingBlockedCount: 0 },
        { sharedMetadataVersion: 88 },
        { followReceiverAvailabilityChanged: false },
        { v: 1, lifecycle: 'deleted' },
    ]) {
        const enriched = { ...hint, pendingExecutionRunIds: [] };
        expect(plannedChangesAffectUsageAccounting(plan(enriched))).toBe(true);
        if ('lifecycle' in hint) continue;
        expect(plannedChangesAffectUsageAccounting(plan({ ...enriched,
            usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 9 }))).toBe(false);
        expect(plannedChangesAffectUsageAccounting(plan({ ...enriched,
            usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 11 }))).toBe(true);
    }
});

const TEST_FILE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_FILE_DIRECTORY, '..', '..', '..', '..', '..', '..');
const RELEASED_UI_ACCOUNT_CHANGE_READER = {
    tag: 'ui-web-v0.2.11',
    commit: '98ea8fb76733b1dd785d38c31360179cafa84824',
} as const;

type ReleasedUiAccountChangeReaderResult = Readonly<{
    parsed: boolean;
    settings: boolean;
    profile: boolean;
    unsupportedCount: number;
    checkpointDecisions: readonly string[];
    checkpointMaterializationProofs: readonly string[];
}>;

function hasReleasedUiAccountChangeReader(): boolean {
    return spawnSync('git', ['cat-file', '-e', `${RELEASED_UI_ACCOUNT_CHANGE_READER.commit}^{commit}`], {
        cwd: REPOSITORY_ROOT,
        stdio: 'ignore',
    }).status === 0;
}

function executeReleasedUiAccountChangeReader(entries: readonly unknown[]): ReleasedUiAccountChangeReaderResult {
    const tagResolution = spawnSync(
        'git',
        ['rev-parse', '--verify', '--quiet', `${RELEASED_UI_ACCOUNT_CHANGE_READER.tag}^{}`],
        { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
    );
    if (tagResolution.status === 0) {
        const resolvedCommit = tagResolution.stdout.trim();
        if (resolvedCommit !== RELEASED_UI_ACCOUNT_CHANGE_READER.commit) {
            throw new Error(
                `Released UI reader tag ${RELEASED_UI_ACCOUNT_CHANGE_READER.tag} resolved to ${resolvedCommit}, expected ${RELEASED_UI_ACCOUNT_CHANGE_READER.commit}`,
            );
        }
    }

    const artifactDirectory = mkdtempSync(join(tmpdir(), 'happier-released-account-change-reader-'));
    try {
        writeFileSync(join(artifactDirectory, 'package.json'), JSON.stringify({ type: 'module' }));

        const archive = execFileSync('git', [
            'archive',
            RELEASED_UI_ACCOUNT_CHANGE_READER.commit,
            '--',
            'apps/ui/sources/sync/runtime/orchestration/changesPlanner.ts',
            'packages/protocol/src',
        ], { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 });
        const extracted = spawnSync('tar', ['-x', '-C', artifactDirectory], {
            cwd: REPOSITORY_ROOT,
            input: archive,
            encoding: 'utf8',
        });
        if (extracted.status !== 0) {
            throw new Error(`Unable to extract released UI reader: ${extracted.stderr || extracted.error?.message || 'unknown error'}`);
        }

        const protocolPackageDirectory = join(artifactDirectory, 'packages', 'protocol');
        writeFileSync(join(protocolPackageDirectory, 'package.json'), JSON.stringify({
            name: '@happier-dev/protocol',
            type: 'module',
            exports: {
                // The released planner imports these draft symbols from the
                // package root. Point that root at their exact released owner
                // so this artifact test executes released code without loading
                // unrelated protocol exports or reconstructing their behavior.
                '.': './src/drafts/sessionDrafts.ts',
                './changes': './src/changes.ts',
            },
        }));

        const nodeModulesDirectory = join(artifactDirectory, 'node_modules');
        mkdirSync(join(nodeModulesDirectory, '@happier-dev'), { recursive: true });
        symlinkSync(protocolPackageDirectory, join(nodeModulesDirectory, '@happier-dev', 'protocol'), 'dir');
        for (const [dependency, source] of [
            ['zod', join(REPOSITORY_ROOT, 'packages', 'protocol', 'node_modules', 'zod')],
            ['base64-js', join(REPOSITORY_ROOT, 'node_modules', 'base64-js')],
            ['tweetnacl', join(REPOSITORY_ROOT, 'node_modules', 'tweetnacl')],
            ['tsx', join(REPOSITORY_ROOT, 'node_modules', 'tsx')],
        ] as const) {
            symlinkSync(source, join(nodeModulesDirectory, dependency), 'dir');
        }
        mkdirSync(join(nodeModulesDirectory, '@noble'), { recursive: true });
        symlinkSync(
            join(REPOSITORY_ROOT, 'node_modules', '@noble', 'hashes'),
            join(nodeModulesDirectory, '@noble', 'hashes'),
            'dir',
        );

        const runnerPath = join(artifactDirectory, 'run-released-reader.mts');
        writeFileSync(runnerPath, `
import { ChangeEntrySchema } from '@happier-dev/protocol/changes';
import {
    classifyChangeForCheckpoint,
    planSyncActionsFromChanges,
} from './apps/ui/sources/sync/runtime/orchestration/changesPlanner.ts';

const entries = JSON.parse(process.env.HAPPIER_RELEASED_ACCOUNT_CHANGE_ENTRIES_JSON);
const parsed = entries.map((entry) => ChangeEntrySchema.safeParse(entry));
if (parsed.some((result) => !result.success)) {
    process.stdout.write(JSON.stringify({ parsed: false }));
} else {
    const changes = parsed.map((result) => result.data);
    const plan = planSyncActionsFromChanges(changes);
    const classifications = changes.map((change) => classifyChangeForCheckpoint(change, {
        isSessionMessagesLoaded: () => false,
    }));
    process.stdout.write(JSON.stringify({
        parsed: true,
        settings: plan.invalidate.settings,
        profile: plan.invalidate.profile,
        unsupportedCount: plan.unsupportedChanges.length,
        checkpointDecisions: classifications.map((classification) => classification.decision),
        checkpointMaterializationProofs: classifications.map((classification) => classification.materializationProof),
    }));
}
`);

        const executed = spawnSync(process.execPath, ['--import', 'tsx', runnerPath], {
            cwd: artifactDirectory,
            encoding: 'utf8',
            env: {
                ...process.env,
                HAPPIER_RELEASED_ACCOUNT_CHANGE_ENTRIES_JSON: JSON.stringify(entries),
            },
        });
        if (executed.status !== 0) {
            throw new Error(`Released UI reader execution failed: ${executed.stderr || executed.error?.message || 'unknown error'}`);
        }
        return JSON.parse(executed.stdout) as ReleasedUiAccountChangeReaderResult;
    } finally {
        rmSync(artifactDirectory, { recursive: true, force: true });
    }
}

function buildChange(params: {
    cursor: number;
    kind: ApiChangeEntry['kind'];
    entityId?: ApiChangeEntry['entityId'];
    changedAt?: number;
    hint?: ApiChangeEntry['hint'];
}): ApiChangeEntry {
    return {
        cursor: params.cursor,
        kind: params.kind,
        entityId: params.entityId ?? 'self',
        changedAt: params.changedAt ?? params.cursor,
        hint: params.hint ?? null,
    };
}

it('keeps private Session evidence live while accounting follows the coalesced cursor proof', () => {
    const projection = buildChange({ cursor: 14, kind: 'session', entityId: 'session-a', hint: {
        agentStateVersion: 4, usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 8,
    } });
    const plan = (changes: ApiChangeEntry[], afterCursor = 8) => planSyncActionsFromChanges(changes, {
        isSessionListMember: () => true, afterCursor,
    });
    expect(plannedChangesAffectUsageQuery(plan([projection]))).toBe(true);
    expect(plannedChangesAffectUsageAccounting(plan([projection]))).toBe(false);
    expect(plannedChangesAffectUsageAccounting(plan([projection], 7))).toBe(true);
    expect(plannedChangesAffectUsageAccounting(planSyncActionsFromChanges([projection]))).toBe(true);
    for (const change of [
        buildChange({ cursor: 15, kind: 'session', entityId: 'session-b', hint: { lastMessageSeq: 2, usageAccountingChanged: true } }),
        buildChange({ cursor: 15, kind: 'session', entityId: 'session-b', hint: { v: 1, lifecycle: 'deleted' } }),
        buildChange({ cursor: 15, kind: 'session', entityId: 'session-b', hint: { agentStateVersion: 2 } }),
        buildChange({ cursor: 15, kind: 'account', entityId: 'self' }),
    ]) expect(plannedChangesAffectUsageAccounting(plan([projection, change]))).toBe(true);
});

describe('planSyncActionsFromChanges', () => {
    it('refreshes Coach evidence for its KV key while leaving unrelated KV and accounting alone', () => {
        const plan = (keys: string[]) => planSyncActionsFromChanges([{ kind: 'kv', entityId: 'self', cursor: 1, changedAt: 1,
            hint: { keys } }]);
        const coach = plan([USAGE_COACH_SUPPRESSIONS_KV_KEY]);
        expect(plannedChangesAffectUsageQuery(coach)).toBe(true);
        expect(plannedChangesAffectUsageAccounting(coach)).toBe(false);
        expect(plannedChangesAffectUsageQuery(plan(['todo.index']))).toBe(false);
    });
    it('routes public-profile publication changes to their reader without invalidating unrelated domains', async () => {
        const change = buildChange({ cursor: 1, kind: 'account', entityId: 'public-profile' });
        const planned = planSyncActionsFromChanges([change]);
        const { publicProfile, ...unrelated } = planned.invalidate;
        expect(publicProfile).toBe(true);
        expect(Object.values(unrelated)).not.toContain(true);
        expect(planned.workflowRunIdsToRefresh).toEqual([]);
        expect(plannedChangesAffectSessionListQuery(planned)).toBe(false);
        expect(plannedChangesAffectProfileCatalog(planned)).toBe(false);
        expect(plannedChangesAffectUsageQuery(planned)).toBe(false);
        expect(plannedChangesAffectUsageAccounting(planned)).toBe(false);
        expect(changePlanner.plannedChangesAffectWorkflowTriggers(planned)).toBe(false);
        expect(changePlanner.plannedChangesAffectWorkflowDefinitions(planned)).toBe(false);

        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        for (const source of ['socket', 'catch-up-pending'] as const) {
            const event = publishHomeAccountChangeForRouting('publication-home', ['public-profile'], { source, changeKinds: ['account'] });
            expect(event).toMatchObject({ changeKinds: ['account'], entityIds: ['public-profile'],
                accountSettingsAffects: false, profileCatalogAffects: false, sessionListQueryAffects: false,
                usageQueryAffects: false, workflowTriggersAffect: false, workflowDefinitionsAffect: false });
            expect(changePlanner.homeAccountChangeAffectsPublicProfile(event)).toBe(true);
        }
    });

    it('routes public-profile publication, visible identity and recovery facts without private Account changes', async () => {
        const { publishHomeAccountChangeForRouting, publishHomeAccountChangeWake } = await import('./homeAccountChange');
        const affects = (event: Parameters<typeof publishHomeAccountChangeForRouting>[2] & { entityIds?: readonly string[] }) =>
            changePlanner.homeAccountChangeAffectsPublicProfile(publishHomeAccountChangeForRouting('profile-home', event?.entityIds, event));
        for (const source of ['connected', 'snapshot'] as const) {
            expect(affects({ source, changeKinds: ['session'], entityIds: ['session-one'] })).toBe(true);
        }
        for (const event of [{}, { changeKinds: [] }, { changeKinds: ['future-kind'] as never },
            { changeKinds: ['account'] }, { changeKinds: ['account'], entityIds: [] }] satisfies Parameters<typeof affects>[0][]) {
            expect(affects(event)).toBe(true);
        }
        for (const entityId of ['public-profile', 'self', 'unknown-account-row']) {
            expect(affects({ source: 'socket', changeKinds: ['account'], entityIds: [entityId] })).toBe(true);
        }
        for (const kind of ChangeKindSchema.options.filter(kind => kind !== 'account')) {
            expect(affects({ source: 'socket', changeKinds: [kind], entityIds: ['public-profile'] })).toBe(false);
        }
        for (const entityId of ['workflow-run:one', TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
            PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1, CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1,
            buildAccountIdentitiesChangeV1().entityId,
            buildProfilePhysicalKey('profile-one')]) {
            expect(affects({ source: 'socket', changeKinds: ['account'], entityIds: [entityId] })).toBe(false);
        }
        expect(changePlanner.homeAccountChangeAffectsPublicProfile(publishHomeAccountChangeWake('profile-home',
            { t: 'account-settings-changed', settingsVersion: 1 }, 'socket'))).toBe(false);
    });

    it('keeps malformed settings-version hints conservative instead of claiming an unrelated settings-only change', () => {
        for (const hint of [{}, { settingsVersion: '8' }, { settingsVersion: -1 }, { settingsVersion: 1.5 }]) {
            const planned = planSyncActionsFromChanges([buildChange({ cursor: 1, kind: 'account', entityId: 'self', hint })]);
            expect(plannedChangesAffectSessionListQuery(planned)).toBe(true);
            expect(planned.invalidate.savedSecretResources).toBe(true);
        }
        const settings = planSyncActionsFromChanges([buildChange({ cursor: 2, kind: 'account', entityId: 'self', hint: { settingsVersion: 8 } })]);
        expect(plannedChangesAffectSessionListQuery(settings)).toBe(false);
        expect(settings.invalidate.savedSecretResources).toBe(false);
    });

    it('publishes the canonical Workflow definition query relevance for unrelated changes and recovery', async () => {
        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        for (const kind of ['session', 'discussion', 'feed', 'friends', 'pet', 'kv'] as const) {
            expect(publishHomeAccountChangeForRouting('home', ['row'], { source: 'socket', changeKinds: [kind] }))
                .toMatchObject({ workflowDefinitionsAffect: false });
        }
        expect(publishHomeAccountChangeForRouting('home', ['workflow-run:one'], { source: 'socket', changeKinds: ['account'] }))
            .toMatchObject({ workflowDefinitionsAffect: false });
        for (const kind of ['artifact', 'automation', 'machineRecipientAccess', 'pluginDomain', 'share'] as const) {
            expect(publishHomeAccountChangeForRouting('home', ['row'], { source: 'socket', changeKinds: [kind] }))
                .toMatchObject({ workflowDefinitionsAffect: true, workflowPluginSourcesAffect: true });
        }
        // A Machine row can change only the Machine-contributed sources, never a saved definition.
        expect(publishHomeAccountChangeForRouting('home', ['row'], { source: 'socket', changeKinds: ['machine'] }))
            .toMatchObject({ workflowDefinitionsAffect: false, workflowPluginSourcesAffect: true });
        expect(publishHomeAccountChangeForRouting('home', ['row'], { source: 'socket', changeKinds: ['session'] }))
            .toMatchObject({ workflowPluginSourcesAffect: false });
        expect(publishHomeAccountChangeForRouting('home')).toMatchObject({ workflowDefinitionsAffect: true });
        expect(publishHomeAccountChangeForRouting('home', [], { changeKinds: [] }))
            .toMatchObject({ workflowDefinitionsAffect: true });
        expect(publishHomeAccountChangeForRouting('home', undefined, { source: 'connected' }))
            .toMatchObject({ workflowDefinitionsAffect: true });
    });

    it('publishes Machine resource relevance once while preserving authority, unknown and recovery reads', async () => {
        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        for (const kind of ['session', 'discussion', 'automation', 'artifact'] as const) {
            expect(publishHomeAccountChangeForRouting('home', ['row'], { source: 'socket', changeKinds: [kind] }))
                .toMatchObject({ machineResourcesAffect: false });
        }
        expect(publishHomeAccountChangeForRouting('home', ['workflow-run:one'], { source: 'socket', changeKinds: ['account'] }))
            .toMatchObject({ machineResourcesAffect: false });
        for (const kind of ['machine', 'machineRecipientAccess', 'machinePool', 'pluginDomain', 'savedSecretResource'] as const) {
            expect(publishHomeAccountChangeForRouting('home', ['row'], { source: 'socket', changeKinds: [kind] }))
                .toMatchObject({ machineResourcesAffect: true });
        }
        for (const entityId of ['self', 'teams', 'machine-preset:one']) {
            expect(publishHomeAccountChangeForRouting('home', [entityId], { source: 'socket', changeKinds: ['account'] }))
                .toMatchObject({ machineResourcesAffect: true });
        }
        expect(publishHomeAccountChangeForRouting('home')).toMatchObject({ machineResourcesAffect: true });
        expect(publishHomeAccountChangeForRouting('home', [], { changeKinds: [] }))
            .toMatchObject({ machineResourcesAffect: true });
        for (const source of ['connected', 'snapshot'] as const) {
            expect(publishHomeAccountChangeForRouting('home', undefined, { source, machineResourcesAffect: false }))
                .toMatchObject({ machineResourcesAffect: true });
        }
        const unrelatedPage = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'session', entityId: 'session-one' }),
            buildChange({ cursor: 2, kind: 'account', entityId: 'workflow-run:one' }),
        ]);
        expect(changePlanner.plannedChangesAffectMachineResources(unrelatedPage)).toBe(false);
        expect(changePlanner.accountChangeKindsAffectMachineResources(['future-kind'], ['row'])).toBe(true);
    });
    it('publishes typed readiness demand separately from generic Session, transcript and projection arrivals', async () => {
        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        const none = { sessionIds: [], machineIds: [] };
        for (const kind of ['session', 'artifact', 'discussion', 'feed'] as const) {
            expect(publishHomeAccountChangeForRouting('home', ['session-one'], { source: 'socket', changeKinds: [kind] }))
                .toMatchObject({ sessionReadinessChanges: none });
        }
        expect(publishHomeAccountChangeForRouting('home', ['session-one'], { source: 'socket', changeKinds: ['share'] }))
            .toMatchObject({ sessionReadinessChanges: { sessionIds: ['session-one'], machineIds: [] } });
        for (const kind of ['machine', 'machineRecipientAccess'] as const) {
            expect(publishHomeAccountChangeForRouting('home', ['machine-one'], { source: 'socket', changeKinds: [kind] }))
                .toMatchObject({ sessionReadinessChanges: { sessionIds: [], machineIds: ['machine-one'] } });
        }
        for (const entityId of ['teams', 'team-credential-material', 'self', buildConnectedServicesAccountChangeV1().entityId]) {
            expect(publishHomeAccountChangeForRouting('home', [entityId], { source: 'socket', changeKinds: ['account'] }))
                .toMatchObject({ sessionReadinessChanges: 'all' });
        }
        expect(publishHomeAccountChangeForRouting('home', ['workflow-run:one'], { source: 'socket', changeKinds: ['account'] }))
            .toMatchObject({ sessionReadinessChanges: none });
        for (const source of ['connected', 'snapshot'] as const) {
            expect(publishHomeAccountChangeForRouting('home', undefined, { source }))
                .toMatchObject({ sessionReadinessChanges: 'all' });
        }
        expect(publishHomeAccountChangeForRouting('home')).toMatchObject({ sessionReadinessChanges: 'all' });
    });
    it('keeps known Account row wakes local while legacy Account wakes remain conservative', async () => {
        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        let settingsRefreshes = 0;
        let profileCatalogRefreshes = 0;
        for (let index = 0; index < 40; index += 1) {
            const wake = publishHomeAccountChangeForRouting('home', [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1], {
                source: 'socket', changeKinds: ['account'],
            });
            settingsRefreshes += Number(wake.accountSettingsAffects);
            profileCatalogRefreshes += Number(changePlanner.homeAccountChangeAffectsProfileCatalog(wake));
        }
        expect({ settingsRefreshes, profileCatalogRefreshes }).toEqual({ settingsRefreshes: 0, profileCatalogRefreshes: 0 });
        expect(publishHomeAccountChangeForRouting('home', [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1], {
            source: 'catch-up-pending', changeKinds: ['account'],
        })).toMatchObject({ entityIds: [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1], sessionListQueryAffects: false });
        const profileId = buildProfilePhysicalKey('changed-profile');
        expect(publishHomeAccountChangeForRouting('home', [profileId], { source: 'socket', changeKinds: ['account'] }))
            .toMatchObject({ entityIds: [profileId], accountSettingsAffects: false, profileCatalogAffects: true });
        for (const entityId of ['self', 'future-account-key', TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
            buildConnectedServicesAccountChangeV1().entityId, 'home-governance']) {
            const wake = publishHomeAccountChangeForRouting('home', [entityId], { source: 'socket', changeKinds: ['account'] });
            expect(wake).toMatchObject({ accountSettingsAffects: true, workflowTriggersAffect: true });
            expect(wake).not.toHaveProperty('changeKinds');
        }
        const mixed = publishHomeAccountChangeForRouting('home', [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, 'discussion-one'], {
            source: 'socket', changeKinds: ['account', 'discussion'],
        });
        expect(mixed).toMatchObject({ accountSettingsAffects: true, workflowTriggersAffect: true });
        expect(mixed).not.toHaveProperty('entityIds');
        expect(mixed).not.toHaveProperty('feedPageConsumed');
    });
    it('routes Saved Secret material by its source and access changes, independently of Profile rows', () => {
        const exactAccount = { changeKinds: ['account'] as const, sessionSystemRecords: [], accountSettingsAffects: false };
        const affects = changePlanner.homeAccountChangeAffectsSavedSecretCatalog;
        expect(affects({ ...exactAccount, entityIds: [buildProfilePhysicalKey('profile-one')] })).toBe(false);
        expect(affects({ ...exactAccount, entityIds: [savedSecretDisclosureActivityEntityIdV1('secret-one')] })).toBe(false);
        expect(affects({ changeKinds: ['machine'], accountSettingsAffects: false })).toBe(false);
        expect(affects({ changeKinds: ['artifact'], accountSettingsAffects: false })).toBe(false);
        expect(affects({ ...exactAccount, entityIds: ['self'], accountSettingsAffects: true })).toBe(true);
        for (const entityId of [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, buildConnectedServicesAccountChangeV1().entityId, 'self']) {
            expect(affects({ ...exactAccount, entityIds: [entityId] })).toBe(true);
        }
        expect(affects({ changeKinds: ['savedSecretResource'], accountSettingsAffects: false })).toBe(true);
        expect(affects({ savedSecretCatalogAffects: false })).toBe(false);
        expect(affects({})).toBe(true);
        expect(affects({ changeKinds: ['account'] })).toBe(true);
    });
    it('preserves an exact producer Discussion exclusion on a coarse usage wake without narrowing unknown wakes', async () => {
        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        const usageDetails = { source: 'socket' as const, discussionAffects: false, savedSecretCatalogAffects: false };
        expect(publishHomeAccountChangeForRouting('home', undefined, usageDetails))
            .toMatchObject({ source: 'socket', discussionAffects: false, savedSecretCatalogAffects: false });
        expect(publishHomeAccountChangeForRouting('home', undefined, { source: 'socket' }))
            .not.toHaveProperty('discussionAffects');
        expect(publishHomeAccountChangeForRouting('home', undefined, { source: 'socket' }))
            .not.toHaveProperty('savedSecretCatalogAffects');
        const changedDetails = { source: 'snapshot' as const, discussionAffects: true };
        expect(publishHomeAccountChangeForRouting('home', undefined, changedDetails))
            .toMatchObject({ discussionAffects: true });
    });
    it.each([CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1])(
        'routes %s to its catalog without generic Settings or Account-profile reads', entityId => {
            const changes = Array.from({ length: 40 }, (_, index) => buildChange({
                cursor: index + 1, kind: 'account', entityId,
                hint: { connectedMetadata: true, revision: index + 1 },
            }));
            const planned = planSyncActionsFromChanges(changes);
            expect(planned.invalidate.settings).toBe(false);
            expect(planned.invalidate.profile).toBe(false);
            expect(plannedChangesAffectProfileCatalog(planned)).toBe(false);
            // Entered prices remain a live Usage input even though they are no longer Settings.
            expect(plannedChangesAffectUsageQuery(planned)).toBe(true);
            for (const changedId of ['self', 'future-account-row']) {
                const mixed = planSyncActionsFromChanges([...changes, buildChange({
                    cursor: 41, kind: 'account', entityId: changedId, hint: { settingsVersion: 9 },
                })]);
                expect(mixed.invalidate.settings).toBe(true);
                expect(mixed.invalidate.profile).toBe(true);
                expect(plannedChangesAffectProfileCatalog(mixed)).toBe(true);
            }
        },
    );
    it('routes disclosure history cursors without changing secret, Settings or binding currentness', async () => {
        const entityId = savedSecretDisclosureActivityEntityIdV1('exact-login');
        const changes = Array.from({ length: 20 }, (_, index) => buildChange({ cursor: index + 1, kind: 'account', entityId }));
        const planned = planSyncActionsFromChanges(changes);
        expect(Object.values(planned.invalidate).some(Boolean)).toBe(false);
        expect(plannedChangesAffectProfileCatalog(planned)).toBe(false);
        const { publishHomeAccountChangeForRouting } = await import('./homeAccountChange');
        const wake = publishHomeAccountChangeForRouting('home', [entityId], { source: 'socket', changeKinds: ['account'] });
        expect(wake).toMatchObject({ entityIds: [entityId], profileCatalogAffects: false, accountSettingsAffects: false });
        expect(changePlanner.homeAccountChangeAffectsProfileCatalog(wake)).toBe(false);
        const changed = planSyncActionsFromChanges([...changes, buildChange({ cursor: 21, kind: 'savedSecretResource', entityId: 'exact-login' })]);
        expect(changed.invalidate.savedSecretResources).toBe(true);
    });
    it('publishes private trigger demand only for definition, source or access changes', () => {
        const unrelated = [
            buildChange({ cursor: 1, kind: 'machine', entityId: 'machine-one' }),
            buildChange({ cursor: 2, kind: 'account', entityId: 'workflow-run:run-one' }),
            buildChange({ cursor: 3, kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 }),
            buildChange({ cursor: 4, kind: 'kv', entityId: 'self', hint: { keys: ['todo:one'] } }),
            buildChange({ cursor: 5, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/data-kv',
                hint: { pluginDomain: 'dataKv', pluginId: 'example.tasks', keys: ['status'] } }),
        ];
        expect(changePlanner.plannedChangesAffectWorkflowTriggers(planSyncActionsFromChanges(unrelated))).toBe(false);
        for (const changed of [
            buildChange({ cursor: 6, kind: 'automation', entityId: 'automation-one' }),
            buildChange({ cursor: 7, kind: 'artifact', entityId: 'workflow-one' }),
            buildChange({ cursor: 8, kind: 'account', entityId: 'self' }),
            buildChange({ cursor: 9, kind: 'machineRecipientAccess', entityId: 'machine-one' }),
            buildChange({ cursor: 10, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/availability',
                hint: { pluginDomain: 'availability', pluginId: 'example.tasks' } }),
        ]) {
            expect(changePlanner.plannedChangesAffectWorkflowTriggers(planSyncActionsFromChanges([...unrelated, changed]))).toBe(true);
        }
        expect(changePlanner.accountChangeKindsAffectWorkflowTriggers(['machine', 'session', 'kv'])).toBe(false);
        for (const kinds of [undefined, [], ['account'], ['pluginDomain'], ['future-kind']]) {
            expect(changePlanner.accountChangeKindsAffectWorkflowTriggers(kinds)).toBe(true);
        }
    });

    it('routes addressed Session record changes without refreshing Account settings or Session inventories', () => {
        const wake: HomeAccountChangeEvent = { serverId: 'home', changeKinds: ['account'],
            sessionSystemRecords: [{ sessionId: 'session-one', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } }] };
        expect(changePlanner.homeAccountChangeAffectsProfileCatalog(wake)).toBe(false);
        expect(changePlanner.homeAccountChangeAffectsProfileCatalog({ changeKinds: ['account'] })).toBe(true);
        for (const kind of ['artifact', 'savedSecretResource']) {
            expect(changePlanner.homeAccountChangeAffectsProfileCatalog({ ...wake, changeKinds: ['account', kind] })).toBe(true);
        }
        expect(changePlanner.homeAccountChangeAffectsProfileCatalog({ ...wake, profileCatalogAffects: true })).toBe(true);
        const change: ApiChangeEntry = { kind: 'account', entityId: 'session-record:record-one', cursor: 1, changedAt: 1,
            hint: { v: 1, sessionRecords: { sessionId: 'session-one',
                address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } } } };
        const planned = planSyncActionsFromChanges([change]);
        expect(Object.values(planned.invalidate).some(Boolean)).toBe(false);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(plannedChangesAffectUsageQuery(planned)).toBe(false);
        expect(classifyChangeForCheckpoint(change, { isSessionMessagesLoaded: () => false })).toMatchObject({
            decision: 'critical', plannerOwner: 'session-system-records', materializationProof: 'session-system-records-invalidation',
        });
    });
    it('refreshes connected-service currentness without waking encrypted Settings and retains the next settings-only fast path', () => {
        const serviceChanges = [
            buildConnectedServicesAccountChangeV1({ pluginId: 'acme.accounts', localId: 'service-a' }),
            buildConnectedServicesAccountChangeV1({ pluginId: 'acme.accounts', localId: 'service-b' }),
            buildConnectedServicesAccountChangeV1(),
            { kind: 'account' as const, entityId: 'self', hint: { connectedServices: true } },
        ];
        for (const [index, change] of serviceChanges.entries()) {
            const planned = planSyncActionsFromChanges([buildChange({ cursor: index + 1, ...change })]);
            expect(planned.invalidate.savedSecretResources, change.entityId).toBe(true);
            expect(planned.invalidate.profile, change.entityId).toBe(true);
            expect(planned.invalidate.settings, change.entityId).toBe(change.entityId === 'self');
            expect(plannedChangesAffectSessionListQuery(planned), change.entityId).toBe(true);
            expect(plannedChangesAffectUsageQuery(planned), change.entityId).toBe(true);
        }
        const settings = planSyncActionsFromChanges([buildChange({
            cursor: 5, kind: 'account', entityId: 'self', hint: { settingsVersion: 8 },
        })]);
        expect(settings.invalidate.settings).toBe(true);
        expect(settings.invalidate.savedSecretResources).toBe(false);
        expect(plannedChangesAffectSessionListQuery(settings)).toBe(false);
    });

    it('keeps private Account catalog rows off the Account profile read', () => {
        for (const entityId of [NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, ACP_CATALOG_ACCOUNT_ROW_KEY_V1]) {
            const planned = planSyncActionsFromChanges([buildChange({ cursor: 1, kind: 'account', entityId })]);
            expect(planned.invalidate.profile, entityId).toBe(false);
            // Row readers still observe these through the Settings admission they already consume.
            expect(planned.invalidate.settings, entityId).toBe(true);
            expect(planned.invalidate.savedSecretResources, entityId).toBe(false);
        }
        // Unknown Account ids keep the conservative Settings + Profile recovery.
        const unknown = planSyncActionsFromChanges([buildChange({ cursor: 2, kind: 'account', entityId: 'future-account-row' })]);
        expect(unknown.invalidate.profile).toBe(true);
    });

    it('refreshes linked-identity currentness from its dedicated row without waking encrypted Settings', () => {
        for (const [index, change] of [
            buildAccountIdentitiesChangeV1(),
            { kind: 'account' as const, entityId: 'self', hint: { linkedProviders: true } },
        ].entries()) {
            const planned = planSyncActionsFromChanges([buildChange({ cursor: index + 1, ...change })]);
            expect(planned.invalidate.profile, change.entityId).toBe(true);
            expect(planned.invalidate.savedSecretResources, change.entityId).toBe(true);
            expect(planned.invalidate.settings, change.entityId).toBe(change.entityId === 'self');
            expect(plannedChangesAffectSessionListQuery(planned), change.entityId).toBe(true);
        }
    });

    it('routes private Profile rows and controls only to their demanded catalog wake', () => {
        for (const entityId of [buildProfilePhysicalKey('profile-a'), PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, PROFILE_TRANSFER_ACCOUNT_KV_KEY]) {
            const planned = planSyncActionsFromChanges([buildChange({ cursor: 1, kind: 'account', entityId, hint: { profiles: true } })]);
            expect(planned.invalidate.settings).toBe(false);
            expect(planned.invalidate.profile).toBe(false);
            expect(classifyChangeForCheckpoint(planned.changes[0]!, { isSessionMessagesLoaded: () => false }))
                .toMatchObject({ plannerOwner: 'profile-catalog', materializationProof: 'profile-catalog-wake' });
            const affects = 'plannedChangesAffectProfileCatalog' in changePlanner ? changePlanner.plannedChangesAffectProfileCatalog : undefined;
            if (typeof affects !== 'function') throw new Error('missing_profile_catalog_projection');
            expect(affects(planned)).toBe(true);
            expect(affects(planSyncActionsFromChanges([buildChange({ cursor: 2, kind: 'session', entityId: 'session-a' })]))).toBe(false);
            expect(affects(planSyncActionsFromChanges([buildChange({ cursor: 3, kind: 'artifact', entityId: 'new-granted-artifact' })]))).toBe(true);
            expect(affects(planSyncActionsFromChanges([buildChange({ cursor: 4, kind: 'account', entityId: 'self', hint: { settingsVersion: 7 } })]))).toBe(true);
        }
    });
    it('retains exact tag deletions separately from ordinary tag invalidations', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: {
                    sessionOrganization: true,
                    scope: 'tags',
                    tagIds: ['deleted-tag', 'updated-tag'],
                    deletedTagIds: ['deleted-tag'],
                },
            }),
        ]);

        expect(planned.sessionOrganization).toMatchObject({
            mode: 'snapshot',
            tagIds: ['deleted-tag', 'updated-tag'],
            deletedTagIds: ['deleted-tag'],
            includeTags: true,
        });
    });

    it('refreshes only Usage for a provider observation while keeping Account-currentness changes conservative', () => {
        const planned = planSyncActionsFromChanges([buildChange({
            cursor: 1, kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1,
        })]);
        expect(Object.values(planned.invalidate).some(Boolean)).toBe(false);
        expect(plannedChangesAffectProfileCatalog(planned)).toBe(false);
        expect(plannedChangesAffectSessionListQuery(planned)).toBe(false);
        expect(plannedChangesAffectUsageQuery(planned)).toBe(true);
        const mixed = planSyncActionsFromChanges([...planned.changes, buildChange({ cursor: 2, kind: 'account', entityId: 'self' })]);
        expect(mixed.invalidate.settings).toBe(true);
        expect(mixed.invalidate.profile).toBe(true);
        expect(plannedChangesAffectProfileCatalog(mixed)).toBe(true);
    });

    it('routes an exact workflow Run change to its canonical body refresh without broad Account invalidation', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'account', entityId: 'workflow-run:run-42' }),
        ]);

        expect(planned.workflowRunIdsToRefresh).toEqual(['run-42']);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });

    it('leaves Machine-only Usage freshness to opened store inputs without suppressing accounting or Session evidence', () => {
        const machine = buildChange({ cursor: 1, kind: 'machine', entityId: 'machine-a' });
        expect(plannedChangesAffectUsageQuery(planSyncActionsFromChanges([machine]))).toBe(false);
        for (const change of [
            buildChange({ cursor: 2, kind: 'account', entityId: 'provider-account-usage' }),
            buildChange({ cursor: 2, kind: 'account', entityId: 'provider-account-usage-record:paug_v1_abcdefgh' }),
            buildChange({ cursor: 3, kind: 'account', entityId: 'self', hint: { settingsVersion: 8 } }),
            buildChange({ cursor: 4, kind: 'session', entityId: 'session-a' }),
        ]) expect(plannedChangesAffectUsageQuery(planSyncActionsFromChanges([machine, change]))).toBe(true);
    });

    it('routes recipient-access Machine changes through the Machine projection owner', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'machineRecipientAccess', entityId: 'machine-a' }),
        ]);

        expect(planned.invalidate.machines).toBe(true);
        expect(planned.unsupportedChanges).toEqual([]);
        expect(classifyChangeForCheckpoint(planned.changes[0]!, {
            isSessionMessagesLoaded: () => false,
        })).toMatchObject({ plannerOwner: 'machines', snapshotDomain: 'machines' });
    });

    it('ignores unrelated domain pages without suppressing a material Usage change on the same page', () => {
        const unrelated = [
            buildChange({ cursor: 1, kind: 'machine', entityId: 'machine-a' }),
            buildChange({ cursor: 2, kind: 'artifact', entityId: 'approval-a' }),
            buildChange({ cursor: 3, kind: 'feed', entityId: 'feed-a' }),
            buildChange({ cursor: 4, kind: 'account', entityId: 'workflow-run:run-42' }),
        ];
        expect(plannedChangesAffectUsageQuery(planSyncActionsFromChanges(unrelated))).toBe(false);
        expect(plannedChangesAffectUsageQuery(planSyncActionsFromChanges([...unrelated,
            buildChange({ cursor: 5, kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 }),
        ]))).toBe(true);
    });

    it('does not reread Usage for exact workflow Run and draft materialization, while preserving mixed-page freshness', () => {
        const unrelated = [
            buildChange({ cursor: 1, kind: 'account', entityId: 'workflow-run:run-42' }),
            buildChange({ cursor: 2, kind: 'account', hint: {
                v: 2, sessionDraftV2: true,
                address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' },
                revision: 2, status: 'present',
            } }),
        ];
        const planned = planSyncActionsFromChanges(unrelated);
        expect(planned.workflowRunIdsToRefresh).toEqual(['run-42']);
        expect(planned.sessionDrafts).toHaveLength(1);
        expect(plannedChangesAffectUsageQuery(planned)).toBe(false);
        for (const change of [
            buildChange({ cursor: 3, kind: 'session', entityId: 'session-a' }),
            buildChange({ cursor: 4, kind: 'account', entityId: 'provider-account-usage' }),
            buildChange({ cursor: 5, kind: 'account', entityId: 'self', hint: { settingsVersion: 9 } }),
            buildChange({ cursor: 6, kind: 'account', entityId: 'unknown-source' }),
        ]) expect(plannedChangesAffectUsageQuery(planSyncActionsFromChanges([...unrelated, change]))).toBe(true);
    });

    it('routes Saved Secret AccountChange through the catalog materialization owner', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'savedSecretResource', entityId: 'resource-a' }),
        ]);

        expect(planned.invalidate.savedSecretResources).toBe(true);
        expect(classifyChangeForCheckpoint(planned.changes[0]!, {
            isSessionMessagesLoaded: () => false,
        })).toMatchObject({
            decision: 'critical',
            plannerOwner: 'saved-secrets',
            snapshotDomain: 'saved-secret-resource-catalog',
            materializationProof: 'saved-secret-resource-catalog',
        });
    });

    it('keeps credential material delivery out of Account settings and Saved Secret authorization', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'account', entityId: 'team-credential-material' }),
        ]);
        expect(planned.invalidate.savedSecretResources).toBe(false);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
        expect(planned.unsupportedChanges).toEqual([]);
    });

    it('withdraws and refreshes Saved Secret material when Team or Group membership changes', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'account', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 }),
        ]);

        expect(planned.invalidate.savedSecretResources).toBe(true);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });

    it('refreshes Saved Secret material for recipient key currentness but not a settings-only write', () => {
        const bindingChanged = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'account', entityId: 'self', hint: { accountEncryptionTransitionId: 'transition-a' } }),
        ]);
        const settingsOnly = planSyncActionsFromChanges([
            buildChange({ cursor: 2, kind: 'account', entityId: 'self', hint: { settingsVersion: 8 } }),
        ]);

        expect(bindingChanged.invalidate.savedSecretResources).toBe(true);
        expect(settingsOnly.invalidate.savedSecretResources).toBe(false);
    });

    it('derives filtered-list membership invalidation from the canonical change plan', () => {
        const cases = [
            {
                label: 'Session access or content',
                changes: [buildChange({ cursor: 1, kind: 'session', entityId: 'session-1' })],
                expected: true,
            },
            {
                label: 'Team or Group membership',
                changes: [buildChange({ cursor: 1, kind: 'account', entityId: 'teams' })],
                expected: true,
            },
            {
                label: 'Home authentication method availability',
                changes: [buildChange({ cursor: 1, kind: 'account', entityId: 'home-governance' })],
                expected: true,
            },
            {
                label: 'tag assignment',
                changes: [buildChange({
                    cursor: 1,
                    kind: 'account',
                    entityId: 'session-organization',
                    hint: { sessionOrganization: true, scope: 'tagAssignments', tagIds: ['tag-1'] },
                })],
                expected: true,
            },
            {
                label: 'Follow membership',
                changes: [buildChange({
                    cursor: 1,
                    kind: 'account',
                    entityId: 'session-follows',
                    hint: { sessionFollows: true, full: true },
                })],
                expected: true,
            },
            {
                label: 'obsolete targeted Follow defaults hint remains conservative',
                changes: [buildChange({
                    cursor: 1,
                    kind: 'account',
                    entityId: 'session-follows',
                    hint: { sessionFollows: true, preferences: true },
                })],
                expected: true,
            },
            {
                label: 'presentation-only Account settings',
                changes: [buildChange({
                    cursor: 1,
                    kind: 'account',
                    entityId: 'self',
                    hint: { settingsVersion: 2 },
                })],
                expected: false,
            },
            {
                label: 'Account or credential currentness',
                changes: [buildChange({
                    cursor: 1,
                    kind: 'account',
                    entityId: 'self',
                    hint: null,
                })],
                expected: true,
            },
        ] as const;

        for (const testCase of cases) {
            const planned = planSyncActionsFromChanges([...testCase.changes]);
            expect(plannedChangesAffectSessionListQuery(planned), testCase.label).toBe(testCase.expected);
        }
    });

    it('refreshes only the rows of listed Sessions for row-level writes, never the whole list', () => {
        const listed = new Set(['listed-message', 'listed-metadata', 'listed-pending']);
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'session', entityId: 'listed-message', hint: { lastMessageSeq: 5, lastMessageId: 'm5', pendingExecutionRunIds: [] } }),
            // The server enriches metadata/activity writes with pending targets.
            buildChange({ cursor: 2, kind: 'session', entityId: 'listed-metadata', hint: { pendingExecutionRunIds: [] } }),
            buildChange({ cursor: 3, kind: 'session', entityId: 'listed-pending', hint: { pendingVersion: 3, pendingCount: 1, pendingExecutionRunIds: ['run-a'] } }),
        ], { isSessionListMember: (sessionId) => listed.has(sessionId) });

        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionRowRefreshIds).toEqual(['listed-message', 'listed-metadata', 'listed-pending']);
        expect(planned.sessionIdsToCatchUp).toEqual(['listed-message', 'listed-metadata', 'listed-pending']);
        // Ordinary-answerable corpora are unaffected; a structural filter may still move.
        expect(plannedChangesAffectSessionListQuery(planned)).toBe('structural');
    });

    it('keeps every protocol row-only hint (metadata, agent-state, runtime-activity, turn-status) row-level', () => {
        const hints = [
            { metadataVersion: 3 }, { metadataVersion: 3, agentStateVersion: 2 }, { agentStateVersion: 2 },
            { runtimeActivityRevision: 9 }, { latestTurnStatusObservedAt: 100 },
        ];
        const planned = planSyncActionsFromChanges(
            hints.map((hint, index) => buildChange({ cursor: index + 1, kind: 'session', entityId: 'listed', hint })),
            { isSessionListMember: () => true },
        );
        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionRowRefreshIds).toEqual(['listed']);
    });

    it('keeps a listed Session row-level when the server enriches its write with follow projection facts', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 3976038, kind: 'session', entityId: 'listed-shared', hint: {
                sharedMetadataVersion: 70, followReceiverAvailabilityChanged: true,
                followReceiverAvailabilityChangedAtCursor: 3976036, pendingExecutionRunIds: [],
            } }),
            buildChange({ cursor: 3976040, kind: 'session', entityId: 'listed-shared', hint: {
                sharedMetadataVersion: 71, followSourceChanged: false, followSourceUnchangedSinceCursor: 3976038,
                followReceiverAvailabilityChanged: true, followReceiverAvailabilityChangedAtCursor: 3976036,
            } }),
        ], { isSessionListMember: (sessionId) => sessionId === 'listed-shared' });

        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionRowRefreshIds).toEqual(['listed-shared']);
    });

    it('keeps one list refresh for changes that can alter which Sessions are listed', () => {
        const listed = new Set(['listed-archived', 'listed-deleted', 'listed-shared', 'listed-responsible']);
        // An unloaded row's transcript write is batch-read and placed in place by the
        // Home-published membership facts; it no longer refreshes every list.
        const unlisted = planSyncActionsFromChanges([buildChange({ cursor: 1, kind: 'session', entityId: 'unlisted',
            hint: { lastMessageSeq: 1, lastMessageId: 'm1' } })], { isSessionListMember: (sessionId) => listed.has(sessionId) });
        expect(unlisted.invalidate.sessions).toBe(false);
        expect(unlisted.sessionRowRefreshIds).toEqual(['unlisted']);
        expect(plannedChangesAffectSessionListQuery(unlisted)).toBe('structural');
        const cases = [
            buildChange({ cursor: 2, kind: 'session', entityId: 'listed-archived', hint: { archivedAt: 10 } }),
            buildChange({ cursor: 3, kind: 'session', entityId: 'listed-deleted', hint: { v: 1, lifecycle: 'deleted' } }),
            buildChange({ cursor: 4, kind: 'share', entityId: 'listed-shared' }),
            buildChange({ cursor: 5, kind: 'session', entityId: 'listed-responsible', hint: { responsibleAccountId: null, responsibleAccount: null } }),
        ];
        for (const change of cases) {
            const planned = planSyncActionsFromChanges([change], { isSessionListMember: (sessionId) => listed.has(sessionId) });
            expect(planned.invalidate.sessions, change.entityId).toBe(true);
            expect(planned.sessionRowRefreshIds, change.entityId).toEqual([]);
            expect(plannedChangesAffectSessionListQuery(planned), change.entityId).toBe(true);
        }
        // Without list knowledge every Session write stays a conservative list refresh.
        const conservative = planSyncActionsFromChanges([
            buildChange({ cursor: 6, kind: 'session', entityId: 'listed-archived', hint: { lastMessageSeq: 2, lastMessageId: 'm2' } }),
        ]);
        expect(conservative.invalidate.sessions).toBe(true);
        expect(conservative.sessionRowRefreshIds).toEqual([]);
    });

    it.each(['teams', 'home-governance'] as const)(
        'routes account/%s through the scoped snapshot owner without broad Settings or Profile refresh',
        (entityId) => {
            const planned = planSyncActionsFromChanges([
                buildChange({ cursor: 1, kind: 'account', entityId }),
            ]);

            // applyPlannedChangeActions publishes the AccountChange page to the
            // scoped snapshot owners. These stable Lane 01 entity IDs must not
            // also take the legacy broad Account refresh path.
            expect(planned.invalidate.settings).toBe(false);
            expect(planned.invalidate.profile).toBe(false);
            expect(planned.unsupportedChanges).toEqual([]);
        },
    );

    it.skipIf(!hasReleasedUiAccountChangeReader())(
        'executes the immutable v0.2.11 AccountChange reader vector in both reachable directions',
        () => {
            // Current-server -> released-UI direction. The entity IDs are new,
            // while kind/account, the optional additive hint, and every other
            // field retain the released wire. Execute the immutable released
            // parser and planner rather than reconstructing their behavior.
            const releasedReader = executeReleasedUiAccountChangeReader([
                {
                    cursor: 41,
                    kind: 'account',
                    entityId: 'teams',
                    changedAt: 1_725_555_555_001,
                    hint: null,
                },
                {
                    cursor: 42,
                    kind: 'account',
                    entityId: 'home-governance',
                    changedAt: 1_725_555_555_002,
                    hint: null,
                },
            ]);

            expect(releasedReader).toEqual({
                parsed: true,
                settings: true,
                profile: true,
                unsupportedCount: 0,
                checkpointDecisions: ['critical', 'critical'],
                checkpointMaterializationProofs: ['account-settings-profile', 'account-settings-profile'],
            });

            // Released-server -> current-UI direction. This entry is frozen
            // from the v0.2.11 AccountChange writer's ordinary Account shape.
            const releasedWriterEntry = {
                cursor: 7,
                kind: 'account',
                entityId: 'self',
                changedAt: 1_725_555_555_000,
                hint: null,
            } as const;
            expect(ChangeEntrySchema.parse(releasedWriterEntry)).toEqual(releasedWriterEntry);
            expect(planSyncActionsFromChanges([releasedWriterEntry])).toMatchObject({
                invalidate: { settings: true, profile: true },
                unsupportedChanges: [],
            });
        },
    );

    it('refreshes Session relevance after Follow changes without reloading encrypted settings', () => {
        const planned = planSyncActionsFromChanges([buildChange({
            cursor: 1, kind: 'account', entityId: 'session-follows',
            hint: { sessionFollows: true, full: true },
        })]);
        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });
    it.each([1, 2] as const)('plans exact SessionDraft materialization without broad Account invalidation (epoch %s)', (epoch) => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' } as const;
        const planned = planSyncActionsFromChanges([2, 4, 3].map((revision, index) => buildChange({
            cursor: index + 1,
            kind: 'account',
            hint: { ...(epoch === 1 ? { v: 1, sessionDraft: true } : { v: 2, sessionDraftV2: true }), address, revision, status: 'present' },
        })));

        expect(planned.sessionDrafts).toEqual([{ address, revision: 4 }]);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
        expect(classifyChangeForCheckpoint(planned.changes[0]!, {
            isSessionMessagesLoaded: () => false,
        })).toMatchObject({ plannerOwner: 'session-drafts', materializationProof: 'session-draft' });
    });

    it('plans session catch-up and invalidations', () => {
        const changes: ApiChangeEntry[] = [
            buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
            buildChange({ cursor: 2, kind: 'share', entityId: 's2' }),
            buildChange({ cursor: 3, kind: 'machine', entityId: 'm1' }),
            buildChange({ cursor: 4, kind: 'artifact', entityId: 'a1' }),
            buildChange({ cursor: 5, kind: 'account', entityId: 'self' }),
            buildChange({ cursor: 6, kind: 'friends', entityId: 'self' }),
            buildChange({ cursor: 7, kind: 'feed', entityId: 'self' }),
        ];

        const planned = planSyncActionsFromChanges(changes);
        expect(planned.sessionIdsToCatchUp).toEqual(['s1', 's2']);
        expect(planned.invalidate).toEqual({
            sessions: true,
            machines: true,
            machinePools: false,
            artifacts: true,
            settings: true,
            profile: true,
            publicProfile: true,
            friends: true,
            feed: true,
            automations: false,
            pets: false,
            savedSecretResources: true,
            sessionFolderAssignments: false,
        });
        expect(planned.kv).toEqual({ type: 'none' });
    });

    it('plans KV bulk keys when hint.keys present', () => {
        const changes: ApiChangeEntry[] = [
            buildChange({ cursor: 1, kind: 'kv', hint: { keys: ['todo.index', 'todo.a'] } }),
        ];
        const planned = planSyncActionsFromChanges(changes);
        expect(planned.kv).toEqual({ type: 'bulk-keys', feature: 'todos', keys: ['todo.a', 'todo.index'] });
    });

    it('plans KV refresh when hint.full is true or invalid', () => {
        const plannedFull = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'kv', hint: { full: true } }),
        ]);
        expect(plannedFull.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });

        const plannedInvalid = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'kv', hint: { nope: true } as ApiChangeEntry['hint'] }),
        ]);
        expect(plannedInvalid.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });
    });

    it('deduplicates session catch-up ids', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
            buildChange({ cursor: 2, kind: 'share', entityId: 's1' }),
            buildChange({ cursor: 3, kind: 'session', entityId: '' }),
        ]);

        expect(planned.sessionIdsToCatchUp).toEqual(['s1']);
        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.invalidate.automations).toBe(false);
        expect(planned.kv).toEqual({ type: 'none' });
    });

    it('plans exact transcript revision repair from durable message-update hints', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'session',
                entityId: 's1',
                hint: { updatedMessageSeq: 15, updatedMessageId: 'm15' },
            }),
            buildChange({
                cursor: 2,
                kind: 'session',
                entityId: 's1',
                hint: { updatedMessageSeq: 10, updatedMessageId: 'm10' },
            }),
        ]);

        expect(planned.sessionTranscriptRepairs).toEqual([{
            sessionId: 's1',
            minSeq: 10,
            messageIds: ['m10', 'm15'],
            messageSeqs: { m10: 10, m15: 15 },
        }]);
    });

    it('carries the latest committed revision per message and drops it once any hint for that message lacks one', () => {
        const hint = (cursor: number, messageId: string, updatedMessageUpdatedAt?: number) => buildChange({
            cursor, kind: 'session', entityId: 's1',
            hint: { updatedMessageSeq: cursor, updatedMessageId: messageId,
                ...(updatedMessageUpdatedAt === undefined ? {} : { updatedMessageUpdatedAt }) },
        });
        const planned = planSyncActionsFromChanges([hint(1, 'm1', 200), hint(2, 'm1', 100), hint(3, 'm2', 300), hint(4, 'm2')]);

        expect(planned.sessionTranscriptRepairs).toEqual([{
            sessionId: 's1', minSeq: 1, messageIds: ['m1', 'm2'], messageSeqs: { m1: 2, m2: 4 },
            messageUpdatedAts: { m1: 200 },
        }]);
    });

    it('plans explicit session folder assignment refreshes without message catch-up', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'session',
                entityId: 's1',
                hint: { sessionFolderAssignment: true, folderId: 'folder-a' },
            }),
            buildChange({
                cursor: 2,
                kind: 'account',
                entityId: 'session-folder-assignments',
                hint: { sessionFolderAssignments: true, folderIds: ['folder-a'] },
            }),
        ]);

        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionFolderAssignmentSessionIds).toEqual(['s1']);
        expect(planned.invalidate.sessionFolderAssignments).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });

    it('plans scoped session organization snapshot refreshes', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: {
                    sessionOrganization: true,
                    scope: 'labels',
                    sessionIds: ['s1'],
                    folderIds: ['folder-a'],
                    tagIds: ['tag-a'],
                    orderScopes: [{ scopeKind: 'workspace', scopeKey: 'server-a' }],
                },
            }),
        ]);

        expect(planned.sessionOrganization).toEqual({
            mode: 'snapshot',
            assignmentSessionIds: ['s1'],
            folderIds: ['folder-a'],
            tagIds: ['tag-a'],
            deletedTagIds: [],
            orderScopes: [{ scopeKind: 'workspace', scopeKey: 'server-a' }],
            includeFolders: false,
            includeTags: false,
            includeLabels: true,
        });
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });

    it('plans a session-list refresh for pin organization hints without message catch-up', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'pins', sessionIds: ['s-pin'] },
            }),
        ]);

        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionOrganization).toMatchObject({
            mode: 'snapshot',
            assignmentSessionIds: ['s-pin'],
        });
    });

    it('plans a session-list refresh for attention standing organization hints', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'attentionStandings', sessionIds: ['s-standing'] },
            }),
        ]);

        // Standing moves a row between the attention band and the rest of the list, so the list
        // itself has to be re-read; a planner that only refreshed the organization snapshot would
        // leave the band painting yesterday's membership.
        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionOrganization).toMatchObject({
            mode: 'snapshot',
            assignmentSessionIds: ['s-standing'],
        });
    });

    it('refreshes appearance facts without re-reading Sessions or transcripts', () => {
        const planned = planSyncActionsFromChanges([buildChange({ cursor: 1, kind: 'account',
            entityId: 'session-organization', hint: { sessionOrganization: true, scope: 'sessionAppearances', sessionIds: ['s-color'] } })]);
        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionOrganization).toMatchObject({ mode: 'snapshot', assignmentSessionIds: ['s-color'] });
    });

    it('records unknown kinds as unsupported without treating them as safe invalidations', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 4, kind: 'unknown-change-kind' as ApiChangeEntry['kind'] }),
        ]);

        expect(planned.unsupportedChanges).toEqual([
            { cursor: '4', kind: 'unknown-change-kind', entityId: 'self' },
        ]);
        expect(planned.invalidate.sessions).toBe(false);
    });

    it('acknowledges a closed pluginDomain invalidation without creating a generic UI data store', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 4,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/availability',
                hint: { pluginDomain: 'availability', pluginId: 'example.tasks' },
            }),
        ]);

        expect(planned.unsupportedChanges).toEqual([]);
        expect(classifyChangeForCheckpoint(planned.changes[0]!, {
            isSessionMessagesLoaded: () => false,
        })).toMatchObject({
            decision: 'critical',
            plannerOwner: 'plugin-domain',
            snapshotDomain: 'plugin-domain-level-triggered',
        });
        expect(planned.invalidate).toEqual({
            sessions: false,
            machines: false,
            machinePools: false,
            artifacts: false,
            settings: false,
            profile: false,
            publicProfile: false,
            friends: false,
            feed: false,
            automations: false,
            pets: false,
            savedSecretResources: false,
            sessionFolderAssignments: false,
        });
    });

    it('maps every protocol change kind in the checkpoint coverage matrix', () => {
        expect(Object.keys(CHANGE_CHECKPOINT_COVERAGE).sort()).toEqual([...ChangeKindSchema.options].sort());
    });

    it('classifies independent Discussion changes without refreshing an owning Session', () => {
        const change = buildChange({ cursor: 91, kind: 'discussion', entityId: 'discussion-a',
            hint: { v: 1, discussions: true } });
        const planned = planSyncActionsFromChanges([change]);
        expect(planned.unsupportedChanges).toEqual([]);
        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(classifyChangeForCheckpoint(change, { isSessionMessagesLoaded: () => false }))
            .toMatchObject({ decision: 'critical', plannerOwner: 'discussions', snapshotDomain: 'discussions-level-triggered' });
    });

    it('plans Machine Pool projection materialization before checkpointing its change', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 8, kind: 'machinePool', entityId: 'pool-a' }),
        ]);

        expect(planned.invalidate.machinePools).toBe(true);
        expect(classifyChangeForCheckpoint(planned.changes[0]!, {
            isSessionMessagesLoaded: () => false,
        })).toMatchObject({
            decision: 'critical',
            plannerOwner: 'machine-pools',
            snapshotDomain: 'machine-pools',
            materializationProof: 'machine-pools',
        });
    });

    it('classifies every session shell change as critical regardless of transcript load state', () => {
        const loaded = classifyChangeForCheckpoint(
            buildChange({ cursor: 1, kind: 'session', entityId: 'loaded' }),
            { isSessionMessagesLoaded: (sessionId) => sessionId === 'loaded' },
        );
        const unloaded = classifyChangeForCheckpoint(
            buildChange({ cursor: 2, kind: 'session', entityId: 'unloaded' }),
            { isSessionMessagesLoaded: () => false },
        );

        expect(loaded.decision).toBe('critical');
        expect(unloaded.decision).toBe('critical');
    });

    it('plans automation invalidation when automation change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'automation', entityId: 'a1' }),
        ]);

        expect(planned.invalidate.automations).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);
    });

    it('plans account pet invalidation when pet change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'pet', entityId: 'pet-1' }),
        ]);

        expect(planned.invalidate.pets).toBe(true);
        expect(planned.invalidate.settings).toBe(false);
    });

    it('plans deduplicated KV keys and upgrades to full refresh when any KV change requires it', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'kv',
                hint: { keys: ['todo.b', '', 'todo.a', 'todo.b'] },
            }),
            buildChange({
                cursor: 2,
                kind: 'kv',
                hint: ['not-a-record'] as unknown as ApiChangeEntry['hint'],
            }),
        ]);

        expect(planned.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });
    });
});
