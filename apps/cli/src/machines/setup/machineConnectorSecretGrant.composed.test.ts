import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { encodeBase64, verifyMachineInstallationProof, type ActionExecutorContext, type MachineAdminAccessObservationV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeDeploymentChildExecutionV1,
    verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEPLOYMENT_DOMAINS_REMOVE_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectDeploymentChildRoutingV1 } from '@happier-dev/protocol/deployments/deploymentChildRoutingV1';
import { DeploymentDomainChildRpcV1Schema } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { computeEnvironmentSecretLaunchAdmissionDigestV1 } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncSourceExecutionV1Schema } from '@happier-dev/protocol/socketRpc';
import { checkElevatedMachineSetupPlan, runElevatedEffect, type MachineElevationDependencies,
    type MachineElevationSpawn } from '../adminAccess/runElevatedEffect';
import { writeMachineConnectorSecretGrantForHost, type MachineConnectorSecretGrantHostRequest } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import type { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import * as installationStore from '@/daemon/identity/store';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createExternalActionMachineRpcExecution, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { runMachineSetupEffectInternal } from './effectInternal';

const roots: string[] = [];
const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Real temporary bytes and inode lifecycle, with only privileged OS metadata substituted. */
function protectedConnectorFilesystem(root: string) {
    const actualLstat = filesystem.lstat, actualChown = filesystem.chown;
    const ownership = new Map<string, { uid: number; gid: number }>();
    const ancestors = new Set<string>();
    for (let parent = root; ; parent = dirname(parent)) {
        ancestors.add(parent);
        if (dirname(parent) === parent) break;
    }
    const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`);
    vi.spyOn(filesystem, 'lstat').mockImplementation(async (path, options) => {
        const stat = await actualLstat(path, options);
        const name = String(path), fixtureDirectory = stat.isDirectory() && inside(name);
        const outsideAncestor = ancestors.has(name) && !inside(name);
        const owner = ownership.get(stat.ino.toString()) ?? (fixtureDirectory || outsideAncestor ? { uid: 0, gid: 0 } : undefined);
        // /tmp is not protected on the real host. Project that OS boundary only;
        // fixture directory modes and all real symlink/type facts remain intact.
        const mode = outsideAncestor ? Number(stat.mode) & ~0o022 : Number(stat.mode);
        return Object.assign(stat, {
            ...(owner ? { uid: typeof stat.uid === 'bigint' ? BigInt(owner.uid) : owner.uid,
                gid: typeof stat.gid === 'bigint' ? BigInt(owner.gid) : owner.gid } : {}),
            mode: typeof stat.mode === 'bigint' ? BigInt(mode) : mode,
        });
    });
    vi.spyOn(filesystem, 'chown').mockImplementation(async (path, owner, group) => {
        if (!inside(String(path))) return actualChown(path, owner, group);
        ownership.set((await actualLstat(path)).ino.toString(), { uid: owner, gid: group });
    });
    return { ancestors, ownership, readBoundary: vi.spyOn(filesystem, 'readFile') };
}

describe.runIf(process.platform !== 'win32')('Machine connector grant through the installed elevated entry', () => {
    it.each(['owner', 'external', 'teardown'] as const)('opens only in the elevated invocation, installs privately and admits %s authority at the next acquisition', async authority => {
        const root = await mkdtemp(join(await realpath(tmpdir()), 'happier-connector-grant-')); roots.push(root);
        const protectedFs = protectedConnectorFilesystem(root);
        const parent = join(root, 'protected');
        await mkdir(parent, { mode: 0o700 });
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
        const identityFile = join(root, 'installation.json');
        await writeFile(identityFile, JSON.stringify({ version: 1, createdAt: 1, installationId: 'installation',
            publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') }), { mode: 0o600 });
        await chmod(identityFile, 0o600);
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
        let context: ActionExecutorContext = { operationAcceptance: { operationId: 'operation', accept() {} } };
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'machine', installationId: 'installation',
            provider: { pluginId: 'example.network', localId: 'connector' }, connectorId: 'connector' };
        let current = true, inChild = false, installedReads = 0, retireOnRead = false;
        let parentAdmissions = 0, connectorAdmissions = 0;
        let retirementPacket: ReturnType<typeof WorkspaceSyncSourceExecutionV1Schema.parse> | undefined;
        if (authority === 'external') {
            const channel = await createRequesterCurrentnessSocketHarness();
            onTestFinished(() => channel.close());
            // Home transport is the boundary; use both real requester projection
            // owners so neither private port nor its signer is a stand-in.
            vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
            vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-proof', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 0 },
                accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
                actionId: 'machines.setup.apply', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
                target: { kind: 'machine', machineId: 'machine' },
            } });
            const projected = await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'home',
                bootstrap: { credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.test',
                    isCurrent: async () => current, attribution: { serverId: 'home', accountId: 'owner',
                        machineId: 'machine', installationId: 'installation' } } });
            if (!projected) throw new Error('Expected real requester Account custody');
            const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: projected,
                serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
                target: authorization.binding.target, installationId: 'installation', privateKey: keys.secretKey });
            if (!carrier) throw new Error('Expected real requester HTTP custody');
            context = { ...context, externalActionExecutionAuthorization: carrier };
        }
        const readIdentity = installationStore.readInstallationIdentityIfExistsSync;
        // Parent/child native home directories are the OS boundary in this
        // in-process sudo fixture. The child must supply its explicit locator.
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(path =>
            inChild ? readIdentity(path) : readIdentity(path ?? identityFile));
        const request = { credentials: { token }, context, signal: new AbortController().signal,
            serverHttpBaseUrl: 'https://home.test', serverId: 'home', hostMachineId: 'machine', hostInstallationId: 'installation',
            installationIdentityFile: identityFile, subject,
            async assertCurrent() {
                connectorAdmissions += 1;
                if (!current) throw Object.assign(new Error('approval_stale'), { code: 'approval_stale' });
            },
        } satisfies MachineConnectorSecretGrantHostRequest;
        let stored: ReturnType<typeof sealMachineSecretGrant> | undefined;
        const secrets = ['\uFEFFfirst-connector-secret', 'rotated-connector-secret'] as const;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = config.data;
            expect(config.url).toBe('https://home.test/v1/deployments/machines/machine/connector-secret-grant');
            expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'machine', installationId: 'installation', accountId: 'owner',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            if (authority === 'external') {
                expect(config.headers).not.toHaveProperty('Authorization');
                expect(config.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('requester-proof');
                expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'requester-proof', effectActionId: 'machines.setup.apply',
                    target: { kind: 'machine', machineId: 'machine' }, installationId: 'installation', requestId: 'request', method: 'POST',
                    path: '/v1/deployments/machines/machine/connector-secret-grant', body: config.data,
                    publicKey: keys.publicKey, signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
            }
            if (retirementPacket) {
                expect(body.operation).toBe('read');
                expect(config.headers).not.toHaveProperty('Authorization');
                expect(config.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('teardown-proof');
                expect(config.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(DEPLOYMENT_DOMAINS_REMOVE_ACTION_ID_V1);
                expect(config.headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]).toBe(encodeDeploymentChildExecutionV1(retirementPacket));
            }
            if (body.operation === 'set') stored = body.grant;
            else {
                expect(inChild).toBe(true);
                installedReads += 1;
                if (retireOnRead) current = false;
            }
            for (const secret of secrets) expect(JSON.stringify(config.data).includes(secret)).toBe(false);
            return stored ? { status: 200, data: { ok: true, grant: stored } }
                : { status: 404, data: { ok: false, error: 'secret_missing' } };
        });
        const outward: unknown[] = [], launches: Parameters<MachineElevationSpawn>[0][] = [];
        const spawn: MachineElevationSpawn = invocation => {
            launches.push(invocation);
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const controller = new AbortController();
            inChild = true;
            const running = runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
                stdin, stdout, signal: controller.signal,
                runNative: async command => {
                    if (command.executable !== 'getent') throw new Error('Unexpected native process');
                    const account = command.args.at(-1);
                    expect(['root', 'happier']).toContain(account);
                    const accountUid = account === 'root' ? 0 : uid || 1001;
                    const accountGid = account === 'root' ? 0 : gid || 1001;
                    return { code: 0, stderr: '', stdout: command.args.includes('passwd')
                        ? `${account}:x:${accountUid}:${accountGid}::/home/test:/bin/sh\n` : `${account}:x:${accountGid}:\n` };
                },
            });
            const settled = running.then(code => {
                inChild = false; stdout.end(); stderr.end(); return { code, signal: null };
            });
            return { stdin, stdout, stderr, settled, async terminate() { controller.abort(); stdin.end(); await settled; } };
        };
        vi.spyOn(process, 'getuid').mockReturnValue(0);
        const observation: MachineAdminAccessObservationV1 = { version: 1, observedAt: 1, daemonUid: 1001,
            daemonUsername: 'happier', daemonIdentity: 'nonRoot', rootEquivalentGroups: [],
            passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } };
        const deps = { installationId: 'installation', installedCli: '/opt/happier/current/happier',
            readPolicy: async () => ({ version: 1 as const, mode: 'preauthorized' as const }), observe: async () => observation,
            verifyCurrent: async () => { parentAdmissions += 1; return current; }, spawn, connectorSecretGrant: request,
            emit: event => { outward.push(event); },
        } satisfies MachineElevationDependencies;
        const path = join(parent, 'connector.token');
        const grant = await writeMachineConnectorSecretGrantForHost({ ...request, installationPublicKey: keys.publicKey,
            token: new TextEncoder().encode(secrets[0]!) });
        const steps = [{ id: 'connector-token', kind: 'file' as const, path, owner: 'root', group: 'root',
            mode: 0o600, content: { kind: 'secretGrant' as const, grantRef: grant.grantRef } }];
        const input = { machineId: 'machine', operationId: 'operation' };
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const checkRefusedBeforeDisclosure = async (unsafePath = path,
            declaration: Partial<Pick<typeof steps[number], 'owner' | 'group' | 'mode'>> = {}) => {
            const beforeGrantReads = installedReads, beforeFileReads = protectedFs.readBoundary.mock.calls.length;
            const blocked = await checkElevatedMachineSetupPlan({ ...input, basis,
                steps: steps.map(step => ({ ...step, ...declaration, path: unsafePath })) }, deps);
            expect(blocked?.nativeFacts[0]).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
            expect(installedReads).toBe(beforeGrantReads);
            expect(protectedFs.readBoundary.mock.calls.slice(beforeFileReads)
                .filter(([file]) => String(file) === unsafePath)).toHaveLength(0);
        };
        // Connector grants have a root-only contract; a reviewed declaration
        // cannot turn the installed token into daemon-readable content.
        await checkRefusedBeforeDisclosure(path, { owner: 'happier' });
        await checkRefusedBeforeDisclosure(path, { group: 'happier' });
        await checkRefusedBeforeDisclosure(path, { mode: 0o644 });
        await writeFile(path, 'foreign-current-user-content', { mode: 0o600 });
        const foreign = await lstat(path);
        protectedFs.ownership.set(foreign.ino.toString(), { uid: uid || 1001, gid: 0 });
        await checkRefusedBeforeDisclosure();
        protectedFs.ownership.set(foreign.ino.toString(), { uid: 0, gid: gid || 1001 });
        await checkRefusedBeforeDisclosure();
        protectedFs.ownership.set(foreign.ino.toString(), { uid: 0, gid: 0 });
        await chmod(path, 0o604);
        await checkRefusedBeforeDisclosure();
        await chmod(path, 0o600);
        const parentStat = await lstat(parent);
        protectedFs.ownership.set(parentStat.ino.toString(), { uid: uid || 1001, gid: 0 });
        await checkRefusedBeforeDisclosure();
        protectedFs.ownership.delete(parentStat.ino.toString());
        await chmod(parent, 0o770);
        await checkRefusedBeforeDisclosure();
        await chmod(parent, 0o700);
        const linkedParent = join(root, 'linked-parent');
        await symlink(parent, linkedParent, 'dir');
        await checkRefusedBeforeDisclosure(join(linkedParent, 'connector.token'));
        const linkedFile = join(parent, 'linked-token');
        await symlink(path, linkedFile);
        await checkRefusedBeforeDisclosure(linkedFile);
        expect((await lstat(path)).ino).toBe(foreign.ino);
        expect(await readFile(path, 'utf8')).toBe('foreign-current-user-content');
        const removed = await lstat(path);
        await unlink(path);
        if (removed.nlink === 1) protectedFs.ownership.delete(removed.ino.toString());
        for (const [index, secret] of secrets.entries()) {
            if (index) await writeMachineConnectorSecretGrantForHost({ ...request, installationPublicKey: keys.publicKey,
                token: new TextEncoder().encode(secret) });
            const plan = await checkElevatedMachineSetupPlan({ ...input, basis, steps }, deps);
            expect(plan?.nativeFacts[0]?.status).toBe('drifted');
            if (!plan) throw new Error('Expected a real protected check');
            outward.push(plan);
            const before = launches.length;
            const result = await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan }] } }, deps);
            expect(result.outcome).toBe('applied');
            expect(launches.length - before).toBe(1);
            expect((await readFile(path)).equals(Buffer.from(secret))).toBe(true);
            const installed = await lstat(path);
            expect({ uid: installed.uid, gid: installed.gid, mode: installed.mode & 0o7777 }).toEqual({ uid: 0, gid: 0, mode: 0o600 });
            expect(protectedFs.ownership.get(installed.ino.toString())).toEqual({ uid: 0, gid: 0 });
            for (const ancestor of [parent, ...protectedFs.ancestors]) {
                const stat = await lstat(ancestor);
                expect({ uid: stat.uid, writable: stat.mode & 0o022, directory: stat.isDirectory(), symlink: stat.isSymbolicLink() })
                    .toEqual({ uid: 0, writable: 0, directory: true, symlink: false });
            }
        }
        const removalSteps = steps.map(step => ({ ...step, id: 'cloudflare-connector-token', state: 'absent' as const }));
        await writeFile(path, 'foreign-private-file');
        const foreignRemoval = await checkElevatedMachineSetupPlan({ ...input, basis, steps: removalSteps }, deps);
        expect(foreignRemoval?.nativeFacts[0]).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(await readFile(path, 'utf8')).toBe('foreign-private-file');
        await writeFile(path, secrets[1]);
        let removalDeps = deps;
        if (authority === 'teardown') {
            const target = { kind: 'machine' as const, machineId: input.machineId };
            const envelope = { v: 1 as const, requestId: 'teardown-request', target,
                input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 10 } };
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'teardown-proof', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: input.machineId, installationId: deps.installationId,
                target, actionId: DEPLOYMENT_TEARDOWN_ACTION_ID_V1, deploymentChildRoot: true,
                requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } });
            const job = DeploymentDomainChildRpcV1Schema.parse({ v: 1, kind: 'domain', machineId: input.machineId,
                installationId: deps.installationId, actionId: DEPLOYMENT_DOMAINS_REMOVE_ACTION_ID_V1, actionOperationId: input.operationId,
                input: { serverId: 'home', environmentId: 'environment', domainId: 'final-domain' }, expectedDomainRevision: 2,
                capture: { desired: false, retireSharedTunnel: true, listener: 'privateOrigin',
                    placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link',
                        domainId: 'final-domain', machineId: input.machineId, installationId: deps.installationId,
                        nativeServer: 'tunnel-origin', actionOperationId: input.operationId, requestId: envelope.requestId },
                    content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 } },
                cloudflareConnector: { tunnelId: subject.connectorId, connector: { imageRef: 'cloudflared', version: 'test' },
                    networkName: 'app-network', grantRef: grant.grantRef },
            });
            const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
            const requestId = 'teardown-domain-child';
            const externalActionExecution = createExternalActionMachineRpcExecution({
                context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
                effectActionId: job.actionId, installationId: job.installationId, method, requestId, params: job,
                deploymentChildRouting: projectDeploymentChildRoutingV1(job), privateKey: keys.secretKey,
            });
            retirementPacket = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId, params: job,
                originalActionEnvelope: envelope, externalActionExecution });
            const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization,
                serverId: request.serverId, serverIdentityId: 'home', serverHttpBaseUrl: request.serverHttpBaseUrl,
                target, installationId: job.installationId, privateKey: keys.secretKey, rootAdmitted: true,
                forwardedDeploymentChild: job, deploymentChildExecution: retirementPacket });
            if (!carrier) throw new Error('Expected admitted final Domain retirement');
            removalDeps = { ...deps, connectorSecretGrant: { ...request, deploymentChild: job,
                context: { ...context, externalActionExecutionAuthorization: carrier } } };
        }
        const removal = await checkElevatedMachineSetupPlan({ ...input, basis, steps: removalSteps }, removalDeps);
        expect(removal?.nativeFacts[0]).toMatchObject({ status: 'drifted', facts: { present: true } });
        if (!removal) throw new Error('Expected the private retirement check');
        outward.push(foreignRemoval, removal);
        const beforeRetirementReads = installedReads;
        const retired = await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan: removal }] } }, removalDeps);
        expect(retired.outcome).toBe('applied');
        expect(installedReads - beforeRetirementReads).toBe(1);
        outward.push(retired);
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        const missing = await checkElevatedMachineSetupPlan({ ...input, basis, steps: removalSteps }, removalDeps);
        expect(missing?.nativeFacts[0]).toMatchObject({ status: 'satisfied', facts: { present: false } });
        outward.push(missing);
        retirementPacket = undefined;
        const restore = await checkElevatedMachineSetupPlan({ ...input, basis, steps }, deps);
        if (!restore) throw new Error('Expected ordinary installation after retirement');
        expect((await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan: restore }] } }, deps)).outcome).toBe('applied');
        const prior = await lstat(path);
        const equal = await checkElevatedMachineSetupPlan({ ...input, basis, steps }, deps);
        expect(equal?.nativeFacts[0]?.status).toBe('satisfied');
        if (!equal) throw new Error('Expected the no-op check');
        expect((await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan: equal }] } }, deps)).outcome).toBe('applied');
        expect((await lstat(path)).ino).toBe(prior.ino);
        const beforeAdmittedRead = installedReads;
        const beforeAdmission = { parent: parentAdmissions, connector: connectorAdmissions };
        retireOnRead = true;
        expect((await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan: equal }] } }, deps)).outcome).toBe('applied');
        expect(installedReads - beforeAdmittedRead).toBe(1);
        expect(parentAdmissions - beforeAdmission.parent).toBe(1);
        expect(connectorAdmissions - beforeAdmission.connector).toBe(1);
        expect((await lstat(path)).ino).toBe(prior.ino);
        expect(current).toBe(false);
        const beforeNextAcquisition = installedReads;
        expect((await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan: equal }] } }, deps)).outcome).toBe('not_applied');
        expect(installedReads).toBe(beforeNextAcquisition);
        expect((await readFile(path)).equals(Buffer.from(secrets[1]!))).toBe(true);
        expect(installedReads).toBeGreaterThan(0);
        const serialized = JSON.stringify({ outward, launches });
        expect(serialized.includes(token)).toBe(false);
        expect(serialized.includes('requester-proof')).toBe(false);
        for (const secret of secrets) {
            expect(serialized.includes(secret)).toBe(false);
            expect(serialized.includes(createHash('sha256').update(secret).digest('hex'))).toBe(false);
        }
    });
});
