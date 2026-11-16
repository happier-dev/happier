import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { applySqliteMigrations } from '../prismaMigrations';

const serverRoot = join(import.meta.dirname, '../..');
const migrationId = '20261116195000_automation_subject_action_projection_final';

describe('Automation subject and Action structural migration', () => {
    it('preserves retained SQLite rows and constraints while admitting matching and consent Action arms', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'automation-subject-migration-'));
        const migrationsDir = join(scratch, 'migrations');
        const root = join(serverRoot, 'prisma/sqlite/migrations');
        const baseline = (await readdir(root)).filter(name => name < migrationId);
        let database: DatabaseSync | undefined;
        try {
            for (const name of baseline) await cp(join(root, name), join(migrationsDir, name), { recursive: true });
            const databasePath = join(scratch, 'baseline.sqlite');
            await applySqliteMigrations({ databasePath, migrationsDir });
            database = new DatabaseSync(databasePath);
            const finalMigration = join(root, migrationId);
            // A retained currentTurn row deliberately predates public subject digests.
            database.exec(`
                PRAGMA foreign_keys=ON;
                INSERT INTO "Account" ("id","updatedAt") VALUES ('account',CURRENT_TIMESTAMP);
                INSERT INTO "Automation" ("id","accountId","name","templateCiphertext","updatedAt")
                    VALUES ('automation','account','retained','opaque workflow',CURRENT_TIMESTAMP);
                INSERT INTO "AutomationTrigger" ("id","automationId","kind","scheduleKind","everyMs","updatedAt")
                    VALUES ('interval','automation','schedule','interval',60000,CURRENT_TIMESTAMP);
                INSERT INTO "AutomationTrigger" ("id","automationId","kind","scheduleKind","scheduledAt","remainingOccurrences","updatedAt")
                    VALUES ('once','automation','schedule','once','2026-11-01',0,CURRENT_TIMESTAMP);
                INSERT INTO "AutomationTrigger" ("id","automationId","kind","sessionLifecycleEventsJson",
                    "sessionLifecyclePolicyKind","sourceSessionId","sourceTurnId","remainingOccurrences","updatedAt")
                    VALUES ('turn','automation','sessionLifecycle','["parentTurnCompleted"]','currentTurn','session','turn',1,CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" ("id","accountId","automationId","state","causeKind","causeOccurredAt",
                    "resultEnvelopeBytes","workflowCheckpointEnvelopeBytes","originDiscussionId","scheduledAt","dueAt","updatedAt")
                    VALUES ('historical','account','automation','succeeded','manual',CURRENT_TIMESTAMP,
                        X'0001FF',X'FF0002','retained-discussion',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRunEvent" ("id","runId","type") VALUES ('event','historical','succeeded');
                INSERT INTO "WorkflowRunInvocation" ("id","runId","sequence","memberOrdinal","contentEnvelope","updatedAt")
                    VALUES ('invocation','historical',0,0,'opaque invocation',CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" ("id","accountId","originKind","causeKind","state",
                    "workflowAcceptedSnapshotEnvelope","workflowCustodyState","scheduledAt","dueAt","updatedAt")
                    VALUES ('direct','account','direct',NULL,'queued','opaque accepted snapshot','pending',
                        CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
            `);
            const rowsBefore = ['AutomationTrigger', 'AutomationRun', 'AutomationRunEvent', 'WorkflowRunInvocation'].map(table => ({
                table, rows: database!.prepare(`SELECT * FROM "${table}" ORDER BY id`).all(),
            }));
            const indexesBefore = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('AutomationTrigger','AutomationRun') ORDER BY name").all();
            const foreignKeysBefore = ['AutomationTrigger', 'AutomationRun'].map(table => database!.prepare(`PRAGMA foreign_key_list("${table}")`).all());
            database.close();
            database = undefined;
            // Missing FINAL migration is the initial RED, before any SQL is landed.
            await readFile(join(finalMigration, 'migration.sql'), 'utf8');
            await cp(finalMigration, join(migrationsDir, migrationId), { recursive: true });
            expect((await applySqliteMigrations({ databasePath, migrationsDir })).applied).toEqual([migrationId]);
            database = new DatabaseSync(databasePath);
            database.exec('PRAGMA foreign_keys=ON');
            for (const { table, rows } of rowsBefore) {
                const columns = Object.keys(rows[0]!).map(name => `"${name}"`).join(',');
                expect(database.prepare(`SELECT ${columns} FROM "${table}" ORDER BY id`).all()).toEqual(rows);
            }
            const indexesAfter = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('AutomationTrigger','AutomationRun') ORDER BY name").all();
            for (const index of indexesBefore) expect(indexesAfter).toContainEqual(index);
            expect(['AutomationTrigger', 'AutomationRun'].map(table => database!.prepare(`PRAGMA foreign_key_list("${table}")`).all())).toEqual(foreignKeysBefore);

            const insert = (table: string, values: Readonly<Record<string, string | number | null>>) => {
                const names = Object.keys(values);
                database!.prepare(`INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(values));
            };
            const trigger = { automationId: 'automation', kind: 'action', updatedAt: '2026-11-16',
                definitionEnvelope: 'opaque private definition', actionIdsJson: '["session.stop"]', actionId: 'session.stop', phase: 'after' };
            insert('AutomationTrigger', { ...trigger, id: 'action' });
            insert('AutomationTrigger', { ...trigger, id: 'before', phase: 'before', mode: 'wait', onFailure: 'ask' });
            insert('AutomationTrigger', { id: 'consent', automationId: 'automation', kind: 'action', updatedAt: '2026-11-16',
                consentForAutomationId: 'shared', consentForTriggerId: 'shared-trigger', consentedWorkflowRevision: 9 });
            for (const invalid of [
                { definitionEnvelope: null }, { actionIdsJson: '[]' }, { actionIdsJson: '{}' },
                { phase: null }, { mode: 'wait' }, { subjectKind: 'machine' },
                { consentForAutomationId: 'shared', consentForTriggerId: 'shared-trigger', consentedWorkflowRevision: 9 },
                { phase: 'before', mode: 'notify', onFailure: 'refuse' }, { sourceSessionId: 'private-session' },
            ]) expect(() => insert('AutomationTrigger', { ...trigger, ...invalid, id: 'invalid' })).toThrow();
            expect(() => insert('AutomationTrigger', { id: 'partial-consent', automationId: 'automation', kind: 'action', updatedAt: '2026-11-16',
                consentForAutomationId: 'shared', consentedWorkflowRevision: 9 })).toThrow();
            const sessionTrigger = { id: 'broad', automationId: 'automation', kind: 'sessionLifecycle', updatedAt: '2026-11-16',
                sessionLifecycleEventsJson: '["parentTurnCompleted"]', sessionLifecyclePolicyKind: 'everyMatch',
                subjectKind: 'machine', subjectKey: 'opaque-subject-digest', definitionEnvelope: 'encrypted private definition' };
            insert('AutomationTrigger', sessionTrigger);
            expect(() => insert('AutomationTrigger', { ...sessionTrigger, id: 'invalid-turn', sessionLifecyclePolicyKind: 'currentTurn',
                sourceSessionId: 'session', sourceTurnId: 'turn', remainingOccurrences: 1 })).toThrow();

            const actionRun = { id: 'action-run', automationId: 'automation', accountId: 'account', state: 'succeeded',
                causeKind: 'trigger', causeTriggerKind: 'action', triggerId: 'action', causeTriggerRevision: 0,
                causeOccurredAt: '2026-11-16', occurrenceKey: 'action-occurrence', causeActionEvidenceJson: '{"actionId":"session.stop","requestId":"request","phase":"after","status":"succeeded"}',
                scheduledAt: '2026-11-16', dueAt: '2026-11-16', updatedAt: '2026-11-16' };
            insert('AutomationRun', actionRun);
            for (const invalid of [{ causeActionEvidenceJson: null }, { causeActionEvidenceJson: '[]' },
                { causeSourceSessionId: 'private-session' }, { triggerEvidenceEnvelope: '{}' }, { causeTriggerKind: 'schedule' }, { causeTriggerKind: null },
            ]) expect(() => insert('AutomationRun', { ...actionRun, ...invalid, id: 'invalid-run', occurrenceKey: 'invalid-occurrence' })).toThrow();
            const presenceRun = { ...actionRun, id: 'presence-run', occurrenceKey: 'presence-occurrence',
                causeTriggerKind: 'pluginEvent', causeActionEvidenceJson: null,
                causeEventPluginId: 'happier.machine.services', causeEventLocalId: 'machine-offline', causeSourceSelectorId: 'presence-source',
                causePluginEventEvidenceJson: '{"kind":"machinePresence","payload":{"serverId":"home","machineId":"machine","transition":"offline","revision":1,"observedAt":1}}' };
            insert('AutomationRun', presenceRun);
            for (const invalid of [{ causeEventPluginId: 'other-plugin' }, { causeEventPluginId: null },
                { causeEventLocalId: 'other-event' }, { causeSourceSelectorId: null }, { causeTriggerKind: null },
                { triggerEvidenceEnvelope: '{"t":"encrypted","c":"private"}' }, { causeActionEvidenceJson: '{}' },
            ]) expect(() => insert('AutomationRun', { ...presenceRun, ...invalid, id: 'invalid-public-run', occurrenceKey: 'invalid-public-occurrence' })).toThrow();
            expect(() => database!.exec('UPDATE "AutomationRun" SET "causeActionEvidenceJson"=\'{}\' WHERE "id"=\'direct\'' )).toThrow();
            expect(() => database!.exec('UPDATE "AutomationTrigger" SET "deletedAt"=CURRENT_TIMESTAMP,"enabled"=false WHERE "id"=\'action\'' )).toThrow();
            database.exec(`UPDATE "AutomationTrigger" SET "deletedAt"=CURRENT_TIMESTAMP,"enabled"=false,
                "definitionEnvelope"=NULL,"actionId"=NULL,"actionIdsJson"=NULL,"phase"=NULL WHERE "id"='action'`);
            expect(database.prepare('SELECT count(*) AS count FROM "AutomationRun" WHERE "id"=\'action-run\'').get()).toEqual({ count: 1 });
            expect(() => database!.exec('DELETE FROM "Automation" WHERE "id"=\'automation\'')).toThrow();
            expect(() => database!.exec('UPDATE "AutomationRun" SET "state"=\'invalid\' WHERE "id"=\'historical\'')).toThrow();
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(database.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
            database.close();
            database = undefined;
            expect((await applySqliteMigrations({ databasePath, migrationsDir })).applied).toEqual([]);
        } finally {
            database?.close();
            await rm(scratch, { recursive: true, force: true });
        }
    }, 120_000);
});
