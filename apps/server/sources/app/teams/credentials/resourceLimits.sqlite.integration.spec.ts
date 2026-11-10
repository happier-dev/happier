import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import {
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
} from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';

import {
    listTeamCredentialUsageLimitsInTx,
    upsertTeamCredentialUsageLimitInTx,
} from './resourceLimits';
import {
    evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx,
    evaluateTeamCredentialUsageAdmissionLimitsInTx,
} from './teamCredentialUsageLimits';
import { admitTeamCredentialUsageInTx } from './teamCredentialUsageAdmission';
import { readTeamCredentialCatalogInTx } from './resourceRead';
import { updateTeamCredentialResourceInTx } from './resourceUpdate';

const TEST_AUTHENTICATION = {
    env: process.env,
    authenticationAuthority: 'present_user',
    authenticationEvidence: [],
} as const;

describe('Team credential usage-limit administration', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'team-resource-limits-' });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(options?: Readonly<{ sessionUsePolicy?: 'personal_allowed' | 'team_context_required' }>) {
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Limit team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'member' } });
        const memberMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: member.id, role: 'member' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: other.id, role: 'member' } });
        const currentGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: 'Current group', nameKey: 'current-group' },
        });
        const formerGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: 'Former group', nameKey: 'former-group' },
        });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id,
            teamGroupId: currentGroup.id,
            teamMembershipId: memberMembership.id,
            nativeContribution: true,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Shared provider',
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: options?.sessionUsePolicy ?? 'personal_allowed',
            sourceBindingJson: '{}',
            allMembersDeliveryMode: 'brokered',
        } });
        return { manager, custodian, member, other, team, memberMembership, currentGroup, formerGroup, resource };
    }

    it('requires restricted-Team qualification from a current source custodian before limit disclosure', async () => {
        const f = await fixture();
        await db.team.update({ where: { id: f.team.id }, data: { authenticationPolicy: {
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id,
            subjectKind: 'team_member',
            subjectId: f.other.id,
            period: 'day',
            metric: 'inference_requests',
            maximum: '7',
        } });

        await expect(inTx((tx) => listTeamCredentialUsageLimitsInTx(tx, {
            actorAccountId: f.custodian.id,
            resourceId: f.resource.id,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, error: 'team_authentication_required' });
    });

    it('offers a token ceiling on a Team-context resource and enforces it on the Session route', async () => {
        // Plan 10.07 §12.5: token limits need observation on every ALLOWED use
        // path. A Team-context resource is reachable only through Happier
        // Sessions and their attached Runs, whose Agent observations are
        // complete; detached Runs and the external API cannot admit it.
        const f = await fixture({ sessionUsePolicy: 'team_context_required' });
        const created = await inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: 0,
                limit: {
                    subjectKind: 'team_member', subjectId: f.member.id,
                    period: 'month', metric: 'total_tokens', maximum: '10', enabled: true,
                },
            },
        }));
        expect(created).toMatchObject({ ok: true, limit: expect.objectContaining({ metric: 'total_tokens' }) });
        if (!created.ok) throw new Error('expected the token limit to be created');
        // The ordinary Agent observation of a later Session turn.
        await db.usageEvent.create({ data: {
            accountId: f.member.id,
            observedAt: new Date(),
            agentId: 'claude',
            source: 'agent',
            scope: 'turn_delta',
            totalTokens: 12,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        } });

        await expect(inTx((tx) => admitTeamCredentialUsageInTx(tx, {
            storageAccountId: f.member.id,
            sessionId: null,
            turnId: null,
            observedAt: new Date(),
            requestId: 'session-request-over-token-ceiling',
            modelId: 'model-a',
            usageRoute: 'agent_runtime_session_turn',
            authority: {
                kind: 'teamCredentialAdmission',
                requestingAccountId: f.member.id,
                resourceId: f.resource.id,
                externalApiKeyId: null,
                sourceCredentialId: null,
                workerMachineId: null,
                brokerMachineId: 'broker-a',
                deliveryMode: 'brokered',
                executionRunId: null,
            },
        }))).resolves.toMatchObject({
            ok: false,
            reasonCode: 'team_credential_usage_limit',
            usageLimit: { metric: 'total_tokens', remaining: '0' },
        });
        await expect(db.usageEvent.count({ where: {
            accountId: f.member.id,
            externalKey: 'session-request-over-token-ceiling',
        } })).resolves.toBe(0);

        // Opening the personal routes would leave the ceiling silently partial,
        // so the policy change fails closed while the limit is enabled.
        await expect(inTx((tx) => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: f.resource.id, expectedRevision: created.revision, sessionUsePolicy: 'personal_allowed' },
        }))).resolves.toEqual({ ok: false, error: 'token_limit_unavailable' });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .resolves.toMatchObject({ sessionUsePolicy: 'team_context_required', revision: created.revision });

        // Once the manager disables the ceiling nothing claims to cover those
        // routes, so the ceiling no longer refuses the change. (This fixture's
        // placeholder source is refused later by the placement owner, which
        // is not what this case is about.)
        const disabled = await inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: created.revision,
                limit: {
                    id: created.limit.id, subjectKind: 'team_member', subjectId: f.member.id,
                    period: 'month', metric: 'total_tokens', maximum: '10', enabled: false,
                },
            },
        }));
        if (!disabled.ok) throw new Error(`expected the limit to be disabled, received ${disabled.error}`);
        await expect(inTx((tx) => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            patch: { resourceId: f.resource.id, expectedRevision: disabled.revision, sessionUsePolicy: 'personal_allowed' },
        }))).resolves.not.toEqual({ ok: false, error: 'token_limit_unavailable' });
    });

    it('keeps a personal-use resource request-count-only because detached Runs and the external API cannot report tokens', async () => {
        const f = await fixture();
        await expect(inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: 0,
                limit: {
                    subjectKind: 'resource', subjectId: '',
                    period: 'day', metric: 'total_tokens', maximum: '100', enabled: true,
                },
            },
        }))).resolves.toEqual({ ok: false, error: 'token_limit_unavailable' });
        await expect(inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: 0,
                limit: {
                    subjectKind: 'resource', subjectId: '',
                    period: 'day', metric: 'inference_requests', maximum: '100', enabled: true,
                },
            },
        }))).resolves.toMatchObject({ ok: true });
        // No canonical price exists for any route, so cost stays unavailable
        // even where tokens are observed (§2.6, §12.6).
        const teamContext = await fixture({ sessionUsePolicy: 'team_context_required' });
        await expect(inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: teamContext.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: teamContext.resource.id,
                expectedRevision: 0,
                limit: {
                    subjectKind: 'resource', subjectId: '',
                    period: 'day', metric: 'cost_usd', maximum: '1.00', enabled: true,
                },
            },
        }))).resolves.toEqual({ ok: false, error: 'cost_limit_unavailable' });
    });

    it.each([
        'agent_runtime_detached_execution_run',
        'external_provider_terminal',
        'resource_test',
    ] as const)('keeps request-count admission available on the %s route', async (usageRoute) => {
        const f = await fixture();
        await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id,
            subjectKind: 'team_member',
            subjectId: f.member.id,
            period: 'day',
            metric: 'inference_requests',
            maximum: '2',
        } });
        const requestId = `request-count-${usageRoute}`;

        await expect(inTx((tx) => admitTeamCredentialUsageInTx(tx, {
            storageAccountId: f.member.id,
            sessionId: null,
            turnId: null,
            observedAt: new Date(),
            requestId,
            modelId: 'model-a',
            usageRoute,
            authority: {
                kind: 'teamCredentialAdmission',
                requestingAccountId: f.member.id,
                resourceId: f.resource.id,
                externalApiKeyId: null,
                sourceCredentialId: null,
                workerMachineId: null,
                brokerMachineId: 'broker-a',
                deliveryMode: 'brokered',
                executionRunId: null,
            },
        }))).resolves.toMatchObject({ ok: true, created: true });
        await expect(db.usageEvent.findFirstOrThrow({ where: {
            accountId: f.member.id,
            externalKey: requestId,
        } })).resolves.toMatchObject({ requestCount: 1, totalTokens: null });
    });

    it('applies only Group limits for the actor\'s current Groups at admission, never event attribution alone', async () => {
        const f = await fixture();
        const formerGroupLimit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id,
            subjectKind: 'team_group',
            subjectId: f.formerGroup.id,
            period: 'day',
            metric: 'inference_requests',
            maximum: '1',
        } });
        const observedAt = new Date();
        const historical = await db.usageEvent.create({ data: {
            accountId: f.member.id,
            observedAt,
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        } });
        await db.usageEventTeamCredentialGroupAttribution.create({
            data: { usageEventId: historical.id, teamGroupId: f.formerGroup.id },
        });

        const evaluation = await inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
            resourceId: f.resource.id,
            actorAccountId: f.member.id,
            now: observedAt,
        }));

        // The member left the limited Group: its ceiling must not apply even
        // though recorded history still carries the Group attribution, and the
        // departed Group must not re-enter the admitted budget Groups.
        expect(evaluation).toMatchObject({ ok: true, applied: [], budgetGroupIds: [] });
        expect(formerGroupLimit.subjectId).toBe(f.formerGroup.id);
    });

    it('matches the scalar admission semantics for every resource in one bounded evaluation', async () => {
        const f = await fixture();
        const secondResource = await db.teamCredentialResource.create({ data: {
            teamId: f.team.id,
            custodianAccountId: f.custodian.id,
            displayName: 'Second shared provider',
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: '{}',
            allMembersDeliveryMode: 'brokered',
        } });
        const createdAt = new Date('2026-09-07T00:00:00.000Z');
        const now = new Date('2026-09-07T12:00:00.000Z');
        const [resourceLimit, groupLimit] = await Promise.all([
            db.teamCredentialUsageLimit.create({ data: {
                resourceId: f.resource.id,
                subjectKind: 'resource',
                subjectId: '',
                period: 'day',
                metric: 'inference_requests',
                maximum: '1',
                createdAt,
            } }),
            db.teamCredentialUsageLimit.create({ data: {
                resourceId: secondResource.id,
                subjectKind: 'team_group',
                subjectId: f.currentGroup.id,
                period: 'week',
                metric: 'cost_usd',
                maximum: '5.00',
                createdAt,
            } }),
        ]);
        const [resourceAdmission, groupAdmission] = await Promise.all([
            db.usageEvent.create({ data: {
                accountId: f.member.id,
                observedAt: new Date('2026-09-07T10:00:00.000Z'),
                agentId: 'team_credential_broker',
                source: 'team_credential_admission',
                scope: 'turn_delta',
                requestCount: 1,
                teamCredentialResourceId: f.resource.id,
                teamCredentialActorAccountId: f.member.id,
                credentialDeliveryMode: 'brokered',
            } }),
            db.usageEvent.create({ data: {
                accountId: f.member.id,
                observedAt: new Date('2026-09-07T11:00:00.000Z'),
                agentId: 'team_credential_broker',
                source: 'team_credential_admission',
                scope: 'turn_delta',
                requestCount: 1,
                teamCredentialResourceId: secondResource.id,
                teamCredentialActorAccountId: f.member.id,
                credentialDeliveryMode: 'external_api',
            } }),
        ]);
        await db.usageEventTeamCredentialGroupAttribution.create({
            data: { usageEventId: groupAdmission.id, teamGroupId: f.currentGroup.id },
        });

        const resourceIds = [f.resource.id, secondResource.id, 'missing-resource'];
        const batch = await inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(tx, {
            resourceIds,
            actorAccountId: f.member.id,
            now,
        }));
        const scalar = new Map(await Promise.all(resourceIds.map(async (resourceId) => [
            resourceId,
            await inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
                resourceId,
                actorAccountId: f.member.id,
                now,
            })),
        ] as const)));

        expect(batch).toEqual(scalar);
        expect(batch.get(f.resource.id)).toMatchObject({
            ok: false,
            denied: { limitId: resourceLimit.id, recorded: 1, maximum: 1 },
            budgetGroupIds: [],
        });
        expect(batch.get(secondResource.id)).toMatchObject({
            ok: true,
            applied: [{ limitId: groupLimit.id, metric: 'cost_usd', recorded: 0, maximum: 5 }],
            budgetGroupIds: [f.currentGroup.id],
        });
        expect(batch.get('missing-resource')).toEqual({ ok: true, applied: [], budgetGroupIds: [] });
        expect(resourceAdmission.requestCount).toBe(1);
        await expect(inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(tx, {
            resourceIds: [],
            actorAccountId: f.member.id,
            now,
        }))).resolves.toEqual(new Map());
    });

    it('uses a constant bounded number of fact queries for many limited resources', async () => {
        const f = await fixture();
        const resources = await Promise.all(Array.from({ length: 12 }, async (_, index) => (
            index === 0 ? f.resource : await db.teamCredentialResource.create({ data: {
                teamId: f.team.id,
                custodianAccountId: f.custodian.id,
                displayName: `Bounded shared provider ${String(index).padStart(2, '0')}`,
                disclosureCeiling: 'brokered_only',
                sessionUsePolicy: 'personal_allowed',
                sourceBindingJson: '{}',
                allMembersDeliveryMode: 'brokered',
            } })
        )));
        const createdAt = new Date('2026-09-07T00:00:00.000Z');
        await db.teamCredentialUsageLimit.createMany({ data: resources.map((resource) => ({
            resourceId: resource.id,
            subjectKind: 'team_group',
            subjectId: f.currentGroup.id,
            period: 'day',
            metric: 'inference_requests',
            maximum: '1',
            createdAt,
        })) });
        const events = await Promise.all(resources.map((resource, index) => db.usageEvent.create({ data: {
            accountId: f.member.id,
            observedAt: new Date(createdAt.getTime() + 60_000 + index),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        }})));
        await db.usageEventTeamCredentialGroupAttribution.createMany({ data: events.map((usageEvent) => ({
            usageEventId: usageEvent.id,
            teamGroupId: f.currentGroup.id,
        })) });

        const evaluateWithQueryCount = async (resourceIds: readonly string[]) => await inTx(async (tx) => {
            let queryCount = 0;
            const delegates = new Set([
                'teamCredentialResource',
                'teamMembership',
                'teamCredentialUsageLimit',
                'usageEvent',
                'usageEventTeamCredentialGroupAttribution',
                'sessionTurn',
            ]);
            const observedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    const delegate = Reflect.get(target, property, receiver);
                    if (typeof property !== 'string' || !delegates.has(property) || typeof delegate !== 'object' || delegate === null) {
                        return delegate;
                    }
                    return new Proxy(delegate, {
                        get(delegateTarget, method, delegateReceiver) {
                            const operation = Reflect.get(delegateTarget, method, delegateReceiver);
                            if ((method !== 'findMany' && method !== 'findUnique') || typeof operation !== 'function') return operation;
                            return (...args: readonly unknown[]) => {
                                queryCount += 1;
                                return Reflect.apply(operation, delegateTarget, args);
                            };
                        },
                    });
                },
            }) as Tx;
            const evaluations = await evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(observedTx, {
                resourceIds,
                actorAccountId: f.member.id,
                now: new Date('2026-09-07T12:00:00.000Z'),
            });
            return { evaluations, queryCount };
        });

        const one = await evaluateWithQueryCount([resources[0]!.id]);
        const many = await evaluateWithQueryCount(resources.map((resource) => resource.id));
        expect(one.queryCount).toBeGreaterThan(0);
        expect(many.queryCount).toBe(one.queryCount);
        expect(many.queryCount).toBeLessThanOrEqual(5);
        expect([...many.evaluations.values()]).toHaveLength(resources.length);
        expect([...many.evaluations.values()].every((evaluation) => !evaluation.ok && 'denied' in evaluation)).toBe(true);
    });

    it('projects many recipient limit states without per-resource fact queries', async () => {
        const f = await fixture();
        const service = { pluginId: 'catalog.batch', localId: 'credential' };
        const connectedAccount = { service, accountId: 'catalog-batch-account' };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: f.custodian.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            connectedAccountId: connectedAccount.accountId,
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(connectedAccount),
            authenticationModeId: 'api-key',
            token: Buffer.from('catalog-batch-private-credential'),
            metadata: { credentialRevision: 'csr_catalog_batch' },
        } });
        const broker = await db.machine.create({ data: {
            id: `catalog-batch-broker-${f.custodian.id}`,
            accountId: f.custodian.id,
            metadata: '{}',
            kind: 'persistent',
        } });
        const sourceBindingJson = JSON.stringify({
            v: 1,
            kind: 'connected_account',
            target: { kind: 'account', account: connectedAccount },
            credentialIncarnation: credential.id,
        });
        const resources = await Promise.all(Array.from({ length: 12 }, async (_, index) => (
            index === 0
                ? await db.teamCredentialResource.update({
                    where: { id: f.resource.id },
                    data: {
                        displayName: 'Catalog batch 00',
                        sourceBindingJson,
                        brokerMachineId: broker.id,
                    },
                })
                : await db.teamCredentialResource.create({ data: {
                    teamId: f.team.id,
                    custodianAccountId: f.custodian.id,
                    displayName: `Catalog batch ${String(index).padStart(2, '0')}`,
                    disclosureCeiling: 'brokered_only',
                    sessionUsePolicy: 'personal_allowed',
                    sourceBindingJson,
                    brokerMachineId: broker.id,
                    allMembersDeliveryMode: 'brokered',
                } })
        )));
        const createdAt = new Date(Date.now() - 60_000);
        await db.teamCredentialUsageLimit.createMany({ data: resources.map((resource) => ({
            resourceId: resource.id,
            subjectKind: 'resource',
            subjectId: '',
            period: 'day',
            metric: 'inference_requests',
            maximum: '1',
            createdAt,
        })) });
        await db.usageEvent.createMany({ data: resources.map((resource, index) => ({
            accountId: f.member.id,
            observedAt: new Date(createdAt.getTime() + 1_000 + index),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        })) });

        const readWithQueryCount = async (limit: number) => await inTx(async (tx) => {
            let factQueryCount = 0;
            const delegates = new Set([
                'teamCredentialResource',
                'teamMembership',
                'teamCredentialUsageLimit',
                'usageEvent',
                'usageEventTeamCredentialGroupAttribution',
                'sessionTurn',
            ]);
            const observedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    const delegate = Reflect.get(target, property, receiver);
                    if (typeof property !== 'string' || !delegates.has(property) || typeof delegate !== 'object' || delegate === null) {
                        return delegate;
                    }
                    return new Proxy(delegate, {
                        get(delegateTarget, method, delegateReceiver) {
                            const operation = Reflect.get(delegateTarget, method, delegateReceiver);
                            if ((method !== 'findMany' && method !== 'findUnique') || typeof operation !== 'function') return operation;
                            return (...args: readonly unknown[]) => {
                                factQueryCount += 1;
                                return Reflect.apply(operation, delegateTarget, args);
                            };
                        },
                    });
                },
            }) as Tx;
            const result = await readTeamCredentialCatalogInTx(observedTx, {
                teamId: f.team.id,
                actorAccountId: f.member.id,
                authentication: TEST_AUTHENTICATION,
                limit,
            });
            return { result, factQueryCount };
        });

        const one = await readWithQueryCount(1);
        const many = await readWithQueryCount(50);
        expect(one.result.ok).toBe(true);
        expect(many.result.ok).toBe(true);
        if (!one.result.ok || !many.result.ok) throw new Error('expected recipient catalog');
        expect(one.result.page.resources).toHaveLength(1);
        expect(many.result.page.resources).toHaveLength(resources.length);
        expect(many.factQueryCount).toBe(one.factQueryCount);
        expect(many.factQueryCount).toBeLessThanOrEqual(10);
        expect(many.result.page.resources.every((resource) => resource.usageLimit?.remaining === '0')).toBe(true);
    });

    it('stops applying an archived Group budget to future admissions while preserving history for restore', async () => {
        const f = await fixture();
        const observedAt = new Date();
        const limit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id,
            subjectKind: 'team_group',
            subjectId: f.currentGroup.id,
            period: 'day',
            metric: 'inference_requests',
            maximum: '1',
            createdAt: new Date(observedAt.getTime() - 1),
        } });
        const admissionInput = (requestId: string, at: Date) => ({
            storageAccountId: f.member.id,
            sessionId: null,
            turnId: null,
            observedAt: at,
            requestId,
            modelId: 'model-a',
            usageRoute: 'external_provider_terminal' as const,
            authority: {
                kind: 'teamCredentialAdmission' as const,
                requestingAccountId: f.member.id,
                resourceId: f.resource.id,
                externalApiKeyId: null,
                sourceCredentialId: null,
                workerMachineId: null,
                brokerMachineId: 'broker-a',
                deliveryMode: 'brokered' as const,
                executionRunId: null,
            },
        });

        const first = await inTx((tx) => admitTeamCredentialUsageInTx(tx, admissionInput('group-before-archive', observedAt)));
        expect(first).toMatchObject({ ok: true, created: true, budgetGroupIds: [f.currentGroup.id] });
        if (!first.ok) throw new Error('expected first Group-budget admission');

        await db.teamGroup.update({ where: { id: f.currentGroup.id }, data: { archivedAt: new Date() } });
        await expect(inTx((tx) => listTeamCredentialUsageLimitsInTx(tx, {
            actorAccountId: f.member.id,
            authentication: TEST_AUTHENTICATION,
            resourceId: f.resource.id,
        }))).resolves.toMatchObject({ ok: true, limits: [] });
        const whileArchived = await inTx((tx) => admitTeamCredentialUsageInTx(
            tx,
            admissionInput('group-while-archived', new Date(observedAt.getTime() + 1)),
        ));
        expect(whileArchived).toMatchObject({ ok: true, created: true, budgetGroupIds: [] });
        if (!whileArchived.ok) throw new Error('expected independent Team-wide entitlement while Group is archived');

        await expect(db.usageEventTeamCredentialGroupAttribution.findMany({
            where: { usageEventId: first.usageEventId },
            select: { teamGroupId: true },
        })).resolves.toEqual([{ teamGroupId: f.currentGroup.id }]);
        await expect(db.usageEventTeamCredentialGroupAttribution.findMany({
            where: { usageEventId: whileArchived.usageEventId },
            select: { teamGroupId: true },
        })).resolves.toEqual([]);

        await db.teamGroup.update({ where: { id: f.currentGroup.id }, data: { archivedAt: null } });
        await expect(inTx((tx) => listTeamCredentialUsageLimitsInTx(tx, {
            actorAccountId: f.member.id,
            authentication: TEST_AUTHENTICATION,
            resourceId: f.resource.id,
        }))).resolves.toMatchObject({ ok: true, limits: [expect.objectContaining({ id: limit.id })] });
        await expect(inTx((tx) => admitTeamCredentialUsageInTx(
            tx,
            admissionInput('group-after-restore', new Date(observedAt.getTime() + 2)),
        ))).resolves.toMatchObject({
            ok: false,
            reasonCode: 'team_credential_usage_limit',
            denied: { limitId: limit.id, recorded: 1, maximum: 1 },
            usageLimit: {
                metric: 'inference_requests',
                remaining: '0',
                resetsAtUtc: expect.any(String),
            },
        });
    });

    it('addresses a named member by Account ID and rejects the membership-row ID', async () => {
        const f = await fixture();
        expect(f.memberMembership.id).not.toBe(f.member.id);

        await expect(inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: 0,
                limit: {
                    subjectKind: 'team_member', subjectId: f.member.id, period: 'day',
                    metric: 'inference_requests', maximum: '5', enabled: true,
                },
            },
        }))).resolves.toMatchObject({ ok: true, limit: { subjectId: f.member.id } });

        await expect(inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: 1,
                limit: {
                    subjectKind: 'team_member', subjectId: f.memberMembership.id, period: 'week',
                    metric: 'inference_requests', maximum: '5', enabled: true,
                },
            },
        }))).resolves.toEqual({ ok: false, error: 'subject_not_in_team' });
    });

    it('keeps limit administration manager-only even for the source custodian', async () => {
        const f = await fixture();
        await expect(inTx((tx) => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: f.custodian.id,
            authentication: TEST_AUTHENTICATION,
            body: {
                resourceId: f.resource.id,
                expectedRevision: 0,
                limit: {
                    subjectKind: 'resource', subjectId: '', period: 'day',
                    metric: 'inference_requests', maximum: '5', enabled: true,
                },
            },
        }))).resolves.toEqual({ ok: false, error: 'forbidden' });
    });

    it('lets a member read only currently applicable limits with canonical recorded windows', async () => {
        const f = await fixture();
        const createdAt = new Date(Date.now() - 60_000);
        await db.teamCredentialUsageLimit.createMany({ data: [
            { resourceId: f.resource.id, subjectKind: 'resource', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '20', createdAt },
            { resourceId: f.resource.id, subjectKind: 'each_member', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '10', createdAt },
            { resourceId: f.resource.id, subjectKind: 'team_member', subjectId: f.member.id, period: 'day', metric: 'inference_requests', maximum: '8', createdAt },
            { resourceId: f.resource.id, subjectKind: 'team_member', subjectId: f.other.id, period: 'day', metric: 'inference_requests', maximum: '8', createdAt },
            { resourceId: f.resource.id, subjectKind: 'team_group', subjectId: f.currentGroup.id, period: 'day', metric: 'inference_requests', maximum: '7', createdAt },
            { resourceId: f.resource.id, subjectKind: 'team_group', subjectId: f.formerGroup.id, period: 'day', metric: 'inference_requests', maximum: '1', createdAt },
        ] });
        const ownEvent = await db.usageEvent.create({ data: {
            accountId: f.member.id,
            observedAt: new Date(),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 2,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        } });
        await db.usageEventTeamCredentialGroupAttribution.createMany({ data: [
            { usageEventId: ownEvent.id, teamGroupId: f.currentGroup.id },
            { usageEventId: ownEvent.id, teamGroupId: f.formerGroup.id },
        ] });
        await db.usageEvent.create({ data: {
            accountId: f.other.id,
            observedAt: new Date(),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 3,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.other.id,
            credentialDeliveryMode: 'brokered',
        } });

        const result = await inTx((tx) => listTeamCredentialUsageLimitsInTx(tx, {
            actorAccountId: f.member.id,
            authentication: TEST_AUTHENTICATION,
            resourceId: f.resource.id,
        }));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        expect(result.limits.map((limit) => [limit.subjectKind, limit.subjectId])).toEqual([
            ['resource', ''],
            ['each_member', ''],
            ['team_member', f.member.id],
            ['team_group', f.currentGroup.id],
        ]);
        expect(result.limits.map((limit) => limit.currentWindow.recorded)).toEqual(['5', '2', '2', '2']);
        const nextUtcDay = new Date();
        nextUtcDay.setUTCHours(24, 0, 0, 0);
        expect(result.limits.every((limit) => limit.currentWindow.resetsAtUtc === nextUtcDay.toISOString())).toBe(true);
    });

    it('excludes direct observations from every broker-only subject limit without multiplying shared rows', async () => {
        const f = await fixture();
        expect(f.memberMembership.id).not.toBe(f.member.id);
        const createdAt = new Date('2026-09-07T00:00:00.000Z');
        await db.teamCredentialUsageLimit.createMany({ data: [
            { resourceId: f.resource.id, subjectKind: 'resource', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '10', createdAt },
            { resourceId: f.resource.id, subjectKind: 'each_member', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '10', createdAt },
            { resourceId: f.resource.id, subjectKind: 'team_member', subjectId: f.member.id, period: 'day', metric: 'inference_requests', maximum: '10', createdAt },
            { resourceId: f.resource.id, subjectKind: 'team_group', subjectId: f.currentGroup.id, period: 'day', metric: 'inference_requests', maximum: '10', createdAt },
        ] });
        const direct = await db.usageEvent.create({ data: {
            accountId: f.member.id,
            observedAt: new Date('2026-09-07T09:00:00.000Z'),
            agentId: 'codex',
            source: 'codex_app_server',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'direct',
        } });
        const brokered = await db.usageEvent.create({ data: {
            accountId: f.member.id,
            observedAt: new Date('2026-09-07T10:00:00.000Z'),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        } });
        await db.usageEventTeamCredentialGroupAttribution.createMany({ data: [
            { usageEventId: direct.id, teamGroupId: f.currentGroup.id },
            { usageEventId: brokered.id, teamGroupId: f.currentGroup.id },
            { usageEventId: brokered.id, teamGroupId: f.formerGroup.id },
        ] });
        await db.usageEvent.create({ data: {
            accountId: f.other.id,
            observedAt: new Date('2026-09-07T11:00:00.000Z'),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.other.id,
            credentialDeliveryMode: 'brokered',
        } });

        const evaluation = await inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
            resourceId: f.resource.id,
            actorAccountId: f.member.id,
            now: new Date('2026-09-07T12:00:00.000Z'),
        }));

        expect(evaluation.ok).toBe(true);
        if (!evaluation.ok) throw new Error('expected usage-limit evaluation');
        expect(evaluation.applied.map((decision) => decision.recorded).sort((a, b) => a - b))
            .toEqual([1, 1, 1, 2]);
        expect(evaluation.budgetGroupIds).toEqual([f.currentGroup.id]);
    });

    it('attributes terminal Group usage only to a correlated admission inside each evaluated UTC window', async () => {
        const f = await fixture();
        const now = new Date('2026-09-07T12:00:00.000Z');
        const session = await db.session.create({ data: {
            accountId: f.member.id,
            tag: `usage-limit-window-${crypto.randomUUID()}`,
            metadata: '{}',
            encryptionMode: 'plain',
        } });
        const outsideTurnId = 'outside-daily-window';
        const insideTurnId = 'inside-daily-window';
        await db.sessionTurn.createMany({ data: [
            {
                sessionId: session.id,
                turnId: outsideTurnId,
                status: 'completed',
                startedAt: BigInt(Date.parse('2026-09-06T23:49:00.000Z')),
                updatedAt: BigInt(Date.parse('2026-09-07T09:00:00.000Z')),
                usageActorAccountId: f.member.id,
                teamCredentialResourceId: f.resource.id,
                credentialDeliveryMode: 'brokered',
            },
            {
                sessionId: session.id,
                turnId: insideTurnId,
                status: 'completed',
                startedAt: BigInt(Date.parse('2026-09-07T09:59:00.000Z')),
                updatedAt: BigInt(Date.parse('2026-09-07T10:01:00.000Z')),
                usageActorAccountId: f.member.id,
                teamCredentialResourceId: f.resource.id,
                credentialDeliveryMode: 'brokered',
            },
        ] });
        const [daily, monthly] = await Promise.all([
            db.teamCredentialUsageLimit.create({ data: {
                resourceId: f.resource.id,
                subjectKind: 'team_group',
                subjectId: f.currentGroup.id,
                period: 'day',
                metric: 'total_tokens',
                maximum: '100',
                createdAt: new Date('2026-09-01T00:00:00.000Z'),
            } }),
            db.teamCredentialUsageLimit.create({ data: {
                resourceId: f.resource.id,
                subjectKind: 'team_group',
                subjectId: f.currentGroup.id,
                period: 'month',
                metric: 'total_tokens',
                maximum: '100',
                createdAt: new Date('2026-09-01T00:00:00.000Z'),
            } }),
        ]);
        const outsideAdmission = await db.usageEvent.create({ data: {
            accountId: f.member.id,
            sessionId: session.id,
            turnId: outsideTurnId,
            observedAt: new Date('2026-09-06T23:50:00.000Z'),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        } });
        const insideAdmission = await db.usageEvent.create({ data: {
            accountId: f.member.id,
            sessionId: session.id,
            turnId: insideTurnId,
            observedAt: new Date('2026-09-07T10:00:00.000Z'),
            agentId: 'team_credential_broker',
            source: 'team_credential_admission',
            scope: 'turn_delta',
            requestCount: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: f.member.id,
            credentialDeliveryMode: 'brokered',
        } });
        await db.usageEventTeamCredentialGroupAttribution.createMany({ data: [
            { usageEventId: outsideAdmission.id, teamGroupId: f.currentGroup.id },
            { usageEventId: insideAdmission.id, teamGroupId: f.currentGroup.id },
        ] });
        await db.usageEvent.createMany({ data: [
            {
                accountId: f.member.id,
                sessionId: session.id,
                turnId: outsideTurnId,
                observedAt: new Date('2026-09-07T09:00:00.000Z'),
                agentId: 'codex',
                source: 'codex_app_server',
                scope: 'turn_delta',
                totalTokens: 30,
                teamCredentialResourceId: f.resource.id,
                teamCredentialActorAccountId: f.member.id,
                credentialDeliveryMode: 'brokered',
            },
            {
                accountId: f.member.id,
                sessionId: session.id,
                turnId: insideTurnId,
                observedAt: new Date('2026-09-07T10:01:00.000Z'),
                agentId: 'codex',
                source: 'codex_app_server',
                scope: 'turn_delta',
                totalTokens: 20,
                teamCredentialResourceId: f.resource.id,
                teamCredentialActorAccountId: f.member.id,
                credentialDeliveryMode: 'brokered',
            },
        ] });

        const evaluation = await inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
            resourceId: f.resource.id,
            actorAccountId: f.member.id,
            now,
        }));

        expect(evaluation.ok).toBe(true);
        if (!evaluation.ok) throw new Error('expected usage-limit evaluation');
        expect(evaluation.applied).toEqual(expect.arrayContaining([
            expect.objectContaining({ limitId: daily.id, recorded: 20 }),
            expect.objectContaining({ limitId: monthly.id, recorded: 50 }),
        ]));
    });

    it('correlates public-external terminal Group usage to its admission identity and window', async () => {
        const f = await fixture();
        const now = new Date('2026-09-07T12:00:00.000Z');
        const externalApiKey = await db.teamCredentialExternalApiKey.create({ data: {
            resourceId: f.resource.id,
            teamMembershipId: f.memberMembership.id,
            label: 'Windowed external usage',
            displayPrefix: 'hapek_v1_windowed',
            secretDigest: crypto.randomUUID(),
        } });
        const [daily, monthly] = await Promise.all([
            db.teamCredentialUsageLimit.create({ data: {
                resourceId: f.resource.id,
                subjectKind: 'team_group',
                subjectId: f.currentGroup.id,
                period: 'day',
                metric: 'total_tokens',
                maximum: '100',
                createdAt: new Date('2026-09-01T00:00:00.000Z'),
            } }),
            db.teamCredentialUsageLimit.create({ data: {
                resourceId: f.resource.id,
                subjectKind: 'team_group',
                subjectId: f.currentGroup.id,
                period: 'month',
                metric: 'total_tokens',
                maximum: '100',
                createdAt: new Date('2026-09-01T00:00:00.000Z'),
            } }),
        ]);
        const createExternalUsagePair = async (input: Readonly<{
            requestId: string;
            admittedAt: Date;
            completedAt: Date;
            totalTokens: number;
        }>) => {
            const admission = await db.usageEvent.create({ data: {
                accountId: f.member.id,
                observedAt: input.admittedAt,
                agentId: 'team_credential_broker',
                source: 'team_credential_admission',
                scope: 'turn_delta',
                externalKey: input.requestId,
                requestCount: 1,
                teamCredentialResourceId: f.resource.id,
                teamCredentialActorAccountId: f.member.id,
                teamCredentialExternalApiKeyId: externalApiKey.id,
                credentialDeliveryMode: 'external_api',
            } });
            const terminal = await db.usageEvent.create({ data: {
                accountId: f.member.id,
                observedAt: input.completedAt,
                agentId: 'team_credential_broker',
                source: 'team_credential_external_terminal',
                scope: 'turn_delta',
                externalKey: input.requestId,
                totalTokens: input.totalTokens,
                teamCredentialResourceId: f.resource.id,
                teamCredentialActorAccountId: f.member.id,
                teamCredentialExternalApiKeyId: externalApiKey.id,
                credentialDeliveryMode: 'external_api',
            } });
            await db.usageEventTeamCredentialGroupAttribution.createMany({ data: [
                { usageEventId: admission.id, teamGroupId: f.currentGroup.id },
                // A copied relation on the terminal is not admission authority.
                { usageEventId: terminal.id, teamGroupId: f.currentGroup.id },
            ] });
        };
        await createExternalUsagePair({
            requestId: 'external-before-daily-window',
            admittedAt: new Date('2026-09-06T23:50:00.000Z'),
            completedAt: new Date('2026-09-07T09:00:00.000Z'),
            totalTokens: 30,
        });
        await createExternalUsagePair({
            requestId: 'external-inside-daily-window',
            admittedAt: new Date('2026-09-07T10:00:00.000Z'),
            completedAt: new Date('2026-09-07T10:01:00.000Z'),
            totalTokens: 20,
        });

        const evaluation = await inTx((tx) => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
            resourceId: f.resource.id,
            actorAccountId: f.member.id,
            now,
        }));

        expect(evaluation.ok).toBe(true);
        if (!evaluation.ok) throw new Error('expected usage-limit evaluation');
        expect(evaluation.applied).toEqual(expect.arrayContaining([
            expect.objectContaining({ limitId: daily.id, recorded: 20 }),
            expect.objectContaining({ limitId: monthly.id, recorded: 50 }),
        ]));
    });
});
