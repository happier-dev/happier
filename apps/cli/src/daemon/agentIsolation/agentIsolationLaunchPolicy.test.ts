import { describe, expect, it } from 'vitest';
import { isHostRequesterUnrestrictedOwner, selectHostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { deriveAgentIsolationMemberIdentity } from './provisioning';

describe('held Agent isolation launch admission', () => {
    it('qualifies canonical Home separately without widening the bare requester identity', () => {
        const hostAccount = { accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' };
        for (const field of ['hostAccountAgent', 'hostAccountAutomation'] as const) {
            expect(selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'canonical-home', [field]: hostAccount }))
                .toMatchObject({ kind: 'isolated', requester: { accountId: 'owner', serverId: 'canonical-home' } });
        }
        const sessionRequester = { serverId: 'saved-profile', accountId: 'member', machineId: 'machine', installationId: 'installation' };
        const qualifiedDigests = new Set<string>();
        for (const home of ['canonical-home-a', 'canonical-home-b']) {
            const identity = selectHostRequesterExecutionIdentity({ sessionRequester, sessionRequesterHomeServerIdentityId: home,
                sessionCustodianAccountId: 'owner' });
            expect(identity).toEqual({ kind: 'isolated', requester: sessionRequester, separationRequired: true });
            if (identity.kind !== 'isolated') throw new Error('Qualified Session requester unavailable');
            qualifiedDigests.add(deriveAgentIsolationMemberIdentity({ ...identity, homeServerIdentityId: home }).digest);
            for (const actorAccountId of ['owner', 'member']) {
                const selected = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: home, rpcContext: {
                    signal: new AbortController().signal, callerAuthority: 'present_user',
                    machineAdmission: { ...hostAccount, actorAccountId, role: 'manage', encryptionMode: 'plain' },
                    verifyMachineAdmissionCurrent: async () => true,
                } });
                expect(selected).toMatchObject({ kind: 'owner_person',
                    requester: { accountId: actorAccountId, serverId: home } });
                expect(selected).not.toHaveProperty('presentPerson');
            }
        }
        expect(qualifiedDigests.size).toBe(2);
        expect(selectHostRequesterExecutionIdentity({ sessionRequester, sessionCustodianAccountId: 'owner' }))
            .toMatchObject({ kind: 'unknown', reason: 'session_requester_unavailable' });
        expect(selectHostRequesterExecutionIdentity({ sessionRequester, sessionRequesterHomeServerIdentityId: 'birth-home',
            hostHomeServerIdentityId: 'foreign-home', sessionCustodianAccountId: 'owner' }))
            .toMatchObject({ kind: 'unknown', reason: 'session_requester_unavailable' });
    });
    it('consumes authenticated local root custody without lending it to signed, foreign or Session work', () => {
        const authenticatedLocalRootCustody = { serverIdentityId: 'srv_home', accountId: 'owner',
            machineId: 'machine', installationId: 'installation' };
        const actionContext = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            authenticatedLocalRootCustody, signal: new AbortController().signal };
        const input = { hostHomeServerIdentityId: 'srv_home', hostCustodianAccountId: 'owner',
            hostExecutionTarget: { machineId: 'machine', installationId: 'installation' }, actionContext };
        expect(selectHostRequesterExecutionIdentity(input)).toMatchObject({ kind: 'owner_person', requester: {
            serverId: 'srv_home', accountId: 'owner', machineId: 'machine', installationId: 'installation',
        } });
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input,
            actionContext: { ...actionContext, authority: 'account_automation' } }))).toBe(true);
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: undefined,
            rpcContext: { signal: actionContext.signal, localActionContext: { ...actionContext, authority: 'account_automation' } } }))
            .toMatchObject({ kind: 'isolated', separationRequired: false, accountAutomation: true });
        for (const changed of [{ serverIdentityId: 'other-home' }, { accountId: 'other-account' },
            { machineId: 'other-machine' }, { installationId: 'other-installation' }]) {
            expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
                authenticatedLocalRootCustody: { ...authenticatedLocalRootCustody, ...changed } } })).toMatchObject({ kind: 'unknown' });
        }
        const aborted = new AbortController();
        aborted.abort();
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext, signal: aborted.signal } }))
            .toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            authenticatedLocalRootCustody: undefined } })).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            actionCaller: { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 } } }))
            .toMatchObject({ kind: 'unknown' });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'foreign-root', binding: {
            accountId: 'member', custodianAccountId: 'owner', serverIdentityId: 'srv_home', machineId: 'machine',
            installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'daemon.filesystem.readFile', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine' },
        } });
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            externalActionExecutionAuthorization: authorization } })).toMatchObject({ kind: 'unknown' });
        const isCurrent = async () => true;
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            externalActionExecutionAuthorization: authorization,
            verifiedExternalActionRequester: { authorization, isCurrent }, verifyMachineAdmissionCurrent: isCurrent } }))
            .toMatchObject({ kind: 'isolated', separationRequired: true, requester: { accountId: 'member' } });
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: isCurrent } }))
            .toMatchObject({ kind: 'owner_person', requester: { accountId: 'member' } });
    });
    it('qualifies only an originally verified Action requester against the physical receiver', () => {
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home', binding: {
            accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'srv_home', machineId: 'machine',
            installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'daemon.filesystem.readFile', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine' },
        } });
        const isCurrent = async () => true;
        const actionContext = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            externalActionExecutionAuthorization: authorization,
            verifiedExternalActionRequester: { authorization, isCurrent }, verifyMachineAdmissionCurrent: isCurrent };
        const input = { hostHomeServerIdentityId: 'srv_home', hostCustodianAccountId: 'owner',
            hostExecutionTarget: { machineId: 'machine', installationId: 'installation' }, actionContext };
        expect(selectHostRequesterExecutionIdentity(input)).toMatchObject({ kind: 'owner_person', requester: { accountId: 'owner' } });
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input,
            actionContext: { ...actionContext, authority: 'account_automation' } }))).toBe(true);
        expect(selectHostRequesterExecutionIdentity({ ...input,
            actionContext: { ...actionContext, verifiedExternalActionRequester: undefined } })).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, hostHomeServerIdentityId: 'srv_foreign' })).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, hostExecutionTarget: { machineId: 'other', installationId: 'installation' } }))
            .toMatchObject({ kind: 'unknown' });
        const memberAuthorization = { ...authorization, binding: { ...authorization.binding, accountId: 'member' } };
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input, actionContext: {
            ...actionContext, externalActionExecutionAuthorization: memberAuthorization,
            verifiedExternalActionRequester: { authorization: memberAuthorization, isCurrent: async () => true },
        } }))).toBe(false);
        for (const admittedMachineRole of ['manage', 'use', undefined] as const) {
            const admitted = { ...memberAuthorization, binding: { ...memberAuthorization.binding, admittedMachineRole } };
            expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input, actionContext: {
                ...actionContext, externalActionExecutionAuthorization: admitted,
                verifiedExternalActionRequester: { authorization: admitted, isCurrent },
            } }))).toBe(admittedMachineRole === 'manage');
            expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input, actionContext: {
                ...actionContext, externalActionExecutionAuthorization: admitted,
                verifiedExternalActionRequester: { authorization: admitted, isCurrent },
                machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
                    installationId: 'installation', role: 'use', encryptionMode: 'plain' },
                verifyMachineAdmissionCurrent: isCurrent,
            } }))).toBe(false);
        }
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            machineAdmission: { actorAccountId: 'other', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
        } })).toMatchObject({ kind: 'unknown' });
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input, actionContext: { ...actionContext,
            actionCaller: { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 },
        } }))).toBe(false);
    });
    it('selects unrestricted people from Manage on this Machine and preserves Use and Session identity', () => {
        const requester = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
        const rpcContext = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true };
        expect(selectHostRequesterExecutionIdentity({ rpcContext, hostHomeServerIdentityId: 'home' }))
            .toEqual({ kind: 'owner_person', requester });
        expect(selectHostRequesterExecutionIdentity({ rpcContext: { ...rpcContext,
            machineAdmission: { ...rpcContext.machineAdmission, actorAccountId: 'member' } }, hostHomeServerIdentityId: 'home' }))
            .toEqual({ kind: 'owner_person', requester: { ...requester, accountId: 'member' } });
        const member = { ...rpcContext, machineAdmission: { ...rpcContext.machineAdmission, actorAccountId: 'member' } };
        const memberInput = { rpcContext: member, hostHomeServerIdentityId: 'home' };
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...memberInput,
            rpcContext: { ...member, callerAuthority: 'account_automation' } }))).toBe(true);
        expect(selectHostRequesterExecutionIdentity({ ...memberInput,
            rpcContext: { ...member, machineAdmission: { ...member.machineAdmission, role: 'use' } } }))
            .toMatchObject({ kind: 'isolated', separationRequired: true });
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...memberInput,
            hostExecutionTarget: { machineId: 'other-machine', installationId: 'installation' } }))).toBe(false);
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...memberInput,
            hostExecutionTarget: { machineId: 'machine', installationId: 'other-installation' } }))).toBe(false);
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...memberInput,
            hostCustodianAccountId: 'other-custodian' }))).toBe(false);
        expect(selectHostRequesterExecutionIdentity({ rpcContext: { ...rpcContext, callerAuthority: 'account_automation' },
            hostHomeServerIdentityId: 'home', sessionRequesterHomeServerIdentityId: 'home',
            sessionRequester: { ...requester, accountId: 'birth-requester' } }))
            .toEqual({ kind: 'isolated', requester: { ...requester, accountId: 'birth-requester' }, separationRequired: true });
        expect(selectHostRequesterExecutionIdentity({ sessionRequester: requester, sessionCustodianAccountId: 'owner',
            hostHomeServerIdentityId: 'home', sessionRequesterHomeServerIdentityId: 'home' }))
            .toEqual({ kind: 'isolated', requester, separationRequired: false });
        expect(selectHostRequesterExecutionIdentity({ rpcContext })).toMatchObject({ kind: 'unknown' });
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home', binding: {
            accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
            authentication: { kind: 'account', tokenEpoch: 1 }, actionId: 'projects.compute.exec', requestId: 'request',
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        expect(selectHostRequesterExecutionIdentity({ rpcContext: { ...rpcContext, callerInputAuthorization }, hostHomeServerIdentityId: null }))
            .toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ rpcContext: { ...rpcContext, callerInputAuthorization } }))
            .toMatchObject({ kind: 'owner_person' });
    });
});
