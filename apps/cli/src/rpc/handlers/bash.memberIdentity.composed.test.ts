import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionExecutor } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { configuration } from '@/configuration';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { readAgentLaunchFrame, type AgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchFrame';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerBashHandler } from './bash';

const nativeOs: { home?: { path: string; backing: string; workspaceRoot: string; uid: number }; launches: Array<{
    command: string; args: readonly string[]; frame: AgentLaunchPayload;
}> } = vi.hoisted(() => ({ launches: [] }));

// Only OS ownership and RunAs are substituted. Requester selection, installed
// registration, native preparation, frame finalization and output capture are real.
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual,
        async lstat(path: Parameters<typeof actual.lstat>[0]) {
            const home = nativeOs.home;
            if (String(path) === home?.path) return Object.assign(await actual.lstat(home.backing), {
                uid: home.uid, gid: home.uid, mode: 0o40700,
            });
            return actual.lstat(path);
        },
        async realpath(path: Parameters<typeof actual.realpath>[0]) {
            const home = nativeOs.home;
            if (String(path) === home?.path || String(path) === home?.workspaceRoot) return String(path);
            return actual.realpath(path);
        },
    };
});
vi.mock('@happier-dev/cli-common/process', async original => {
    const actual = await original<typeof import('@happier-dev/cli-common/process')>();
    return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
        const [command, argv, options] = args;
        if (command !== 'sudo' || !options.inputBytes) return actual.execFileWithDeadline(...args);
        const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes], { objectMode: false }));
        nativeOs.launches.push({ command, args: [...argv], frame });
        // The OS boundary runs exactly the canonical frame's command and env.
        return actual.execFileWithDeadline(frame.executable, frame.args, {
            ...options, cwd: frame.cwd, env: { ...frame.environment }, shell: false, inputBytes: undefined,
        });
    } };
});
afterEach(() => { nativeOs.home = undefined; nativeOs.launches.length = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
    let preparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
    const agentIsolation = { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1' as const,
            status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const },
            workspaceRoots: nativeOs.home ? [nativeOs.home.workspaceRoot] : [] }),
        readMember: async (input: Parameters<NonNullable<import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext['readMember']>>[0]) => {
            if (!preparation) throw new Error('Member native fixture not ready');
            return preparation.members.read(input);
        },
        prepareMember: async (input: Parameters<NonNullable<import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext['prepareMember']>>[0]) => {
            if (!preparation) throw new Error('Member native fixture not ready');
            const result = await preparation.members.prepare(input);
            if (result.kind !== 'ready') throw new Error('Member native setup refused');
            return result;
        } };
    const f = await createInstalledFilesystemMachineFixture({ agentIsolation });
    const requester = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: f.homeServerIdentityId,
        requester: { serverId: f.homeServerIdentityId, accountId: 'member-a', machineId: f.machineId,
            installationId: f.installation.installationId } };
    const member = deriveAgentIsolationMemberIdentity(requester);
    preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
        requesterIdentity: requester, custodianAccountId: 'requester', encryptionMode: 'plain', uid: 2401 });
    for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity: requester, daemonUsername: 'happier',
        daemonPrimaryGroup: 'happier', binaryPath: agentIsolation.managedHappierBinaryPath })) preparation.installed.add(step.id);
    const backing = join(f.directory, 'native-home');
    await mkdir(backing);
    nativeOs.home = { path: member.home, backing, workspaceRoot: member.workspaceRoot, uid: 2401 };
    await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
    let authorityChecks = 0;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: f.machineId,
            installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => { authorityChecks++; return true; } };
    const handlers = new Map<string, (input: never, context?: RpcHandlerContext) => unknown>();
    const registry = new ExecutionBudgetRegistry();
    registerBashHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, f.directory, {
        nativeOperationRuntime: f.machine, executionBudgetRegistry: registry,
        resolveHostHomeServerIdentityId: async () => f.homeServerIdentityId,
    });
    return { ...f, member, registry, context, authorityChecks: () => authorityChecks,
        // The real RPC ingress owns decoding; this direct consumer probe keeps
        // the generic registrar's erased request type at its test boundary.
        capture: (input: unknown, ingress = context) => Promise.resolve(handlers.get(RPC_METHODS.BASH)!(input as never, ingress)) };
}

describe.skipIf(process.platform !== 'linux')('Manage raw Bash host execution', () => {
    it.each(['argv', 'shell'] as const)('captures useful %s effects without requiring a member RunAs frame', async mode => {
        const f = await fixture();
        vi.stubEnv('HAPPIER_DAEMON_TOKEN', 'custodian-private-token');
        vi.stubEnv('UNRELATED_DAEMON_SECRET', 'custodian-private-value');
        vi.stubEnv('OPENAI_API_KEY', 'custodian-private-provider-key');
        vi.stubEnv('HAPPIER_SESSION_MCP_CONTEXT_FILE', '/daemon/private/session-context');
        const marker = join(f.directory, `raw-${mode}`);
        const input = mode === 'argv' ? { argv: [process.execPath, '-e',
            "require('node:fs').writeFileSync(process.argv[1], process.env.RAW_VALUE); process.stdout.write('member-output'); process.stderr.write('member-error'); process.exitCode = 7", marker] }
            : { command: `printf '%s' "$RAW_VALUE" > '${marker}'; printf member-output; printf member-error >&2; exit 7` };
        expect(await f.capture({ ...input, cwd: f.directory, env: { RAW_VALUE: 'member-value' }, timeout: 0 }))
            .toMatchObject({ success: false, stdout: 'member-output', stderr: 'member-error', exitCode: 7 });
        expect(await readFile(marker, 'utf8')).toBe('member-value');
        expect(nativeOs.launches).toHaveLength(0);
        expect(f.authorityChecks()).toBe(0);
        expect(f.registry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [] });
    });

    it('keeps cancellation, partial UTF-8 output and finite custody through physical command settlement', async () => {
        const f = await fixture();
        const controller = new AbortController();
        const marker = join(f.directory, 'started');
        const pending = f.capture({ argv: [process.execPath, '-e',
            "process.stdout.write('old:' + '😀'.repeat(100) + ':tail'); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)", marker],
            cwd: f.directory, timeout: 0, outputTailMaxBytes: 32 }, { ...f.context, signal: controller.signal });
        try {
            await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'));
            expect(f.registry.getLiveWorkProducer().read()).toMatchObject({ items: [{ category: 'finite', state: 'active' }] });
            controller.abort();
            const response = await pending;
            expect(response).toMatchObject({ success: false, error: 'Command cancelled', stdoutTruncated: true });
            const output: unknown = Reflect.get(response as object, 'stdout');
            expect(typeof output === 'string' && output.endsWith(':tail') && Buffer.byteLength(output) <= 32).toBe(true);
            expect(f.registry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [] });
        } finally { controller.abort(); await pending; }
    });

    it.each(['member-tool', './member-tool'])('resolves %s in the Manage launch and preserves literal argv bytes', async command => {
        const f = await fixture();
        await writeFile(join(f.directory, 'member-tool'), '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
        const literal = 'quoted "value"; $(printf injected) & <literal>\nnext line';
        expect(await f.capture({ argv: [command, literal], cwd: f.directory, env: { PATH: f.directory }, timeout: 0 }))
            .toMatchObject({ success: true, stdout: literal, exitCode: 0 });
        expect(nativeOs.launches).toHaveLength(0);
    });

    it('refuses a different Account binding before borrowing the prepared member identity', async () => {
        const f = await fixture();
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'foreign-account', binding: {
            serverIdentityId: f.homeServerIdentityId, accountId: 'member-b', custodianAccountId: 'requester',
            authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            machineId: f.machineId, installationId: f.installation.installationId, actionId: 'machines.agentIsolation.preview',
            requestId: 'foreign-account', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: f.machineId },
        } });
        expect(await f.capture({ argv: ['/bin/echo', 'foreign-effect'], timeout: 0 }, { ...f.context, callerInputAuthorization }))
            .toMatchObject({ success: false, errorCode: 'agent_isolation_unavailable' });
        expect(nativeOs.launches).toHaveLength(0);
    });

    it('routes installed Manage capture without native preparation and denies foreign installation before effects', async () => {
        const f = await fixture();
        const input = { argv: [process.execPath, '-e', "process.stdout.write('installed-member')"], cwd: f.directory, timeout: 0 };
        expect(await f.invoke(RPC_METHODS.BASH, input, { actorAccountId: 'member-a', role: 'manage' }))
            .toMatchObject({ success: true, stdout: 'installed-member' });
        expect(f.admissionChecks()).toBe(1);
        const launches = nativeOs.launches.length;
        expect(await f.receive({ method: `machine:${RPC_METHODS.BASH}`, params: input, callerAuthority: 'present_user',
            machineAdmission: { ...f.context.machineAdmission!, installationId: 'foreign-installation' } }))
            .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(nativeOs.launches).toHaveLength(launches);
    });

    it('carries admitted Manage Account automation through the real command Action and installed Machine receiver', async () => {
        const f = await fixture();
        const deps = createCliActionDeps({ token: f.bootstrap.credentials.token, credentials: f.bootstrap.credentials,
            sessionId: 'cli-global', serverId: f.serverId, serverHttpBaseUrl: f.serverHttpBaseUrl, mode: 'plain', ctx: null,
            machineActionDirectTargetTransport: { machineId: f.machineId,
                invoke: (method, input, options) => f.machine.invokeLocalMachineAction(method, input, options) } });
        const context = { surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: f.serverId,
            machineAdmission: f.context.machineAdmission, verifyMachineAdmissionCurrent: f.context.verifyMachineAdmissionCurrent,
            externalActionTarget: { kind: 'machine', machineId: f.machineId,
                project: { machineId: f.machineId, directory: f.directory } } } satisfies RpcActionExecutorContext;
        const result = await createActionExecutor(deps).execute('machines.command.run', {
            command: 'printf "%s" "$RAW_ACTION_VALUE"', env: { RAW_ACTION_VALUE: 'member-action-output' },
        }, context);
        expect(f.admissionChecks(), 'The Action must retain requester ingress through its exact local Machine transport').toBe(1);
        expect(result).toMatchObject({ ok: true, result: { exitCode: 0, stdout: 'member-action-output', stderr: '' } });
        expect(nativeOs.launches).toHaveLength(0);
    });
});
