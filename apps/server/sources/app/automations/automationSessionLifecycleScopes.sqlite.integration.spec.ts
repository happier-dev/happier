import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectAutomationSessionLifecycleStructuralTrigger, type AutomationSessionLifecycleTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { projectAutomationSessionLifecycleLaunchProfileId } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { serializeAutomationStoredDefinitionExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { getSessionLifecycleAutomationPublicationAudienceInTx } from '@/app/workflows/workflowPublicationAudience';
import { prepareLayout1SessionCreate } from '@/app/session/create/prepareLayout1SessionCreate';
import { createOrRejoinLayout1SessionByTagInTx } from '@/app/session/create/createOrRejoinLayout1SessionByTag';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { admitSessionLifecycleAutomationRunsTx } from './automationSessionLifecycleAdmission';
import { encodeAutomationSessionLifecycleConfiguration } from './automationSessionLifecycleConfigurationCodec';
import { updateAutomationTrigger } from './automationCrudService';
import { listAutomationAttachedTriggers } from './automationAttachedTriggerQuery';

const serverId = 'srv_00000000000000000000000000000000';
const authentication = createPresentUserSessionAccessAuthentication();

describe('Session lifecycle scoped admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-session-scopes-', initAuth: true, initEncrypt: false, initFiles: false,
    }); }, 120_000);
    beforeEach(() => harness.resetEnv({ HAPPIER_SERVER_IDENTITY_ID: serverId }));
    afterAll(async () => { if (harness) await harness.close(); });

    async function owner() {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        return { accountId: account.id, machineId: machine.id };
    }

    async function habit(current: Awaited<ReturnType<typeof owner>>, definition: AutomationSessionLifecycleTrigger,
        options: Readonly<{ enabled?: boolean; assigned?: boolean; legacy?: boolean }> = {}) {
        const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1({ v: 1, templateVersion: 1,
            template: { t: 'plain', v: { v: 1, prompt: 'React to the Session fact' } }, triggerEvidence: null,
            target: { kind: 'newSession', spawn: { executionTarget: { serverId, machineId: current.machineId },
                directory: { kind: 'path', path: '/tmp/session-scopes' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } },
        });
        if (recipe.kind !== 'available') throw new Error(recipe.kind);
        const automation = await db.automation.create({ data: { accountId: current.accountId, name: 'Session habit',
            enabled: options.enabled ?? true, targetType: 'new_session', templateCiphertext: recipe.serialized, templateVersion: 1 } });
        if (options.assigned !== false) await db.automationAssignment.create({ data: {
            automationId: automation.id, machineId: current.machineId, enabled: true,
        } });
        const id = randomUUID();
        const trigger = await db.automationTrigger.create({ data: { id, automationId: automation.id, kind: 'sessionLifecycle',
            enabled: true, revision: 1, ...encodeAutomationSessionLifecycleConfiguration(
                projectAutomationSessionLifecycleStructuralTrigger(definition)),
            definitionEnvelope: options.legacy ? null : JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, automationId: automation.id, triggerId: id, triggerRevision: 1, triggerKind: 'sessionLifecycle' },
                definition,
            })),
        } });
        return { automation, trigger };
    }

    async function birth(accountId: string, tag: string) {
        const prepared = prepareLayout1SessionCreate({ accountId, tag, metadata: '{"v":1}',
            ownerMetadata: { t: 'plain', v: { v: 1 } }, agentState: null, dataEncryptionKey: null,
            requestedEncryptionMode: undefined, requestedStorageState: undefined, organizationPlacement: undefined,
            accountEncryptionMode: 'plain', storagePolicy: 'optional', defaultAccountMode: 'plain',
        });
        if (!prepared.ok) throw new Error(prepared.rejection.reason);
        return inTx(tx => createOrRejoinLayout1SessionByTagInTx(tx, prepared.prepared, authentication));
    }

    it('includes Account habits once as inherited context without exposing another Account habits', async () => {
        const current = await owner();
        const stranger = await owner();
        const sourceId = randomUUID();
        const subject = { kind: 'session' as const, serverId, sessionId: sourceId };
        const broad: AutomationSessionLifecycleTrigger = {
            kind: 'sessionLifecycle', events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' },
        };
        const inherited = await habit(current, broad);
        const direct = await habit(current, { ...broad, subject });
        await habit(stranger, broad);
        const page = await listAutomationAttachedTriggers({ accountId: current.accountId, subject,
            contextSubjects: [subject] });
        expect(page.attached.map(row => ({ triggerId: row.triggerId, relation: row.relation })))
            .toEqual(expect.arrayContaining([
                { triggerId: inherited.trigger.id, relation: 'context' },
                { triggerId: direct.trigger.id, relation: 'direct' },
            ]));
        expect(page.attached).toHaveLength(2);
    });

    it('filters Account habits before admission and bounded consumption using one published turn fact', async () => {
        const current = await owner();
        const definition: AutomationSessionLifecycleTrigger = {
            kind: 'sessionLifecycle', events: ['parentTurnCompleted'], policy: { kind: 'firstMatch' },
            filter: { v: 1, all: [
                { field: '/launchProfileId', op: 'eq', value: 'profile-selected' },
                { field: '/changedFiles', op: 'eq', value: true },
            ] },
        };
        const selected = await habit(current, definition);
        const other = await habit(current, { ...definition, filter: { v: 1, all: [
            { field: '/launchProfileId', op: 'eq', value: 'profile-other' },
            { field: '/changedFiles', op: 'eq', value: true },
        ] } });
        const structural = projectAutomationSessionLifecycleStructuralTrigger(definition);
        const profileClause = structural.filter?.all.find(clause => clause.field === '/launchProfileId');
        if (profileClause?.op !== 'eq' || typeof profileClause.value !== 'string') throw new Error('Missing structural profile filter');
        expect(selected.trigger.sessionLifecycleFilterJson).not.toContain('profile-selected');

        const session = await db.session.create({ data: { accountId: current.accountId,
            tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const observations = [
            undefined,
            { launchProfileId: profileClause.value, changedFiles: null },
            { launchProfileId: profileClause.value, changedFiles: false },
            { launchProfileId: profileClause.value, changedFiles: true },
        ];
        for (const [index, facts] of observations.entries()) {
            const turnId = randomUUID();
            await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation: {
                v: 1, action: 'begin', sessionId: session.id, turnId, mutationId: randomUUID(), observedAt: Date.now(),
                initiator: 'user',
            } });
            await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation: {
                v: 1, action: 'complete', sessionId: session.id, turnId, mutationId: randomUUID(), observedAt: Date.now(),
                ...(facts === undefined ? {} : { automationLifecycleFacts: facts }),
            } });
            expect(await db.automationRun.count({ where: { accountId: current.accountId } })).toBe(index === 3 ? 1 : 0);
            expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: selected.trigger.id } })).remainingOccurrences)
                .toBe(index === 3 ? 0 : 1);
        }
        expect(await db.automationRun.findMany({ where: { accountId: current.accountId }, select: { triggerId: true } }))
            .toEqual([{ triggerId: selected.trigger.id }]);
        expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: other.trigger.id } })).remainingOccurrences).toBe(1);
    });

    it('applies one Account habit once to each matching changed Session and never to clean or other-profile turns', async () => {
        const current = await owner();
        const selected = await habit(current, {
            kind: 'sessionLifecycle', events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' },
            filter: { v: 1, all: [
                { field: '/launchProfileId', op: 'eq', value: 'selected-profile' },
                { field: '/changedFiles', op: 'eq', value: true },
            ] },
        });
        const first = await db.session.create({ data: { accountId: current.accountId,
            tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const second = await db.session.create({ data: { accountId: current.accountId,
            tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const turns = [
            { session: first, profile: 'selected-profile', changedFiles: false, runs: 0 },
            { session: first, profile: 'selected-profile', changedFiles: true, runs: 1 },
            { session: second, profile: 'other-profile', changedFiles: true, runs: 1 },
            { session: second, profile: 'selected-profile', changedFiles: null, runs: 1 },
            { session: second, profile: 'selected-profile', changedFiles: false, runs: 1 },
            { session: second, profile: 'selected-profile', changedFiles: true, runs: 2 },
        ];
        for (const turn of turns) {
            const turnId = randomUUID();
            await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation: {
                v: 1, action: 'begin', sessionId: turn.session.id, turnId, mutationId: randomUUID(),
                observedAt: Date.now(), initiator: 'user',
            } });
            const mutation = { v: 1 as const, action: 'complete' as const, sessionId: turn.session.id, turnId,
                mutationId: randomUUID(), observedAt: Date.now(), automationLifecycleFacts: {
                    launchProfileId: projectAutomationSessionLifecycleLaunchProfileId(turn.profile), changedFiles: turn.changedFiles,
                } };
            await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation });
            await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation });
            expect(await db.automationRun.count({ where: { automationId: selected.automation.id } })).toBe(turn.runs);
        }
        const runs = await db.automationRun.findMany({ where: { automationId: selected.automation.id },
            select: { triggerId: true, causeSourceSessionId: true } });
        expect(runs).toHaveLength(2);
        expect(runs.map(run => run.triggerId)).toEqual([selected.trigger.id, selected.trigger.id]);
        expect(runs.map(run => run.causeSourceSessionId).sort()).toEqual([first.id, second.id].sort());
    });

    it.each([undefined, null, false])('retires a currentTurn habit when its terminal changed-files fact is %s', async (changedFiles) => {
        const current = await owner();
        const session = await db.session.create({ data: { accountId: current.accountId,
            tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const turnId = randomUUID();
        await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation: {
            v: 1, action: 'begin', sessionId: session.id, turnId, mutationId: randomUUID(), observedAt: Date.now(),
            initiator: 'user',
        } });
        const selected = await habit(current, {
            kind: 'sessionLifecycle', subject: { kind: 'session', serverId, sessionId: session.id },
            events: ['parentTurnCompleted'], policy: { kind: 'currentTurn', sourceTurnId: turnId },
            filter: { v: 1, all: [{ field: '/changedFiles', op: 'eq', value: true }] },
        });
        await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation: {
            v: 1, action: 'complete', sessionId: session.id, turnId, mutationId: randomUUID(), observedAt: Date.now(),
            ...(changedFiles === undefined ? {} : { automationLifecycleFacts: { changedFiles } }),
        } });
        expect(await db.automationRun.count({ where: { triggerId: selected.trigger.id } })).toBe(0);
        expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: selected.trigger.id } })).remainingOccurrences).toBe(0);
    });

    it('admits an ordinary NEW Session once and lets unrelated unavailable habits leave birth intact', async () => {
        const current = await owner();
        const definition: AutomationSessionLifecycleTrigger = { kind: 'sessionLifecycle', events: ['sessionStarted'], policy: { kind: 'everyMatch' } };
        const active = await habit(current, definition);
        await habit(current, definition, { enabled: false });
        await habit(current, definition, { assigned: false });
        await habit(current, definition, { legacy: true });
        const created = await birth(current.accountId, randomUUID());
        expect(created.kind).toBe('created');
        if (created.kind !== 'created') throw new Error(created.kind);
        expect(await db.automationRun.findMany({ where: { accountId: current.accountId }, select: { triggerId: true, causeSourceSessionId: true } }))
            .toEqual([{ triggerId: active.trigger.id, causeSourceSessionId: created.session.id }]);
        expect((await birth(current.accountId, created.session.tag)).kind).toBe('rejoined');
        expect(await db.automationRun.count({ where: { accountId: current.accountId } })).toBe(1);
    });

    it('matches Session, Project, retained Machine and omitted subjects through the same candidate owner', async () => {
        const current = await owner();
        const sourceId = randomUUID();
        const source = await db.session.create({ data: { id: sourceId, accountId: current.accountId, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', projectKey: 'project-one', archivedAt: new Date(),
            runtimeMachineTarget: { homeId: serverId, sessionId: sourceId, accountId: current.accountId,
                machineId: current.machineId, installationId: 'retained-installation' },
        } });
        const subjects = [undefined,
            { kind: 'session' as const, serverId, sessionId: source.id },
            { kind: 'project' as const, serverId, projectKey: source.projectKey! },
            { kind: 'machine' as const, serverId, machineId: current.machineId },
        ];
        const expected: string[] = [];
        for (const subject of subjects) expected.push((await habit(current, { kind: 'sessionLifecycle',
            ...(subject ? { subject } : {}), events: ['sessionArchived'], policy: { kind: 'everyMatch' } })).trigger.id);
        await habit(current, { kind: 'sessionLifecycle', subject: { kind: 'session', serverId, sessionId: randomUUID() },
            events: ['sessionArchived'], policy: { kind: 'everyMatch' } });
        await habit(current, { kind: 'sessionLifecycle', subject: { kind: 'project', serverId: 'other-home', projectKey: source.projectKey! },
            events: ['sessionArchived'], policy: { kind: 'everyMatch' } });
        await inTx(tx => admitSessionLifecycleAutomationRunsTx({ tx, accountId: current.accountId, sourceSession: source,
            recipientAccountIds: [current.accountId], occurrence: { v: 1, kind: 'sessionLifecycle', event: 'sessionArchived',
                sourceSessionId: source.id, occurredAt: source.archivedAt!.getTime() },
        }));
        expect((await db.automationRun.findMany({ where: { accountId: current.accountId }, select: { triggerId: true } }))
            .map(run => run.triggerId).sort()).toEqual(expected.sort());
    });

    it('reuses one candidate probe across prepublication and multiple admitted occurrences without losing a bounded match', async () => {
        const current = await owner();
        const source = await db.session.create({ data: { accountId: current.accountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const turnId = randomUUID();
        await applySessionTurnMutation({ actorUserId: current.accountId, authentication, mutation: {
            v: 1, sessionId: source.id, mutationId: randomUUID(), action: 'begin', turnId,
            observedAt: Date.now(), initiator: 'user', workDepth: 0,
        } });
        const active = await habit(current, { kind: 'sessionLifecycle', events: ['userActionRequired'], policy: { kind: 'nextMatches', count: 2 } });
        let probes = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (request.model === 'AutomationTrigger' && request.action === 'findMany') {
                const args = request.args as { where?: { kind?: unknown } };
                if (args.where?.kind === 'sessionLifecycle') probes += 1;
            }
        } });
        try {
            await inTx(async tx => {
                await getSessionLifecycleAutomationPublicationAudienceInTx(tx, [source.id]);
                for (const requestId of ['first-request', 'second-request']) await admitSessionLifecycleAutomationRunsTx({
                    tx, accountId: current.accountId, sourceSession: source, recipientAccountIds: [current.accountId],
                    occurrence: { v: 1, kind: 'sessionLifecycle', event: 'userActionRequired', sourceSessionId: source.id,
                        sourceTurnId: turnId, requestId, requestKind: 'permission', occurredAt: Date.now() },
                });
            });
        } finally { stop(); }
        expect(probes).toBe(1);
        expect(await db.automationRun.count({ where: { triggerId: active.trigger.id } })).toBe(2);
        expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: active.trigger.id } })).toMatchObject({ remainingOccurrences: 0 });
    });

    it('preserves a consumed first-match budget and an unbounded budget when selection changes', async () => {
        const current = await owner();
        const source = await db.session.create({ data: { accountId: current.accountId, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', projectKey: 'budget-project', archivedAt: new Date() } });
        const first = await habit(current, { kind: 'sessionLifecycle', events: ['sessionArchived'], policy: { kind: 'firstMatch' } });
        const every = await habit(current, { kind: 'sessionLifecycle', events: ['sessionArchived'], policy: { kind: 'everyMatch' } });
        await inTx(tx => admitSessionLifecycleAutomationRunsTx({ tx, accountId: current.accountId, sourceSession: source,
            recipientAccountIds: [current.accountId], occurrence: { v: 1, kind: 'sessionLifecycle', event: 'sessionArchived',
                sourceSessionId: source.id, occurredAt: source.archivedAt!.getTime() },
        }));
        for (const [attached, policy, remainingOccurrences] of [
            [first, { kind: 'firstMatch' }, 0], [every, { kind: 'everyMatch' }, null],
        ] as const) {
            await updateAutomationTrigger({ accountId: current.accountId, automationId: attached.automation.id,
                triggerId: attached.trigger.id, expectedRevision: attached.trigger.revision,
                trigger: { kind: 'sessionLifecycle', subject: { kind: 'project', serverId, projectKey: source.projectKey! },
                    events: ['sessionArchived'], policy },
            });
            expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: attached.trigger.id } }))
                .toMatchObject({ remainingOccurrences, subjectKind: 'project', sourceSessionId: null });
        }
    });

    it('partitions lifecycle candidates once rather than rescanning all rows for each Account', async () => {
        const current = await owner();
        const source = await db.session.create({ data: { accountId: current.accountId, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', archivedAt: new Date() } });
        const recipients = [current.accountId];
        const triggerIds = new Set<string>();
        for (let account = 0; account < 4; account += 1) {
            const recipient = await owner();
            recipients.push(recipient.accountId);
            for (let trigger = 0; trigger < 2; trigger += 1) triggerIds.add((await habit(recipient, {
                kind: 'sessionLifecycle', events: ['sessionArchived'], policy: { kind: 'everyMatch' },
            }, { enabled: false })).trigger.id);
        }
        let accountReads = 0;
        const visited = new Set<string>();
        let finish!: () => void;
        const allCandidatesVisited = new Promise<void>(resolve => { finish = resolve; });
        // Instrument the final real database response, after Prisma decoding;
        // all candidate, visibility, transaction and admission owners stay real.
        expect(await inTx(tx => {
            const measuredDelegate = new Proxy(tx.automationTrigger, { get: (delegate, key) => {
                if (key !== 'findMany') return Reflect.get(delegate, key);
                return async (...args: Parameters<typeof delegate.findMany>) => {
                    const rows = await delegate.findMany(...args);
                    for (const row of rows) {
                        const automation: unknown = Reflect.get(row, 'automation');
                        if (!triggerIds.has(row.id) || !automation || typeof automation !== 'object') continue;
                        const accountId: unknown = Reflect.get(automation, 'accountId');
                        const enabled: unknown = Reflect.get(automation, 'enabled');
                        Object.defineProperties(automation, {
                            accountId: { configurable: true, get: () => { accountReads += 1; return accountId; } },
                            enabled: { configurable: true, get: () => {
                                visited.add(row.id);
                                if (visited.size === triggerIds.size) finish();
                                return enabled;
                            } },
                        });
                    }
                    return rows;
                };
            } });
            const measuredTx = new Proxy(tx, { get: (target, key) =>
                key === 'automationTrigger' ? measuredDelegate : Reflect.get(target, key) });
            return admitSessionLifecycleAutomationRunsTx({ tx: measuredTx, accountId: current.accountId,
                sourceSession: source, recipientAccountIds: recipients, occurrence: { v: 1,
                    kind: 'sessionLifecycle', event: 'sessionArchived', sourceSessionId: source.id,
                    occurredAt: source.archivedAt!.getTime() },
            });
        })).toEqual([]);
        await allCandidatesVisited;
        // Let the last recipient's existing writer transaction finish before
        // this fixture can close its database.
        await inTx(async () => undefined);
        expect(visited.size).toBe(triggerIds.size);
        expect(accountReads).toBe(triggerIds.size);
        expect(await db.automationRun.count({ where: { triggerId: { in: [...triggerIds] } } })).toBe(0);
    });

    it('performs no additional source ACL work for an empty candidate bucket', async () => {
        const current = await owner();
        const source = await db.session.create({ data: { accountId: current.accountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const models: string[] = [];
        const stop = observeSqliteRequests({ before: request => { if (request.model) models.push(request.model); } });
        try {
            expect(await inTx(tx => admitSessionLifecycleAutomationRunsTx({ tx, accountId: current.accountId,
                sourceSession: source, recipientAccountIds: [current.accountId], occurrence: { v: 1,
                    kind: 'sessionLifecycle', event: 'sessionStarted', sourceSessionId: source.id, occurredAt: source.createdAt.getTime() },
            }))).toEqual([]);
        } finally { stop(); }
        expect(models.filter(model => model === 'AutomationTrigger')).toHaveLength(1);
        expect(models.filter(model => model !== 'AutomationTrigger' && model !== 'SimpleCache')).toEqual([]);
    });
});
