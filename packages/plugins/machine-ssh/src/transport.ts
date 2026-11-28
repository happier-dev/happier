import { Buffer } from 'node:buffer';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError, type MachineProvisionersService, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    projectMachineProvisionerActionFailure, quoteMachineProvisionerShellArgument as quote,
    type MachineProvisionerNativeExecResultV1, type MachineProvisionerNativeStreamResultV1,
    type MachineProvisionerObservationV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import {
    buildOpenScpCommand, buildOpenSshCommand, createHappierTempDir, MANAGED_NATIVE_GUEST_PLATFORM_COMMAND,
    materializeSshIdentityPrivateKeyToTempFile, parseRemoteHostWorkspaceBindingV1, removeHappierTempDirAsync,
    SSH_PASSWORD_ENV, type OpenSshAuth,
} from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { binding, SSH_CLIENT_TOOL_ID, type ROLE_SCHEMAS } from './manifest.js';

type Connection = Pick<Parameters<typeof buildOpenSshCommand>[0], 'target' | 'port' | 'auth' | 'knownHostsPath' | 'knownHostsMode' | 'sshConfigFile'>;

// Aligned with buildOpenSshCommand's default ConnectTimeout=10 so a TCP-accepting
// stalled SSH banner or remote shell cannot hang `inspect` for OpenSSH's 45s+ keepalive window.
const SSH_INSPECT_TIMEOUT_MS = 15_000;

export async function withRemoteHostSsh<T>(input: Pick<MachineProvisionersService, 'materializeBootstrapCredential'>
    & Readonly<{ signal: AbortSignal }>, effect: (connection: Connection) => Promise<T>) {
    const lease = await input.materializeBootstrapCredential({ kind: 'bytes' });
    let identity: Awaited<ReturnType<typeof materializeSshIdentityPrivateKeyToTempFile>> | undefined;
    try {
        if (lease.kind !== 'bytes') throw new PluginError({ code: 'credential_unavailable' });
        const { target, port, knownHostsPath, authMode, credential } = parseRemoteHostWorkspaceBindingV1(lease.bytes);
        const auth: OpenSshAuth = authMode === 'keyfile'
            ? { mode: 'keyFile', privateKeyPath: (identity = await materializeSshIdentityPrivateKeyToTempFile({ privateKey: credential })).identityFilePath, identitiesOnly: true }
            : { mode: 'password', password: credential };
        input.signal.throwIfAborted();
        return await effect({ target, port, knownHostsPath, knownHostsMode: 'app', auth, sshConfigFile: 'none' });
    } finally {
        try { await lease.dispose(); }
        finally { await identity?.cleanup(); }
    }
}

function invocationEnv(env: NodeJS.ProcessEnv | undefined) {
    return env ? { [SSH_PASSWORD_ENV]: env[SSH_PASSWORD_ENV]!, SSH_ASKPASS: env.SSH_ASKPASS!,
        SSH_ASKPASS_REQUIRE: env.SSH_ASKPASS_REQUIRE!, DISPLAY: env.DISPLAY! } : undefined;
}

function withInvocationSsh<T>(context: PluginInvocationContext, effect: (connection: Connection) => Promise<T>) {
    return withRemoteHostSsh({ signal: context.signal, materializeBootstrapCredential: request =>
        context.services.machineProvisioners.materializeBootstrapCredential(request) }, effect);
}

function resolveOpenSshTool(context: PluginInvocationContext, toolId: 'scp' | typeof SSH_CLIENT_TOOL_ID) {
    return context.services.exec.systemTools.resolve({ toolId, purpose: 'Access the admitted SSH Remote Host', signal: context.signal });
}

async function runOpenSshInvocation(context: PluginInvocationContext, toolId: 'scp' | typeof SSH_CLIENT_TOOL_ID,
    invocation: ReturnType<typeof buildOpenSshCommand>, input?: Readonly<{ stdin?: Uint8Array; timeoutMs?: number }>) {
    const { executable } = await resolveOpenSshTool(context, toolId);
    return context.services.exec.run({
        executable, args: invocation.args, env: invocationEnv(invocation.env), ...input,
    }, { signal: context.signal });
}

export function runSshExec(value: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>, context: PluginInvocationContext): Promise<MachineProvisionerNativeExecResultV1> {
    const [shell, flag, command] = value.argv;
    const probing = shell === 'sh' && flag === '-c' && command === MANAGED_NATIVE_GUEST_PLATFORM_COMMAND && value.argv.length === 3;
    const remote = value.argv.map(quote).join(' ');
    return withInvocationSsh(context, async connection => {
        // Windows OpenSSH's default command interpreter expands %OS% even when sh is absent.
        const invocation = buildOpenSshCommand({
            ...connection, sshBin: 'ssh', tty: false, remoteCommand: [probing ? `echo %OS% && ${remote}` : remote],
        });
        const result = await runOpenSshInvocation(context, SSH_CLIENT_TOOL_ID, invocation, {
            ...(value.inputBase64 === undefined ? {} : { stdin: Buffer.from(value.inputBase64, 'base64') }),
            ...(value.timeoutMs == null ? {} : { timeoutMs: value.timeoutMs }),
        });
        let stdout = Buffer.from(result.stdout);
        let termination = result.termination;
        if (context.signal.aborted && termination.requestedBy.kind === 'abort'
            && (termination.observed.kind === 'exit' || termination.observed.kind === 'signal')) {
            throw new PluginError({ code: 'cancelled', message: 'SSH command execution was cancelled' });
        }
        if (probing) {
            const eol = stdout.indexOf(10);
            const marker = stdout.subarray(0, eol < 0 ? stdout.length : eol).toString('utf8').trim();
            if (marker === '%OS%' && eol !== -1) stdout = stdout.subarray(eol + 1);
            if (marker === 'Windows_NT' && termination.requestedBy.kind === 'none' && termination.observed.kind === 'exit') {
                stdout = Buffer.from('Windows_NT\n');
                termination = { ...termination, observed: { kind: 'exit', exitCode: 0 } };
            }
        }
        return { termination, stdoutBase64: stdout.toString('base64'), stderrBase64: Buffer.from(result.stderr).toString('base64'),
            stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
    });
}

export async function inspectSsh(_value: ReturnType<typeof ROLE_SCHEMAS.resourceInput.parse>, context: PluginInvocationContext): Promise<MachineProvisionerObservationV1> {
    const unavailable = (): MachineProvisionerObservationV1 => ({
        observedAt: context.invokedAtMs, availability: 'unavailable', power: 'unknown',
        billing: binding.billing, reason: 'provider_unavailable',
    });
    try {
        return await withInvocationSsh(context, async connection => {
            const invocation = buildOpenSshCommand({ ...connection, sshBin: 'ssh', tty: false, remoteCommand: ['echo ok'] });
            const { termination } = await runOpenSshInvocation(context, SSH_CLIENT_TOOL_ID, invocation, { timeoutMs: SSH_INSPECT_TIMEOUT_MS });
            context.signal.throwIfAborted();
            if (termination.requestedBy.kind === 'none' && termination.observed.kind === 'exit' && termination.observed.exitCode === 0) {
                return { observedAt: context.invokedAtMs, availability: 'present', power: 'running', storage: 'unknown', billing: binding.billing };
            }
            return unavailable();
        });
    } catch (error) {
        context.signal.throwIfAborted();
        return projectMachineProvisionerActionFailure(error, unavailable);
    }
}

export function putSshFile(value: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>, context: PluginInvocationContext) {
    if (!value.guestPath.startsWith('/') || value.guestPath.includes('\0')) return { kind: 'refused' as const, code: 'invalid_request' };
    return withInvocationSsh(context, async connection => {
        const directory = createHappierTempDir({ purpose: 'ssh-workspace-transfer' });
        try {
            const localPath = join(directory, 'upload');
            const mode = value.mode ?? 0o600;
            await writeFile(localPath, Buffer.from(value.bytesBase64, 'base64'), { mode: 0o600 });
            await chmod(localPath, mode);
            const invocation = buildOpenScpCommand({ ...connection, scpBin: 'scp', direction: 'upload', localPath,
                remotePath: value.guestPath, preserveAttributes: true, recursive: false });
            const { termination } = await runOpenSshInvocation(context, 'scp', invocation);
            context.signal.throwIfAborted();
            if (termination.requestedBy.kind === 'none' && termination.observed.kind === 'exit' && termination.observed.exitCode === 0) {
                return { kind: 'confirmed' as const };
            }
            return { kind: 'unknown' as const, code: 'provider_unavailable' };
        } catch {
            context.signal.throwIfAborted();
            return { kind: 'unknown' as const, code: 'provider_unavailable' };
        } finally { await removeHappierTempDirAsync(directory); }
    });
}

export function streamSsh(value: ReturnType<typeof ROLE_SCHEMAS.streamInput.parse>, context: PluginInvocationContext): Promise<MachineProvisionerNativeStreamResultV1> {
    return withInvocationSsh(context, async connection => {
        const { executable } = await resolveOpenSshTool(context, SSH_CLIENT_TOOL_ID);
        const invocation = buildOpenSshCommand({ ...connection, sshBin: 'ssh', tty: false, remoteCommand: [value.argv.map(quote).join(' ')] });
        const channel = await context.services.exec.spawn({ executable, args: invocation.args, env: invocationEnv(invocation.env) }, {
            signal: context.signal, outputDelivery: 'invocation',
        });
        try { return { termination: await channel.waitForExit() }; }
        finally { await channel.dispose(); }
    });
}
