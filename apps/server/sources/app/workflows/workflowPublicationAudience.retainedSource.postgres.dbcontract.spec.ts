import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { updateAutomationTrigger } from '@/app/automations/automationCrudService';
import { createAutomationSessionLifecycleFixtureFields } from '@/testkit/automationSessionLifecycleFixture';
import {
  createDbMaintenanceClient,
  onDbClientQuery,
  type PrismaClientType,
} from '@/storage/prisma';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')(
  'Workflow publication audience for retained lifecycle sources (PostgreSQL)',
  () => {
    const queries: Prisma.QueryEvent[] = [];
    let client: PrismaClientType;
    let originalTransaction: typeof db.$transaction;

    beforeAll(async () => {
      if (
        !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL ||
        process.env.DATABASE_URL !==
          process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
      ) {
        throw new Error('Use the disposable PostgreSQL DB-contract harness');
      }
      initDbPostgres();
      await db.$connect();
      client = await createDbMaintenanceClient('postgres', undefined, {
        log: [{ emit: 'event', level: 'query' }],
      });
      onDbClientQuery(client, (event) => queries.push(event));
      await client.$connect();
      originalTransaction = db.$transaction;
      // Observe actual SQL; the CRUD transaction, audience owner and locks stay real.
      db.$transaction = new Proxy(originalTransaction, {
        apply(_target, _receiver, args) {
          return Reflect.apply(client.$transaction, client, args);
        },
      });
    });

    afterAll(async () => {
      if (originalTransaction) db.$transaction = originalTransaction;
      await client?.$disconnect();
      await shutdownDbClient();
    });

    function lockedIds(
      table: 'Account' | 'AutomationRun' | 'Session',
    ): Set<string> {
      return new Set(
        queries.flatMap((event) =>
          event.query.includes(`FROM "${table}"`) &&
          / FOR (?:NO KEY )?UPDATE/.test(event.query)
            ? (JSON.parse(event.params) as unknown[])
                .flat()
                .filter((value): value is string => typeof value === 'string')
            : [],
        ),
      );
    }

    it('locks a retained Run-lifecycle source and admits its owner when the watcher trigger is disabled', async () => {
      const [watcherOwner, sourceOwner] = await Promise.all(
        [0, 1].map(() =>
          db.account.create({ data: { encryptionMode: 'plain' } }),
        ),
      );
      const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({
        v: 2,
        templateVersion: 1,
        triggerEvidence: null,
        workflow: {
          t: 'plain',
          v: {
            workspace: { directory: '/repo' },
            executionTarget: { kind: 'session' },
            inlineDefinition: {
              version: 1,
              blocks: [
                {
                  kind: 'action',
                  id: 'notice',
                  actionId: 'notifications.notify_me',
                  input: {
                    message: { kind: 'literal', value: 'Run finished' },
                  },
                },
              ],
            },
          },
        },
      });
      if (recipe.kind !== 'available')
        throw new Error('Workflow watcher recipe unavailable');
      const machine = await db.machine.create({
        data: { id: randomUUID(), accountId: watcherOwner.id, metadata: '{}' },
      });
      const watcher = await db.automation.create({
        data: {
          accountId: watcherOwner.id,
          name: 'Watcher',
          enabled: true,
          templateCiphertext: recipe.serialized,
          templateVersion: 1,
        },
      });
      await db.automationAssignment.create({
        data: {
          automationId: watcher.id,
          machineId: machine.id,
          enabled: true,
        },
      });
      const sourceRun = await db.automationRun.create({
        data: {
          id: randomUUID(),
          accountId: sourceOwner.id,
          originKind: 'direct',
          causeKind: null,
          state: 'queued',
          workflowCustodyState: 'pending',
          workflowAcceptedSnapshotEnvelope: '{}',
          scheduledAt: new Date(),
          dueAt: new Date(),
        },
      });
      const trigger = await db.automationTrigger.create({
        data: {
          automationId: watcher.id,
          kind: 'runLifecycle',
          enabled: true,
          sourceRunId: sourceRun.id,
          remainingOccurrences: 1,
          runLifecycleConfigurationJson: JSON.stringify({
            kind: 'runLifecycle',
            source: { kind: 'workflow_run', runId: sourceRun.id },
            condition: 'terminal',
          }),
        },
      });

      queries.length = 0;
      // A disable patch names no requested source; only the retained trigger row reaches this Run.
      await updateAutomationTrigger({
        accountId: watcherOwner.id,
        automationId: watcher.id,
        triggerId: trigger.id,
        expectedRevision: 0,
        enabled: false,
      });

      expect(
        await db.automationTrigger.findUniqueOrThrow({
          where: { id: trigger.id },
        }),
      ).toMatchObject({ enabled: false });
      expect(lockedIds('AutomationRun')).toContain(sourceRun.id);
      expect(lockedIds('Account')).toContain(sourceOwner.id);
    });

    it('locks a retained Session-lifecycle source without admitting another Account when the trigger is disabled', async () => {
      const [owner, outsider] = await Promise.all(
        [0, 1].map(() =>
          db.account.create({ data: { encryptionMode: 'plain' } }),
        ),
      );
      const sourceSession = await db.session.create({
        data: {
          accountId: owner.id,
          tag: randomUUID(),
          encryptionMode: 'plain',
          metadata: '{}',
        },
      });
      const automation = await db.automation.create({
        data: {
          accountId: owner.id,
          name: 'Session watcher',
          enabled: true,
          templateCiphertext: '{}',
          templateVersion: 1,
        },
      });
      const trigger = await db.automationTrigger.create({
        data: {
          automationId: automation.id,
          kind: 'sessionLifecycle',
          enabled: true,
          ...(await createAutomationSessionLifecycleFixtureFields({
            automationId: automation.id,
            kind: 'sessionLifecycle',
            sourceSessionId: sourceSession.id,
            events: ['parentTurnCompleted'],
            // Only a currentTurn trigger retains its exact source Session witness.
            policy: { kind: 'currentTurn', sourceTurnId: randomUUID() },
          })),
        },
      });

      queries.length = 0;
      // The disable patch names no source; only the retained trigger row names this Session.
      await updateAutomationTrigger({
        accountId: owner.id,
        automationId: automation.id,
        triggerId: trigger.id,
        expectedRevision: trigger.revision,
        enabled: false,
      });

      expect(
        await db.automationTrigger.findUniqueOrThrow({
          where: { id: trigger.id },
        }),
      ).toMatchObject({ enabled: false });
      expect(lockedIds('Session')).toContain(sourceSession.id);
      expect([...lockedIds('Account')]).toEqual([owner.id]);
      expect(lockedIds('Account')).not.toContain(outsider.id);
    });
  },
);
