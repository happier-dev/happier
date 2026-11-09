import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { PROVIDER_BROKER_ROUTE_AUDIENCE_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { signProviderBrokerRouteGrantV1, verifyProviderBrokerRouteGrantSignatureV1 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { authorizeTeamCredentialProviderModelCatalog, openTeamCredentialProviderBroker } from './providerBrokerAdmission';
import { writeSessionTeamCredentialBindingsInTx } from './sessionBinding';
import { createPlannedSessionTeamCredentialFixture, TEST_AUTHENTICATION } from './sessionBinding.testkit';
import { resolveTeamCredentialBrokerPlacementFingerprint } from './brokerPlacementResolver';
import { openAccountConnectionProviderBroker, admitAccountConnectionProviderBroker } from '@/app/providers/providerBrokerAdmission';
import { verifyProviderBrokerRouteGrantSignatureV2 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { applyMachineReplacement, clearMachineReplacement } from '@/app/machines/applyMachineReplacement';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Granted broker initiator (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    it('replaces only the cutover Session witness set and validates before deleting on PostgreSQL', async () => {
        vi.stubEnv('HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED', '1');
        const fixture = await createPlannedSessionTeamCredentialFixture('personal_allowed');
        const session = await db.session.create({ data: { accountId: fixture.creator.id, tag: randomUUID(), metadata: '{}' } });
        const other = await db.session.create({ data: { accountId: fixture.creator.id, tag: randomUUID(), metadata: '{}' } });
        const intent = { v: 1, slot: { kind: 'provider_model' }, resourceId: fixture.resource.id,
            expectedResourceRevision: fixture.resource.revision, deliveryMode: 'brokered' } as const;
        try {
            for (const sessionId of [session.id, other.id]) {
                await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                    sessionId, accountId: fixture.creator.id, authentication: TEST_AUTHENTICATION, intents: [intent],
                }))).resolves.toEqual({ ok: true });
            }
            const replace = (intents: unknown) => inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                sessionId: session.id, accountId: fixture.creator.id, authentication: TEST_AUTHENTICATION,
                replaceExisting: true, intents,
            }));
            expect(await replace([{ ...intent, expectedResourceRevision: fixture.resource.revision + 1 }])).toMatchObject({ ok: false });
            await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(1);
            await expect(replace([])).resolves.toEqual({ ok: true });
            await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
            await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: other.id } })).resolves.toBe(1);
        } finally {
            await db.session.deleteMany({ where: { id: { in: [session.id, other.id] } } });
            await db.team.delete({ where: { id: fixture.team.id } });
            await db.machine.delete({ where: { id: fixture.broker.id } });
            await db.account.deleteMany({ where: { id: { in: [fixture.creator.id, fixture.custodian.id] } } });
            vi.unstubAllEnvs();
        }
    });

    it('authorizes the foreign endpoint through current Use admission, then refuses its retained grant after revocation', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const resourceCustodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Granted broker ${randomUUID()}` } });
        try {
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: requester.id, role: 'member' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: resourceCustodian.id, role: 'owner' } });
            const worker = await db.machine.create({ data: {
                id: randomUUID(), accountId: custodian.id, installationId: randomUUID(), active: true,
                metadata: encodePlainMachineStoredContent({ host: 'worker', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
                operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: '1'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const broker = await db.machine.create({ data: {
                id: randomUUID(), accountId: resourceCustodian.id, metadata: '{}', active: true,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: '2'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            await expect(inTx(tx => setMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: worker.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view',
            }))).resolves.toMatchObject({ kind: 'saved', readiness: 'ready' });
            const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: '{}', active: true } });
            await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                accountId: requester.id, machineId: worker.id, sessionId: session.id, data: '{}',
            }))).resolves.toMatchObject({ ok: true, created: true });
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: resourceCustodian.id, displayName: 'Granted broker', enabled: true,
                disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', brokerMachineId: broker.id,
                sourceBindingJson: JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'pg-connection',
                    connectionSecurityFingerprint: 'connection-security:v1:pg-connection', credentialSlotId: 'apiKey' }),
                memberGrants: { create: { teamMembershipId: member.id, deliveryMode: 'brokered' } },
            } });
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                accountId: requester.id, sessionId: session.id,
                intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
                    expectedResourceRevision: resource.revision, deliveryMode: 'brokered', teamId: team.id }],
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [], tokenEpoch: requester.tokenEpoch },
            }))).resolves.toEqual({ ok: true });
            const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
            const authority = signProviderBrokerRouteGrantV1({ signingKey: { keyId: 'pg-home', secretKey: signing.secretKey }, payload: {
                v: 1, grantId: randomUUID(), aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V1, issuedAt: 1, expiresAt: 10_000,
                teamId: team.id, resourceId: resource.id, sourceRevision: 'source-revision-1',
                brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource), initiatorTokenEpoch: requester.tokenEpoch,
                initiator: { accountId: requester.id, machineId: worker.id, endpointId: '1'.repeat(64) },
                target: { custodianAccountId: resourceCustodian.id, machineId: broker.id, endpointId: '2'.repeat(64) },
                consumer: { kind: 'session', sessionId: session.id },
                application: { agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'openai-responses', protocol: 'openai-responses' },
            } });
            const read = () => authorizeTeamCredentialProviderModelCatalog({
                authenticatedBrokerAccountId: resourceCustodian.id, authority, expectedResourceRevision: resource.revision,
                readCurrentBrokerPresence: async () => ({ state: 'partial', machineIds: new Set([broker.id]) }),
                verifyAuthority: candidate => verifyProviderBrokerRouteGrantSignatureV1({ authority: candidate, nowMs: 1,
                    signingCapability: { keyId: 'pg-home', publicKey: Buffer.from(signing.publicKey).toString('base64url'), expiresAt: null } }),
            });
            expect(await read()).toEqual({ ok: true });
            const hub = await db.machine.create({ data: {
                id: randomUUID(), accountId: requester.id, metadata: '{}', active: true,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1, 2] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: '3'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const verifyAuthority = (candidate: unknown) => verifyProviderBrokerRouteGrantSignatureV2({ authority: candidate, nowMs: 1,
                signingCapability: { keyId: 'pg-home', publicKey: Buffer.from(signing.publicKey).toString('base64url'), expiresAt: null } });
            let presenceReads = 0;
            const common = { homeId: 'pg-home', actorAccountId: requester.id,
                readCurrentPresence: async () => {
                    presenceReads += 1;
                    return { initiatorPresence: { state: 'partial' as const, machineIds: new Set([worker.id]) },
                        targetPresence: { state: 'partial' as const, machineIds: new Set([hub.id]) } };
                },
                resolveExecutionRunCurrentness: async () => ({ ok: true as const, parentSessionId: null, occurrenceId: 'pg-run-occurrence' }) };
            const personalAuthorities = [];
            const originalTransaction = db.$transaction;
            const teamOpenInput = {
                actorAccountId: requester.id,
                authentication: { env: process.env, authority: 'present_user' as const,
                    authenticationEvidence: [], tokenEpoch: requester.tokenEpoch },
                request: { v: 1 as const, resourceId: resource.id, expectedResourceRevision: resource.revision,
                    modelId: 'model-1', sourceRevision: 'source-revision-1', initiatorMachineId: worker.id,
                    consumer: { kind: 'session' as const, sessionId: session.id }, application: authority.payload.application },
                nowMs: 1, grantId: randomUUID(), signingKey: { keyId: 'pg-home', secretKey: signing.secretKey },
                verifyRefreshAuthority: (candidate: typeof authority) => verifyProviderBrokerRouteGrantSignatureV1({
                    authority: candidate, nowMs: 1, signingCapability: { keyId: 'pg-home',
                        publicKey: Buffer.from(signing.publicKey).toString('base64url'), expiresAt: null } }),
                readCurrentPresence: async () => ({
                    initiatorPresence: { state: 'partial' as const, machineIds: new Set([worker.id]) },
                    brokerPresence: { state: 'partial' as const, machineIds: new Set([broker.id]) },
                }),
                readProviderProjection: async () => ({
                    status: 'success', agentTargetKey: authority.payload.application.agentTargetKey,
                    groups: [{ connectionId: 'pg-connection', providerName: 'CLIProxyAPI', connectionName: 'Work',
                        connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
                        sourceAuthority: { provider: { identity: authority.payload.application.implementationIdentity, definitionRevision: 1 },
                            connectionSecurityFingerprint: 'connection-security:v1:pg-connection' },
                        sourceRevision: 'source-revision-1', modelLoadAction: 'available', modelLoadPreflightPolicy: null,
                        authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: false,
                        suppressedConnectedServiceIds: [], rows: [{
                            ref: { agentTargetKey: authority.payload.application.agentTargetKey,
                                providerConnectionId: 'pg-connection', modelId: 'model-1' },
                            descriptor: { id: 'model-1', name: 'model-1' }, application: authority.payload.application,
                            sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                            compatibility: { result: { status: 'verified', selectedProtocol: 'openai-responses',
                                evidence: { sourceUrls: ['https://example.com/provider'], verifiedAt: '2026-09-10' } },
                                compatibilityFingerprint: 'compatibility:v1:current', confirmed: false },
                            endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
                        }] }],
                }),
            };
            const teamOpened = await openTeamCredentialProviderBroker(teamOpenInput);
            expect(teamOpened).toMatchObject({ ok: true });
            if (!teamOpened.ok) throw new Error(teamOpened.reasonCode);
            for (const operation of ['open', 'refresh'] as const) {
                let transactions = 0;
                let checked = false;
                const cohortQueries: unknown[][] = [];
                db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
                    const callback: unknown = args[0];
                    if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                    const final = ++transactions === 3;
                    const observed = new Proxy(callback, { apply(fn, context, callbackArgs) {
                        const native = callbackArgs[0];
                        const scheduled = new Proxy(native, { get(client, property) {
                            if (!final) return Reflect.get(client, property, client);
                            if (property === '$queryRawUnsafe') return async (...queryArgs: unknown[]) => {
                                const [query, ...values] = queryArgs;
                                if (typeof query === 'string' && query.includes('FROM "Account"') && query.includes(' FOR ')) {
                                    expect(query).toContain('ORDER BY "id" FOR NO KEY UPDATE');
                                    cohortQueries.push(values);
                                }
                                return Reflect.apply(client.$queryRawUnsafe, client, queryArgs);
                            };
                            // Session admission now reads Machine grant facts
                            // through the real exact AccessKey relation.
                            if (property !== 'accessKey') return Reflect.get(client, property, client);
                            return new Proxy(client.accessKey, { get(model, method) {
                                const query = Reflect.get(model, method, model);
                                if (method !== 'findUnique') return query;
                                return async (...queryArgs: unknown[]) => {
                                    const rows: unknown = await Reflect.apply(query, model, queryArgs);
                                    if (!checked) {
                                        for (const intent of ['NO KEY UPDATE', 'UPDATE']) {
                                            await expect(db.$queryRawUnsafe(
                                                `SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${intent} NOWAIT`, custodian.id,
                                            )).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
                                        }
                                        checked = true;
                                    }
                                    return rows;
                                };
                            } });
                        } });
                        return Reflect.apply(fn, context, [scheduled, ...callbackArgs.slice(1)]);
                    } });
                    return Reflect.apply(target, receiver, [observed, ...args.slice(1)]);
                } });
                try {
                    const opened = await openTeamCredentialProviderBroker({ ...teamOpenInput, request: { ...teamOpenInput.request,
                        ...(operation === 'refresh' ? { refreshAuthority: teamOpened.authority } : {}) } });
                    expect(opened).toMatchObject({ ok: true });
                    if (opened.ok) expect(teamOpenInput.verifyRefreshAuthority(opened.authority)).toBe(true);
                    expect(checked).toBe(true);
                    expect(cohortQueries).toEqual([[[requester.id, custodian.id, resourceCustodian.id].sort()]]);
                } finally {
                    db.$transaction = originalTransaction;
                }
            }
            const ownWorker = await db.machine.create({ data: {
                id: randomUUID(), accountId: requester.id, metadata: worker.metadata, active: true,
                dataEncryptionKey: worker.dataEncryptionKey,
                operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: '4'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                accountId: requester.id, machineId: ownWorker.id, sessionId: session.id, data: '{}',
            }))).resolves.toMatchObject({ ok: true });
            // One Account cohort statement, two rows for foreign custody and
            // one for same-Account custody. Identity preparation must not run
            // the complete authorization traversal before final admission.
            for (const initiator of [worker, ownWorker]) {
                let transactions = 0;
                const readCounts = [0, 0];
                const cohorts: unknown[][] = [];
                db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
                    const callback: unknown = args[0];
                    if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                    const phase = transactions++;
                    const observed = new Proxy(callback, { apply(fn, context, callbackArgs) {
                        const native = callbackArgs[0];
                        const counted = new Proxy(native, { get(client, property) {
                            const value = Reflect.get(client, property, client);
                            if (property === '$queryRawUnsafe') return async (...queryArgs: unknown[]) => {
                                const [query, ...values] = queryArgs;
                                if (typeof query === 'string' && query.includes('FROM "Account"') && query.includes(' FOR ')) {
                                    if (phase === 0) {
                                        expect(query).toContain('FOR NO KEY UPDATE');
                                        if (initiator === worker) expect(query).toContain('ORDER BY "id"');
                                        cohorts.push(values);
                                    }
                                } else if (typeof query === 'string' && /^\s*SELECT\b/i.test(query)) {
                                    readCounts[phase] += 1;
                                }
                                return Reflect.apply(value, client, queryArgs);
                            };
                            if (typeof property !== 'string' || property.startsWith('$') || !value || typeof value !== 'object') return value;
                            return new Proxy(value, { get(model, method) {
                                const query = Reflect.get(model, method, model);
                                if (typeof method !== 'string' || !/^(find|count|aggregate|groupBy)/.test(method) || typeof query !== 'function') return query;
                                return (...queryArgs: unknown[]) => {
                                    readCounts[phase] += 1;
                                    return Reflect.apply(query, model, queryArgs);
                                };
                            } });
                        } });
                        return Reflect.apply(fn, context, [counted, ...callbackArgs.slice(1)]);
                    } });
                    return Reflect.apply(target, receiver, [observed, ...args.slice(1)]);
                } });
                try {
                    expect(await openAccountConnectionProviderBroker({ ...common,
                        readCurrentPresence: async () => ({
                            initiatorPresence: { state: 'partial' as const, machineIds: new Set([initiator.id]) },
                            targetPresence: { state: 'partial' as const, machineIds: new Set([hub.id]) },
                        }),
                        tokenEpoch: requester.tokenEpoch, nowMs: 1, grantId: randomUUID(),
                        signingKey: { keyId: 'pg-home', secretKey: signing.secretKey }, verifyRefreshAuthority: verifyAuthority,
                        request: { v: 2, initiatorMachineId: initiator.id, targetMachineId: hub.id,
                            consumer: { kind: 'session', sessionId: session.id }, application: authority.payload.application,
                            source: { kind: 'account_connection', connectionId: ProviderConnectionIdSchema.parse('pg-personal'),
                                expectedConnectionSecurityFingerprint: 'connection-security:v1:pg-personal',
                                expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:pg-personal' } },
                    })).toMatchObject({ ok: true });
                    expect(transactions).toBe(1);
                    expect(readCounts[0]).toBeGreaterThan(0);
                    expect(readCounts[1]).toBe(0);
                    expect(cohorts).toEqual(initiator === worker
                        ? [[[requester.id, custodian.id].sort()]] : [[requester.id]]);
                } finally {
                    db.$transaction = originalTransaction;
                }
            }
            // Writer wins: let the real revoke hold publication before the
            // opener's final fence, then commit while that fence is waiting.
            {
                let publicationHeld!: () => void;
                let releasePublication!: () => void;
                let finalFenceStarted!: () => void;
                const held = new Promise<void>(resolve => { publicationHeld = resolve; });
                const released = new Promise<void>(resolve => { releasePublication = resolve; });
                const waiting = new Promise<void>(resolve => { finalFenceStarted = resolve; });
                const wrapRaw = (afterAcquire: boolean) => new Proxy(originalTransaction, { apply(target, receiver, args) {
                    const callback: unknown = args[0];
                    if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                    const final = afterAcquire || ++brokerTransactions === 3;
                    const observed = new Proxy(callback, { apply(fn, context, callbackArgs) {
                        const native = callbackArgs[0];
                        const scheduled = new Proxy(native, { get(client, property) {
                            if (property !== '$queryRawUnsafe' || !final) return Reflect.get(client, property, client);
                            return async (...queryArgs: unknown[]) => {
                                const query = queryArgs[0];
                                const fence = typeof query === 'string' && query.includes('FROM "Account"')
                                    && query.includes('FOR NO KEY UPDATE');
                                if (fence && !afterAcquire) finalFenceStarted();
                                const result: unknown = await Reflect.apply(client.$queryRawUnsafe, client, queryArgs);
                                if (fence && afterAcquire) {
                                    publicationHeld();
                                    await released;
                                }
                                return result;
                            };
                        } });
                        return Reflect.apply(fn, context, [scheduled, ...callbackArgs.slice(1)]);
                    } });
                    return Reflect.apply(target, receiver, [observed, ...args.slice(1)]);
                } });
                let brokerTransactions = 0;
                db.$transaction = wrapRaw(true);
                const withdrawal = inTx(tx => revokeMachineInTx(tx, { accountId: custodian.id, machineId: worker.id }));
                let opened: ReturnType<typeof openTeamCredentialProviderBroker> | undefined;
                try {
                    await Promise.race([held, withdrawal.then(() => { throw new Error('Revoke completed before publication was observed'); })]);
                    db.$transaction = wrapRaw(false);
                    opened = openTeamCredentialProviderBroker(teamOpenInput);
                    await Promise.race([waiting, opened.then(() => { throw new Error('Broker completed before its final fence'); })]);
                    releasePublication();
                    expect(await withdrawal).toMatchObject({ ok: true });
                    const refused = await opened;
                    expect(refused).toMatchObject({ ok: false });
                    expect(refused).not.toHaveProperty('authority');
                } finally {
                    releasePublication();
                    db.$transaction = originalTransaction;
                    await Promise.allSettled([withdrawal, ...(opened ? [opened] : [])]);
                    await db.machine.update({ where: { id: worker.id }, data: { revokedAt: null } });
                    await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                        accountId: requester.id, machineId: worker.id, sessionId: session.id, data: '{}',
                    }));
                }
            }
            let fencedFinalAdmissions = 0;
            // Observe the real callback/commit boundary. The contender probes
            // the same Account publication lock required to complete withdrawal;
            // NOWAIT is test-only evidence, not a production timeout or retry.
            db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
                const callback: unknown = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                const observed = new Proxy(callback, { async apply(fn, context, callbackArgs) {
                    const result: unknown = await Reflect.apply(fn, context, callbackArgs);
                    if (result && typeof result === 'object' && 'result' in result) {
                        const admission = result.result;
                        if (admission && typeof admission === 'object' && 'ok' in admission && admission.ok === true) {
                            await expect(db.$queryRawUnsafe(
                                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', requester.id,
                            )).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
                            fencedFinalAdmissions += 1;
                        }
                    }
                    return result;
                } });
                return Reflect.apply(target, receiver, [observed, ...args.slice(1)]);
            } });
            try {
                for (const consumer of [{ kind: 'session', sessionId: session.id },
                    { kind: 'execution_run', executionRunId: 'pg-run' }] as const) {
                    const openInput = { ...common, tokenEpoch: requester.tokenEpoch,
                        nowMs: 1, grantId: randomUUID(), signingKey: { keyId: 'pg-home', secretKey: signing.secretKey },
                        verifyRefreshAuthority: verifyAuthority,
                        request: { v: 2 as const, initiatorMachineId: worker.id, targetMachineId: hub.id, consumer,
                            application: authority.payload.application,
                            source: { kind: 'account_connection' as const, connectionId: ProviderConnectionIdSchema.parse('pg-personal'),
                                expectedConnectionSecurityFingerprint: 'connection-security:v1:pg-personal',
                                expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:pg-personal' } } };
                    const opened = await openAccountConnectionProviderBroker(openInput);
                    expect(opened).toMatchObject({ ok: true, authority: { payload: {
                        initiator: { accountId: requester.id, machineId: worker.id }, target: { custodianAccountId: requester.id, machineId: hub.id },
                    } } });
                    if (!opened.ok) throw new Error(opened.reasonCode);
                    expect(verifyAuthority(opened.authority)).toBe(true);
                    expect(await admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
                        request: { v: 2, authority: opened.authority } })).toEqual({ ok: true });
                    expect(await openAccountConnectionProviderBroker({ ...openInput,
                        request: { ...openInput.request, refreshAuthority: opened.authority } })).toMatchObject({ ok: true });
                    personalAuthorities.push(opened.authority);
                }
                expect(fencedFinalAdmissions).toBe(6);
            } finally {
                db.$transaction = originalTransaction;
            }
            // Schedule at the reviewer's real final Machine SELECT boundary.
            // A conflicting writer must wait; never await it inside the signer.
            // After commit, finish the canonical writer before delivering the
            // result, proving signing-before-withdrawal is still a valid outcome.
            let custodianFences = 0;
            for (const consumer of [{ kind: 'session', sessionId: session.id },
                { kind: 'execution_run', executionRunId: 'pg-run' }] as const) {
                for (const operation of ['open', 'refresh', 'admit'] as const) {
                    for (const withdrawal of ['revoke', 'replace'] as const) {
                        const openInput = { ...common, tokenEpoch: requester.tokenEpoch,
                            nowMs: 1, grantId: randomUUID(), signingKey: { keyId: 'pg-home', secretKey: signing.secretKey },
                            verifyRefreshAuthority: verifyAuthority,
                            request: { v: 2 as const, initiatorMachineId: worker.id, targetMachineId: hub.id, consumer,
                                application: authority.payload.application,
                                source: { kind: 'account_connection' as const, connectionId: ProviderConnectionIdSchema.parse('pg-personal'),
                                    expectedConnectionSecurityFingerprint: 'connection-security:v1:pg-personal',
                                    expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:pg-personal' } } };
                        const retained = await openAccountConnectionProviderBroker(openInput);
                        if (!retained.ok) throw new Error(retained.reasonCode);
                        const replacement = withdrawal === 'replace' ? await db.machine.create({ data: {
                            id: randomUUID(), accountId: custodian.id, metadata: '{}', active: false,
                        } }) : null;
                        let transactions = 0;
                        let checked = false;
                        let completed = false;
                        db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                            const callback: unknown = args[0];
                            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                            const final = ++transactions === 1;
                            const observed = new Proxy(callback, { async apply(fn, context, callbackArgs) {
                                const native = callbackArgs[0];
                                const scheduled = new Proxy(native, { get(client, property) {
                                    if (property !== 'machine' || !final) return Reflect.get(client, property, client);
                                    return new Proxy(client.machine, { get(model, method) {
                                        const query = Reflect.get(model, method, model);
                                        if (method !== 'findUnique') return query;
                                        return async (...queryArgs: unknown[]) => {
                                            const rows: unknown = await Reflect.apply(query, model, queryArgs);
                                            const input = queryArgs[0];
                                            if (!checked && input && typeof input === 'object' && 'select' in input
                                                && input.select && typeof input.select === 'object' && 'operationProtocolCapabilities' in input.select) {
                                                // Content revoke/replacement must take NO KEY UPDATE at
                                                // publication; physical erasure takes UPDATE at entry.
                                                for (const intent of ['NO KEY UPDATE', 'UPDATE']) {
                                                    await expect(db.$queryRawUnsafe(
                                                        `SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${intent} NOWAIT`, custodian.id,
                                                    )).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
                                                }
                                                checked = true;
                                                custodianFences += 1;
                                            }
                                            return rows;
                                        };
                                    } });
                                } });
                                return Reflect.apply(fn, context, [scheduled, ...callbackArgs.slice(1)]);
                            } });
                            const result: unknown = await Reflect.apply(target, receiver, [observed, ...args.slice(1)]);
                            if (final) {
                                db.$transaction = originalTransaction;
                                if (replacement) {
                                    await inTx(tx => applyMachineReplacement({ tx, accountId: custodian.id,
                                        oldMachineId: worker.id, replacementMachineId: replacement.id,
                                        reason: 'contract', source: 'manual', actorUserId: custodian.id, confirmActiveOldMachine: true }));
                                    expect((await db.machine.findUnique({ where: { id: worker.id } }))?.replacedByMachineId).toBe(replacement.id);
                                } else {
                                    expect(await inTx(tx => revokeMachineInTx(tx, {
                                        accountId: custodian.id, machineId: worker.id,
                                    }))).toMatchObject({ ok: true });
                                    expect((await db.machine.findUnique({ where: { id: worker.id } }))?.revokedAt).not.toBeNull();
                                }
                                completed = true;
                            }
                            return result;
                        } });
                        try {
                            const result = operation === 'admit'
                                ? await admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
                                    request: { v: 2, authority: retained.authority } })
                                : await openAccountConnectionProviderBroker({ ...openInput,
                                    request: { ...openInput.request,
                                        ...(operation === 'refresh' ? { refreshAuthority: retained.authority } : {}) } });
                            expect(result).toMatchObject({ ok: true });
                            if (result.ok && 'authority' in result) expect(verifyAuthority(result.authority)).toBe(true);
                            expect(checked).toBe(true);
                            expect(completed).toBe(true);
                            const reads = presenceReads;
                            expect(await openAccountConnectionProviderBroker(openInput)).toMatchObject({ ok: false });
                            expect(await admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
                                request: { v: 2, authority: retained.authority } })).toMatchObject({ ok: false });
                            expect(presenceReads).toBe(reads + 2);
                        } finally {
                            db.$transaction = originalTransaction;
                            if (replacement) {
                                await inTx(tx => clearMachineReplacement({ tx, accountId: custodian.id, oldMachineId: worker.id }));
                            } else {
                                // Restore disposable fixture state for the next distinct contract.
                                await db.machine.update({ where: { id: worker.id }, data: { revokedAt: null } });
                            }
                            await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                                accountId: requester.id, machineId: worker.id, sessionId: session.id, data: '{}',
                            }));
                        }
                    }
                }
            }
            expect(custodianFences).toBe(12);
            await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: worker.id,
                principal: { kind: 'account', accountId: requester.id },
            }));
            expect(await read()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
            const readsBeforeRevocation = presenceReads;
            for (const personalAuthority of personalAuthorities) {
                expect(await admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
                    request: { v: 2, authority: personalAuthority } })).toMatchObject({ ok: false });
            }
            expect(presenceReads).toBe(readsBeforeRevocation + personalAuthorities.length);
        } finally {
            await db.team.delete({ where: { id: team.id } });
            await db.accessKey.deleteMany({ where: { accountId: requester.id } });
            await db.session.deleteMany({ where: { accountId: requester.id } });
            await db.machine.deleteMany({ where: { accountId: { in: [requester.id, custodian.id, resourceCustodian.id] } } });
            await db.account.deleteMany({ where: { id: { in: [requester.id, custodian.id, resourceCustodian.id] } } });
        }
    });
});
