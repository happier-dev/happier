import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createAgentIsolationOperationContext, createAgentIsolationSessionContext } from './agentIsolationSessionContext';
import { admitAgentIsolationLaunchForHost, resolveHostRequesterAgentPlacementForHost, isHostRequesterUnrestrictedOwner, retainVerifiedExternalActionRequester, selectHostRequesterExecutionIdentity, type HostAgentIsolationLaunchSnapshot } from './agentIsolationLaunchPolicy';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createActionExecutor } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWriteFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/writeFileHandler';
import { deriveAgentIsolationMemberIdentity } from './provisioning';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectServiceMoveStartInput } from '@/daemon/local/services/actions/projectServiceMoveChildren';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { canReadIncompleteSecretMaskingForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import axios from 'axios';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

describe('held Agent isolation launch admission', () => {
    it.each(['owner', 'member'] as const)('uses verified receiving custody for the signed %s Session Action without relabeling its authority', accountId => {
        const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'source-turn', callerPermissionMode: null, requestId: 'approved-terminal' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-root', binding: {
            accountId, custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
            serverIdentityId: 'home', machineId: 'receiver', installationId: 'installation', actionId: 'machines.terminal.open',
            requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'receiver' },
            sessionActionOrigin: origin, sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
        } });
        const input = { hostHomeServerIdentityId: 'home', hostCustodianAccountId: 'owner',
            hostExecutionTarget: { machineId: 'receiver', installationId: 'installation' },
            rpcContext: { signal: new AbortController().signal, callerAuthority: 'account_automation' as const,
                sessionActionOrigin: origin, callerInputAuthorization: authorization,
                machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', machineId: 'receiver',
                    installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
                verifyMachineAdmissionCurrent: async () => true } };
        const identity = selectHostRequesterExecutionIdentity(input);
        expect(identity).toEqual({ kind: 'isolated', requester: { serverId: 'home', accountId, machineId: 'receiver', installationId: 'installation' },
            separationRequired: accountId !== 'owner' });
        expect(isHostRequesterUnrestrictedOwner(identity)).toBe(false);
        expect(selectHostRequesterExecutionIdentity({ ...input,
            sessionRequester: { serverId: 'home', accountId, machineId: 'receiver', installationId: 'installation' },
            sessionRequesterHomeServerIdentityId: 'foreign-home' })).toEqual({ kind: 'unknown', reason: 'session_requester_unavailable' });
        expect(selectHostRequesterExecutionIdentity({ ...input, rpcContext: { ...input.rpcContext,
            machineAdmission: { ...input.rpcContext.machineAdmission, actorAccountId: 'foreign' } } }))
            .toEqual({ kind: 'unknown', reason: 'requester_authority_unavailable' });
    });
    it.skipIf(process.platform !== 'linux')('uses prepared member material for finite Session probes without borrowing native MCP authority', async () => {
        await withTempDir('member-session-probe-', async cwd => {
            for (const [index, accountId] of ['member-a', 'member-b'].entries()) {
                const requester = { serverId: 'saved-profile', accountId, machineId: 'machine', installationId: 'installation' };
                const identity = { kind: 'isolated' as const, separationRequired: true,
                    homeServerIdentityId: 'canonical-home', requester };
                // Prepared identity/material are the Session owner's held output;
                // this consumer neither provisions nor probes an OS account.
                const member = { ...deriveAgentIsolationMemberIdentity(identity), agentUid: 2401 + index, agentGid: 2401 + index };
                const material = { runtimeHome: join(member.home, 'runtime', 'session'), memberIdentity: member,
                    environment: { SELECTED: accountId }, selectedMaterials: [] };
                let held: typeof material | undefined = material;
                const context = createAgentIsolationSessionContext({
                    machine: { read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
                        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [cwd] }) },
                    managedHappierBinaryPath: '/opt/happier/current/happier',
                    sessionRequester: requester, sessionRequesterHomeServerIdentityId: identity.homeServerIdentityId,
                    hostHomeServerIdentityId: identity.homeServerIdentityId, sessionCustodianAccountId: 'owner',
                    resolveRequesterIdentity: async () => identity, readMaterial: () => held,
                });
                const signal = new AbortController().signal;
                const probe = await context.prepareLaunch!({ requesterIdentity: identity, signal });
                expect(probe.read()).toMatchObject({ memberIdentity: member,
                    localTransport: { agentUid: member.agentUid, agentGid: member.agentGid },
                    launch: { runtimeHome: material.runtimeHome, environment: material.environment } });
                expect(probe.read()?.launch?.sessionMcpContext).toBeUndefined();
                await expect(context.prepareLaunch!({ requesterIdentity: identity, signal, agentNativeLaunch: true }))
                    .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
                const foreign = { ...identity, requester: { ...requester, accountId: 'another-member' } };
                await expect(context.prepareLaunch!({ requesterIdentity: foreign, signal }))
                    .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
                held = undefined;
                await expect(context.prepareLaunch!({ requesterIdentity: identity, signal }))
                    .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
            }
        });
    });
    // 2026-11-02 owner ruling: placement follows Machine policy, not requester privilege.
    it.each(['owner', 'manage', 'use'] as const)('preserves %s custody across the guest fallback matrix', async role => {
        const accountId = role === 'owner' ? 'owner' : role;
        const requester = { serverId: 'home', accountId, machineId: 'machine', installationId: 'installation' };
        const identity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home', hostCustodianAccountId: 'owner',
            hostExecutionTarget: { machineId: 'machine', installationId: 'installation' },
            rpcContext: { signal: new AbortController().signal, callerAuthority: 'account_automation',
                machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', machineId: 'machine',
                    installationId: 'installation', role: role === 'manage' ? 'manage' : 'use', encryptionMode: 'plain' },
                verifyMachineAdmissionCurrent: async () => true } });
        expect(identity).toMatchObject({ kind: 'isolated', requester, separationRequired: role === 'use' });
        if (identity.kind !== 'isolated') throw new Error('Expected retained requester custody');
        for (const platform of ['linux', 'darwin', 'win32'] as const) {
            for (const snapshot of [
                { enabled: false }, { enabled: true }, { enabled: true, memberProvisioning: 'linuxUsersV1' as const },
            ]) {
                expect(resolveHostRequesterAgentPlacementForHost({ identity, snapshot, platform }))
                    .toBe(!snapshot.enabled ? 'daemon' : platform === 'linux' && snapshot.memberProvisioning ? 'member' : 'sharedAgent');
            }
        }
        await expect(admitAgentIsolationLaunchForHost({ requesterIdentity: identity, agentNativeLaunch: true,
            context: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) } }))
            .resolves.toBeUndefined();
        if (role === 'use') {
            expect(isHostRequesterUnrestrictedOwner(identity)).toBe(false);
            await expect(admitAgentIsolationLaunchForHost({ requesterIdentity: identity, personBreakGlass: true }))
                .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
        }
    });
    it.skipIf(process.platform !== 'linux')('admits a use guest through shared-user Exec without borrowing owner identity', async () => {
        await withTempDir('guest-shared-exec-', async cwd => {
            const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: 'home',
                requester: { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' } };
            const material = { materializationKey: 'guest-operation', environment: { GUEST_SELECTED: 'selected' }, selectedMaterials: [] };
            // Constructed native observation; no account or process is created by this policy test.
            const target = { runtimeHome: join(cwd, 'runtime', 'guest'), environment: material.environment, selectedMaterials: [] };
            const context = createAgentIsolationOperationContext({ requesterIdentity, signal: new AbortController().signal,
                machine: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
                    workspaceRoots: [cwd] }) }, managedHappierBinaryPath: '/opt/happier/current/happier',
                nativeIdentity: { home: cwd, agentUid: 2401, agentGid: 2401 }, readMaterial: () => material, readTarget: () => target });
            const admitted = await admitAgentIsolationLaunchForHost({ context, cwd, agentNativeLaunch: true });
            expect(context.requesterIdentity).toMatchObject({ requester: requesterIdentity.requester, separationRequired: true });
            expect(admitted?.snapshot.launch).toMatchObject({ runtimeHome: target.runtimeHome, environment: material.environment });
            expect(admitted?.snapshot.memberIdentity).toBeUndefined();
            expect(isHostRequesterUnrestrictedOwner(context.requesterIdentity!)).toBe(false);
        });
    });
    it('reconciles a verified receiving child through the Action adapter without lending native owner custody', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', profileId: 'srv_archive_home' });
        let prepared: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
        try {
            // Substitute only Home HTTP; the installed child producer retains
            // the verified deployment job in its real host-private facet.
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                throw new Error('Unexpected receiving-child Home read');
            });
            prepared = await fixture.prepare();
            const authorization = prepared.authorization;
            const receiving = { actorAccountId: 'bob', custodianAccountId: 'bob', machineId: 'receiver',
                installationId: fixture.installed.installationId, role: 'use' as const, encryptionMode: 'plain' as const };
            const ingress = { signal: new AbortController().signal, callerAuthority: 'account_automation' as const,
                machineAdmission: receiving, callerInputAuthorization: authorization,
                verifyMachineAdmissionCurrent: async () => { throw new Error('Do not re-admit an admitted child'); } };
            const host = { custodianAccountId: 'bob', machineId: 'receiver', installationId: fixture.installed.installationId };
            const effectsFor = (held = host) => createFilesystemEffectAdmission({
                resolveHomeServerIdentityId: async () => fixture.homeIdentityId, resolveHostIdentity: async () => held });
            const effects = effectsFor();
            const context = buildActionExecutorContextForRpc(ingress);
            const selected = await effects.resolveActionRequester!(context);
            try {
                expect(isHostRequesterUnrestrictedOwner(selected.identity)).toBe(true);
                expect(selected.identity).toMatchObject({ requester: { accountId: 'bob', machineId: 'receiver',
                    installationId: fixture.installed.installationId } });
                expect(await effects.action(context, selected.identity)).toBeNull();
            } finally { await selected.dispose(); }
            expect(context.callerInputAuthorization).toBe(authorization);
            expect(authorization.binding.machineId).toBe('controller');
            const serialized = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(authorization)));
            const unretained = buildActionExecutorContextForRpc({ ...ingress, callerInputAuthorization: serialized });
            expect(await effects.action(unretained)).toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            // Public child-shaped data cannot mint the private receiving witness either.
            const publicOnly = { ...serialized, deploymentChild: fixture.job };
            expect(await effects.action(buildActionExecutorContextForRpc({ ...ingress, callerInputAuthorization: publicOnly })))
                .toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            for (const field of ['actorAccountId', 'custodianAccountId', 'machineId', 'installationId'] as const) {
                const mismatch = buildActionExecutorContextForRpc({ ...ingress, machineAdmission: { ...receiving, [field]: 'wrong' } });
                expect(await effects.action(mismatch)).toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            }
            for (const field of ['custodianAccountId', 'machineId', 'installationId'] as const) {
                expect(await effectsFor({ ...host, [field]: 'wrong' }).action(context))
                    .toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            }
            const member = buildActionExecutorContextForRpc({ ...ingress,
                machineAdmission: { ...receiving, custodianAccountId: 'ann' } });
            const foreignEffects = effectsFor({ ...host, custodianAccountId: 'ann' });
            const memberRequester = await foreignEffects.resolveActionRequester!(member);
            try {
                expect(memberRequester.identity).toMatchObject({ kind: 'isolated', separationRequired: true });
                expect(isHostRequesterUnrestrictedOwner(memberRequester.identity)).toBe(false);
                expect(await foreignEffects.action(member, memberRequester.identity))
                    .toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            } finally { await memberRequester.dispose(); }
            const agent = buildActionExecutorContextForRpc({ ...ingress, callerAuthority: 'present_user', localActionContext: {
                actionCaller: { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 } } });
            const agentRequester = await effects.resolveActionRequester!(agent);
            try {
                expect(agentRequester.identity).toMatchObject({ kind: 'isolated', separationRequired: false });
                expect(isHostRequesterUnrestrictedOwner(agentRequester.identity)).toBe(false);
                expect(await effects.action(agent, agentRequester.identity)).toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            } finally { await agentRequester.dispose(); }
        } finally {
            await prepared?.dispose();
            await channel.close();
            vi.restoreAllMocks();
        }
    });
    it('keeps incomplete native logs limited to a genuine person through retained ingress', () => {
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'home', machineId: 'machine',
            installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'daemon.filesystem.writeFile', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine' },
        } });
        // Constructed ingress proof; the real UI/Home regression verifies its producer.
        const retain = (root = authorization) => retainVerifiedExternalActionRequester({ authorization: root,
            isCurrent: async () => { throw new Error('Finite disclosure must not re-admit its original root'); } });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            externalActionExecutionAuthorization: retain() };
        expect(canReadIncompleteSecretMaskingForHost(context)).toBe(true);
        expect(canReadIncompleteSecretMaskingForHost({ ...context, externalActionExecutionAuthorization: authorization })).toBe(false);
        expect(canReadIncompleteSecretMaskingForHost({ ...context,
            externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(context.externalActionExecutionAuthorization))) })).toBe(false);
        expect(canReadIncompleteSecretMaskingForHost({ ...context, approvedActionReplay: {} })).toBe(false);
        expect(canReadIncompleteSecretMaskingForHost({ ...context, authority: 'account_automation' })).toBe(false);
        for (const surface of ['plugin', 'mcp'] as const) expect(canReadIncompleteSecretMaskingForHost({ ...context, surface })).toBe(false);
        const caller = { kind: 'session' as const, sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 };
        const origin = { v: 1 as const, caller, sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'request' };
        expect(canReadIncompleteSecretMaskingForHost({ ...context, externalActionExecutionAuthorization: retain(
            ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: { ...authorization.binding,
                sessionActionOrigin: origin, sessionActionSource: { machineId: 'machine', installationId: 'installation' } } })) })).toBe(false);
        expect(canReadIncompleteSecretMaskingForHost({ ...context, actionCaller: caller })).toBe(false);
        // These host-private fields are retained when a nested executor rebuilds context.
        for (const inheritedLocalActionContext of [{ authority: 'account_automation' as const }, { actionCaller: caller },
            { requesterWorkAttributionV1: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } }]) {
            expect(canReadIncompleteSecretMaskingForHost({ ...context, inheritedLocalActionContext })).toBe(false);
        }
    });
    it('keeps reviewed SOURCE member work isolated at its independently admitted physical worker', async () => {
        const admission = { actorAccountId: 'member', custodianAccountId: 'company', machineId: 'worker',
            installationId: 'worker-installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const workspace = { serverId: 'home', refId: 'source-workspace' };
        const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker' } };
        const move = ProjectServiceRelocateInputV1Schema.parse({ workspace, sourceMachineId: 'source', serviceName: 'web', requestId: 'move',
            currentTarget: { kind: 'managed_service', managedServiceId: 'incumbent', machineId: 'source', workspaceId: 'source-workspace',
                cwd: '/source/project', declaration: { workspaceRefId: 'source-workspace', selection: { kind: 'manifest', name: 'web' } } },
            selectedTarget: { machineId: 'worker' }, destination, desiredPlacement: { workspace, serviceName: 'web',
                expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } });
        const envelope = { v: 1 as const, requestId: 'move', target: { kind: 'machine' as const, machineId: 'source' }, input: move };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'source-root', binding: {
            accountId: 'member', custodianAccountId: 'member', serverIdentityId: 'home', machineId: 'source',
            installationId: 'source-installation', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'projects.service.relocate', requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
        } });
        const targetWorkspace = WorkspaceRefV1Schema.parse({ id: 'worker-workspace', serverId: 'home', machineId: 'worker',
            rootPath: '/worker/project', createdAtMs: 1 });
        const parent = { actionId: 'projects.service.relocate', input: move };
        const child = { action: 'localServices.launcher.start' as const, role: 'service.start',
            input: projectNativeJsonValueForTransport(projectServiceMoveStartInput(move, targetWorkspace)) };
        const context = { authority: 'present_user' as const, runtimeAccountId: 'member',
            externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target, originalActionEnvelope: envelope };
        await expect(invokeHostReviewedChildV1({ parent, child, context, receivingAdmission: admission,
            execute: async (_input, issued) => {
                const rpcContext = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
                    machineAdmission: admission, callerInputAuthorization: authorization,
                    verifyMachineAdmissionCurrent: async () => true, reviewedChildActionContext: issued };
                const select = (received: RpcHandlerContext = rpcContext) => selectHostRequesterExecutionIdentity({ rpcContext: received,
                    hostHomeServerIdentityId: 'home', hostCustodianAccountId: 'company',
                    hostExecutionTarget: { machineId: admission.machineId, installationId: admission.installationId } });
                const identity = select();
                expect(identity).toEqual({ kind: 'isolated', separationRequired: true, presentPerson: true,
                    requester: { serverId: 'home', accountId: 'member', machineId: 'worker', installationId: 'worker-installation' } });
                expect(isHostRequesterUnrestrictedOwner(identity)).toBe(false);
                expect(select({ ...rpcContext, reviewedChildActionContext: undefined, localActionContext: { ...issued } }))
                    .toEqual(identity);
                expect(select({ ...rpcContext, reviewedChildActionContext: { ...context } })).toMatchObject({ kind: 'unknown' });
                expect(select({ ...rpcContext, machineAdmission: { ...admission, custodianAccountId: 'member' } })).toMatchObject({ kind: 'unknown' });
                return { ok: true, result: 'isolated' };
            } })).resolves.toEqual({ ok: true, result: 'isolated' });
    });
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
    it('retains the original admitted requester and observes local cancellation without borrowing another identity', async () => {
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'srv_home', machineId: 'machine',
            installationId: 'installation', authentication: { kind: 'terminal', tokenEpoch: 1 },
            actionId: 'daemon.filesystem.writeFile', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine' },
        } });
        const executor = createActionExecutor(createUnavailableActionTransportDeps());
        Object.defineProperty(authorization, 'requesterAccountExecutor', { value: executor, enumerable: false });
        let current = true, currentReads = 0;
        // Constructed trusted-ingress proof; the composed HTTP test supplies
        // the real Home signer. Only its external currentness fact varies here.
        const retained = retainVerifiedExternalActionRequester({ authorization, isCurrent: async () => { currentReads++; return current; } });
        expect(retained.requesterAccountExecutor).toBe(executor);
        await expect(retained.requesterAccountExecutor?.execute('action.spec.get', { id: 'daemon.filesystem.readFile' },
            { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({ ok: true,
                result: { actionSpec: { id: 'daemon.filesystem.readFile' } } });
        expect(Object.getOwnPropertyDescriptor(retained, 'requesterAccountExecutor')?.enumerable).toBe(false);
        const lifetime = new AbortController();
        const context = { authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
            externalActionExecutionAuthorization: retained, signal: lifetime.signal };
        const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'srv_home',
            resolveHostIdentity: async () => ({ custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' }) });
        expect(await admission.action(context)).toBeNull();
        current = false;
        // Original ingress already verified this finite operation. The effect
        // owner must not turn its opaque Home guard into per-step admission.
        expect(await admission.action(context)).toBeNull();
        await expect(admission.action({ ...context, verifyMachineAdmissionCurrent: async () => false }))
            .resolves.toBeNull();
        await expect(admission.action({ ...context, machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner',
            machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true })).resolves.toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
        await expect(admission.action({ ...context, actionCaller: { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 } }))
            .resolves.toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
        await expect(admission.action({ ...context,
            externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(retained))) }))
            .resolves.toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
        await withTempDir('retained-root-currentness-', async directory => {
            const path = join(directory, 'original.txt');
            await writeFile(path, 'before-admitted-effect');
            const transportContext = { ...context, verifyMachineAdmissionCurrent: async () => true,
                machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                    installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } };
            expect(await admission.action(transportContext)).toBeNull();
            const write = createWriteFileRpcActionExecutor({ workingDirectory: directory, accessPolicy: { kind: 'osUser' },
                getAdditionalAllowedWriteDirs: () => [] });
            const result = await write.execute('daemon.filesystem.writeFile', {
                rootPath: directory, path, content: Buffer.from('admitted-effect').toString('base64'),
            }, transportContext);
            expect(result).toMatchObject({ ok: true, result: { success: true } });
            expect(await readFile(path, 'utf8')).toBe('admitted-effect');
            expect(await admission.action(transportContext)).toBeNull();
            // The real local Machine invoke retains original Action context
            // separately from its installed Account custody/currentness guard.
            const delegated = { signal: context.signal, callerAuthority: 'account_automation' as const,
                machineAdmission: transportContext.machineAdmission, verifyMachineAdmissionCurrent: transportContext.verifyMachineAdmissionCurrent,
                localActionContext: { authority: context.authority, actionCaller: context.actionCaller,
                    externalActionExecutionAuthorization: retained } };
            expect(await admission.rpc(delegated)).toBeNull();
            lifetime.abort();
            const cancelled = await write.execute('daemon.filesystem.writeFile', {
                rootPath: directory, path, content: Buffer.from('must-not-write').toString('base64'),
            }, transportContext);
            expect(cancelled).toMatchObject({ ok: true, result: { success: false } });
            expect(await readFile(path, 'utf8')).toBe('admitted-effect');
            await expect(admission.action(transportContext)).resolves.toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
            await expect(admission.rpc(delegated)).resolves.toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
        });
        expect(currentReads).toBe(0);
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
    it.each([false, true])('records only the closed native refusal even when file logging fails (%s)', async loggingFails => {
        const write = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {
            if (loggingFails) throw new Error('File logging boundary unavailable');
        });
        try {
            await expect(admitAgentIsolationLaunchForHost({ agentNativeLaunch: true, agentLaunchKind: 'acp',
                cwd: '/private-path-must-not-be-logged', requesterIdentity: { kind: 'unknown', reason: 'session_requester_unavailable' },
                context: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
            })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false,
                data: { details: { reason: 'session_requester_unavailable' } } });
            expect(write).toHaveBeenCalledExactlyOnceWith('[P11] Native execution admission refused', {
                code: 'agent_isolation_unavailable', reason: 'session_requester_unavailable',
                launchKind: 'acp', phase: 'native_execution_admission',
            });
        } finally { write.mockRestore(); }
    });
    it('reconciles only a verified SOURCE tuple without lending the physical receiver custody', () => {
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home', binding: {
            accountId: 'target-owner', custodianAccountId: 'source-custodian', serverIdentityId: 'home',
            machineId: 'source', installationId: 'source-installation', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'session.handoff', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'source' },
        } });
        const target = { actorAccountId: 'target-owner', custodianAccountId: 'target-owner', machineId: 'target', installationId: 'target-installation' };
        const input = { hostHomeServerIdentityId: 'home', rpcContext: {
            signal: new AbortController().signal, callerAuthority: 'account_automation' as const, callerInputAuthorization,
            machineAdmission: { ...target, custodianAccountId: 'target-owner', role: 'manage' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true,
        } };
        expect(selectHostRequesterExecutionIdentity(input)).toMatchObject({ kind: 'unknown' });
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input,
            verifiedReceivingChild: target }))).toBe(true);
        for (const key of ['actorAccountId', 'custodianAccountId', 'machineId', 'installationId'] as const) {
            expect(selectHostRequesterExecutionIdentity({ ...input,
                verifiedReceivingChild: { ...target, [key]: 'unverified' } })).toMatchObject({ kind: 'unknown' });
        }
        const physicalCompany = selectHostRequesterExecutionIdentity({ ...input,
            verifiedReceivingChild: target, hostCustodianAccountId: 'company-custodian',
            hostExecutionTarget: { machineId: 'physical-parent', installationId: 'physical-installation' } });
        expect(physicalCompany).toMatchObject({ kind: 'isolated', separationRequired: true,
            requester: { accountId: 'target-owner', machineId: 'physical-parent', installationId: 'physical-installation' } });
        expect(isHostRequesterUnrestrictedOwner(physicalCompany)).toBe(false);
    });
    it('keeps owned Account automation distinct from genuine Session or copied Agent custody', () => {
        const rpcContext = { signal: new AbortController().signal, callerAuthority: 'account_automation' as const,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true };
        const input = { rpcContext, hostHomeServerIdentityId: 'home' };
        const selected = selectHostRequesterExecutionIdentity(input);
        expect(selected).toMatchObject({ kind: 'isolated',
            separationRequired: false, accountAutomation: true });
        expect(isHostRequesterUnrestrictedOwner(selected)).toBe(true);
        const caller = { kind: 'session' as const, sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 };
        expect(selectHostRequesterExecutionIdentity({ ...input,
            rpcContext: { ...rpcContext, localActionContext: { actionCaller: caller } } }))
            .not.toHaveProperty('accountAutomation');
        expect(selectHostRequesterExecutionIdentity({ ...input,
            rpcContext: { ...rpcContext, callerAuthority: 'present_user', localActionContext: { actionCaller: caller } } }))
            .toMatchObject({ kind: 'isolated' });
        for (const localActionContext of [{ actionCaller: caller }, { authority: 'account_automation' as const }]) {
            expect(selectHostRequesterExecutionIdentity({ ...input,
                rpcContext: { ...rpcContext, callerAuthority: 'present_user', localActionContext } }))
                .not.toHaveProperty('presentPerson');
        }
        const origin = { v: 1 as const, caller, sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'request' };
        expect(selectHostRequesterExecutionIdentity({ ...input, rpcContext: { ...rpcContext, sessionActionOrigin: origin } }))
            .toMatchObject({ kind: 'isolated', separationRequired: false });
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input,
            rpcContext: { ...rpcContext, sessionActionOrigin: origin, admittedHostWorkflowRequester: true },
        }))).toBe(false);
        expect(selectHostRequesterExecutionIdentity({ actionContext: { machineAdmission: rpcContext.machineAdmission,
            authority: 'account_automation', actionCaller: caller, verifyMachineAdmissionCurrent: async () => true },
            hostHomeServerIdentityId: 'home' })).not.toHaveProperty('accountAutomation');
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home', binding: {
            accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
            authentication: { kind: 'account', tokenEpoch: 1 }, actionId: 'projects.compute.exec', requestId: 'request',
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' }, sessionActionOrigin: origin,
            sessionActionSource: { machineId: 'machine', installationId: 'installation' },
        } });
        expect(selectHostRequesterExecutionIdentity({ ...input,
            rpcContext: { ...rpcContext, callerInputAuthorization: authorization } })).toMatchObject({ kind: 'isolated', separationRequired: false });
        expect(selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home', actionContext: {
            authority: 'account_automation', machineAdmission: rpcContext.machineAdmission,
            verifyMachineAdmissionCurrent: async () => true, externalActionExecutionAuthorization: authorization,
        } })).toMatchObject({ kind: 'isolated', separationRequired: false });
        const nonsession = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
            binding: { ...authorization.binding, sessionActionOrigin: undefined, sessionActionSource: undefined } });
        for (const [localActionContext, inheritedLocalActionContext] of [
            [{ externalActionExecutionAuthorization: authorization }, { authority: 'account_automation' as const }],
            [{ authority: 'account_automation' as const }, { externalActionExecutionAuthorization: authorization }],
        ]) {
            expect(selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home', actionContext: {
                authority: 'account_automation', machineAdmission: rpcContext.machineAdmission,
                verifyMachineAdmissionCurrent: async () => true, callerInputAuthorization: nonsession,
                localActionContext, inheritedLocalActionContext,
            } })).toMatchObject({ kind: 'isolated', separationRequired: false });
        }
        for (const principal of [{ kind: 'session' as const, sessionId: caller.sessionId }, { kind: 'host' as const }]) {
            const workflow = ExternalActionExecutionAuthorizationV1Schema.parse({ ...nonsession, binding: {
                ...nonsession.binding, workflowActionOrigin: { runId: 'workflow-run', requestId: 'request', sessionAuthority: {
                    authorization: { admittedPermissionCeiling: 'default', principal }, runDepth: 0, directory: '/workspace', workspaceWrites: 'allow',
                } },
            } });
            const identity = selectHostRequesterExecutionIdentity({ ...input,
                rpcContext: { ...rpcContext, callerInputAuthorization: workflow } });
            expect(isHostRequesterUnrestrictedOwner(identity)).toBe(principal.kind === 'host');
            expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input,
                rpcContext: { ...rpcContext, callerInputAuthorization: workflow, admittedHostWorkflowRequester: true },
            }))).toBe(principal.kind === 'host');
        }
        expect(selectHostRequesterExecutionIdentity({ ...input, rpcContext: {
            ...rpcContext, admittedHostWorkflowRequester: true, callerInputAuthorization: nonsession,
            machineAdmission: { ...rpcContext.machineAdmission, actorAccountId: 'other-account' },
        } })).toMatchObject({ kind: 'unknown' });
    });
    it('selects a closed authenticated Account Agent without fabricating Session birth or person presence', async () => {
        const hostAccountAgent = { accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' };
        const input = { hostAccountAgent, hostHomeServerIdentityId: 'srv_actual_home' };
        const identity = selectHostRequesterExecutionIdentity(input);
        expect(identity).toEqual({ kind: 'isolated', separationRequired: false, requester: {
            serverId: 'srv_actual_home', accountId: 'owner', machineId: 'machine', installationId: 'installation',
        } });
        expect(selectHostRequesterExecutionIdentity({ ...input, hostAccountAgent: { ...hostAccountAgent, accountId: 'member' } }))
            .toMatchObject({ kind: 'isolated', separationRequired: true });
        for (const hostHomeServerIdentityId of [undefined, null, '']) {
            expect(selectHostRequesterExecutionIdentity({ hostAccountAgent, hostHomeServerIdentityId })).toMatchObject({ kind: 'unknown' });
        }
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: {} })).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, sessionRequester: {
            serverId: 'profile', accountId: 'owner', machineId: 'machine', installationId: 'installation',
        } })).toMatchObject({ kind: 'unknown' });
        await expect(admitAgentIsolationLaunchForHost({ requesterIdentity: identity, personBreakGlass: true }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    });
    it('retains closed authenticated API Account administration without granting Agent or person authority', async () => {
        const hostAccountAutomation = { accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' };
        const input = { hostAccountAutomation, hostHomeServerIdentityId: 'home' };
        const identity = selectHostRequesterExecutionIdentity(input);
        expect(identity).toMatchObject({ kind: 'isolated', separationRequired: false, accountAutomation: true });
        expect(isHostRequesterUnrestrictedOwner(identity)).toBe(true);
        expect(isHostRequesterUnrestrictedOwner(selectHostRequesterExecutionIdentity({ ...input,
            hostAccountAutomation: { ...hostAccountAutomation, accountId: 'member' } }))).toBe(false);
        expect(selectHostRequesterExecutionIdentity({ ...input, hostAccountAgent: hostAccountAutomation })).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, actionContext: {} })).toMatchObject({ kind: 'unknown' });
        await expect(admitAgentIsolationLaunchForHost({ requesterIdentity: identity, personBreakGlass: true }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    });
    it.skipIf(process.platform !== 'linux')('prepares ordinary Account Session material with its qualified host Home without private birth', async () => {
        await withTempDir('ordinary-account-isolation-', async home => {
            const hostHomeServerIdentityId = 'srv_actual_home';
            const identity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId,
                hostAccountAgent: { accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' } });
            const material = { runtimeHome: join(home, 'runtime'), environment: { SELECTED: 'owner' }, selectedMaterials: [] };
            const input = { managedHappierBinaryPath: '/opt/happier/current/happier', hostHomeServerIdentityId,
                sessionCustodianAccountId: 'owner', readMaterial: () => material,
                machine: { read: (): HostAgentIsolationLaunchSnapshot => ({ enabled: true,
                    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [home] }) } };
            const context = createAgentIsolationSessionContext(input);
            const mcpLaunchMaterial = { ...material, nativeIdentity: { home, agentUid: 2401, agentGid: 2401 } };
            const prepared = await context.prepareLaunch!({ requesterIdentity: identity, mcpLaunchMaterial,
                signal: new AbortController().signal });
            expect(prepared.read()).toMatchObject({ localTransport: { agentUid: 2401, agentGid: 2401 },
                launch: { runtimeHome: material.runtimeHome, environment: material.environment } });
            await expect(context.prepareLaunch!({ requesterIdentity: { kind: 'unknown', reason: 'session_requester_unavailable' },
                mcpLaunchMaterial, signal: new AbortController().signal }))
                .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
            // A retained foreign birth remains authoritative; actual host Home
            // cannot turn that rejected custody into an ordinary Account launch.
            const foreign = createAgentIsolationSessionContext({ ...input, sessionRequester: {
                serverId: 'saved-profile', accountId: 'owner', machineId: 'machine', installationId: 'installation',
            }, sessionRequesterHomeServerIdentityId: 'srv_foreign_home' });
            await expect(admitAgentIsolationLaunchForHost({ context: foreign, cwd: home, agentNativeLaunch: true }))
                .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
        });
    });
    it('qualifies opaque birth profiles with their retained Home and refuses retargeted or historical custody', () => {
        const requester = { serverId: 'my-saved-profile', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
        const input = { sessionRequester: requester, sessionCustodianAccountId: 'owner', hostHomeServerIdentityId: 'srv_birth_home' };
        expect(selectHostRequesterExecutionIdentity({ ...input, sessionRequesterHomeServerIdentityId: 'srv_birth_home' }))
            .toEqual({ kind: 'isolated', requester, separationRequired: false });
        expect(selectHostRequesterExecutionIdentity(input)).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, sessionRequesterHomeServerIdentityId: 'srv_foreign_home' }))
            .toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, hostHomeServerIdentityId: 'srv_profile_retargeted',
            sessionRequesterHomeServerIdentityId: 'srv_birth_home' })).toMatchObject({ kind: 'unknown' });
        expect(selectHostRequesterExecutionIdentity({ ...input, hostHomeServerIdentityId: null,
            sessionRequesterHomeServerIdentityId: 'srv_birth_home' })).toMatchObject({ kind: 'unknown' });
    });
    it('preserves the owner Agent opt-out and refuses unknown historical Session custody before material access', async () => {
        const machine = { read: () => ({ enabled: false, status: { kind: 'disabled' as const }, workspaceRoots: [] }) };
        let materialReads = 0;
        const input = { machine, managedHappierBinaryPath: undefined, readMaterial: () => { materialReads++; return undefined; } };
        const requester = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
        const owner = createAgentIsolationSessionContext({ ...input, sessionRequester: requester, sessionCustodianAccountId: 'owner',
            hostHomeServerIdentityId: 'home', sessionRequesterHomeServerIdentityId: 'home' });
        await expect(admitAgentIsolationLaunchForHost({ context: owner, agentNativeLaunch: true })).resolves.toBeUndefined();
        const historical = createAgentIsolationSessionContext(input);
        await expect(admitAgentIsolationLaunchForHost({ context: historical, agentNativeLaunch: true }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
        expect(materialReads).toBe(0);
    });
    it.skipIf(process.platform !== 'linux')('retains admitted placement when policy changes during preparation', async () => {
        await withTempDir('agent-isolation-member-recheck-', async cwd => {
            const snapshot: HostAgentIsolationLaunchSnapshot = { enabled: true,
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [cwd],
                localTransport: { agentUid: 1001 }, launch: { managedHappierBinaryPath: '/managed/happier',
                    runtimeHome: '/agent/runtime', selectedEnvironmentKeys: [], selectedMaterials: [] } };
            const context = { requesterIdentity: { kind: 'isolated' as const, separationRequired: true,
                requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } },
                read: () => snapshot, prepareLaunch: async () => ({ read: () => ({ ...snapshot, enabled: false }) }) };
            await expect(admitAgentIsolationLaunchForHost({ context, cwd, agentNativeLaunch: true }))
                .resolves.toMatchObject({ cwd, snapshot: { enabled: true } });
        });
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
    it.each([false, true])('uses the disabled-policy fallback and refuses an enabled unready transport (enabled=%s)', async enabled => {
        const context = { requesterIdentity: { kind: 'isolated' as const, separationRequired: true, requester: {
            serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation',
        } }, read: () => ({ enabled, status: { kind: 'disabled' as const }, workspaceRoots: [] }) };
        const admission = admitAgentIsolationLaunchForHost({ context, hostNativeSystemTool: true });
        if (enabled) await expect(admission).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
        else await expect(admission).resolves.toBeUndefined();
    });
    it.skipIf(process.platform !== 'linux')('prepares material only for admitted Workspace launches and refuses missing native transport', async () => {
        await withTempDir('agent-isolation-current-', async cwd => {
            const snapshot: HostAgentIsolationLaunchSnapshot = { enabled: true,
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [cwd] };
            let prepared = 0;
            const context = { read: () => snapshot, prepareLaunch: async () => {
                prepared++;
                return { read: () => ({ ...snapshot, status: { kind: 'applying' as const, phase: 'runtime_replacement' as const } }) };
            } };
            await expect(admitAgentIsolationLaunchForHost({ context, cwd: '/tmp' })).resolves.toBeUndefined();
            expect(prepared).toBe(0);
            await expect(admitAgentIsolationLaunchForHost({ context, cwd, agentNativeLaunch: true }))
                .rejects.toMatchObject({ data: { details: { reason: 'launch_probe_failed' } } });
            expect(prepared).toBe(1);
        });
    });
    it.skipIf(process.platform !== 'linux').each(['exec', 'acp', 'managedService', 'terminal', 'attach', 'workspaceExec'] as const)(
        'keeps %s at its admitted transport boundary', async agentLaunchKind => {
            await withTempDir('agent-isolation-kinds-', async cwd => {
                // Synthetic observation exercises policy only; it is not native launch/custody proof.
                const snapshot: HostAgentIsolationLaunchSnapshot = {
                    enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
                    workspaceRoots: [cwd], localTransport: { agentUid: 1001 },
                    launch: { managedHappierBinaryPath: '/opt/happier/current/happier', runtimeHome: '/var/lib/happier-agent/runtime',
                        selectedEnvironmentKeys: [], selectedMaterials: [] },
                };
                let reads = 0;
                const context = { read: () => { reads++; return snapshot; } };
                const admission = admitAgentIsolationLaunchForHost({ context, cwd,
                    agentNativeLaunch: agentLaunchKind !== 'workspaceExec', agentLaunchKind });
                if (agentLaunchKind === 'attach') {
                    await expect(admission).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false,
                        data: { details: { reason: 'agent_launch_kind_unavailable', launchKind: agentLaunchKind } } });
                } else {
                    await expect(admission).resolves.toMatchObject({ cwd });
                }
                // One held read per launch; no inventory/remote policy loader is introduced.
                expect(reads).toBe(1);
            });
        });
});
