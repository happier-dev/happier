import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
    ChangeEntrySchema,
    ChangeKindSchema,
    TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
} from '@happier-dev/protocol/changes';
import {
    CHANGE_CHECKPOINT_COVERAGE,
    classifyChangeForCheckpoint,
    planSyncActionsFromChanges,
    plannedChangesAffectSessionListQuery,
} from './changesPlanner';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { buildProfilePhysicalKey, PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, PROFILE_TRANSFER_ACCOUNT_KV_KEY } from '@happier-dev/protocol/profiles/profileRecordV1';
import * as changePlanner from './changesPlanner';

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

describe('planSyncActionsFromChanges', () => {
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

    it('routes an exact workflow Run change to its canonical body refresh without broad Account invalidation', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'account', entityId: 'workflow-run:run-42' }),
        ]);

        expect(planned.workflowRunIdsToRefresh).toEqual(['run-42']);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
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
            buildChange({ cursor: 1, kind: 'session', entityId: 'listed-message', hint: { lastMessageSeq: 5, lastMessageId: 'm5' } }),
            // Metadata, agent-state and runtime-activity writes carry no hint.
            buildChange({ cursor: 2, kind: 'session', entityId: 'listed-metadata' }),
            buildChange({ cursor: 3, kind: 'session', entityId: 'listed-pending', hint: { pendingVersion: 3, pendingCount: 1 } }),
        ], { isSessionListMember: (sessionId) => listed.has(sessionId) });

        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionRowRefreshIds).toEqual(['listed-message', 'listed-metadata', 'listed-pending']);
        expect(planned.sessionIdsToCatchUp).toEqual(['listed-message', 'listed-metadata', 'listed-pending']);
        // Ordinary-answerable corpora are unaffected; a structural filter may still move.
        expect(plannedChangesAffectSessionListQuery(planned)).toBe('structural');
    });

    it('keeps one list refresh for changes that can alter which Sessions are listed', () => {
        const listed = new Set(['listed-archived', 'listed-deleted', 'listed-shared', 'listed-responsible']);
        const cases = [
            buildChange({ cursor: 1, kind: 'session', entityId: 'unlisted', hint: { lastMessageSeq: 1, lastMessageId: 'm1' } }),
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
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                hint: { ...(epoch === 1 ? { v: 1, sessionDraft: true } : { v: 2, sessionDraftV2: true }), address, revision: 2, status: 'present' },
            }),
        ]);

        expect(planned.sessionDraftAddresses).toEqual([address]);
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
