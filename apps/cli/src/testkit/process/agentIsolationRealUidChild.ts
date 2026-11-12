import { readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { runAgentLaunchShim } from '@/cli/commands/agentLaunch';
import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from '@/mcp/runtime/sessionMcpLocalClient';
import { runMemberAgentInstallEffect } from '@/capabilities/installJobs/memberInstallEffect';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { executeAgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchShim';

// Bundled into a public, temporary fixture executable: the real member cannot
// traverse the developer's private checkout/Home to import source modules.
async function main() {
    if (process.argv[2] === 'mapped-agent-launch') {
        // Unit tests substitute only the OS RunAs observation; frame parsing,
        // materialization, member effect and supervised child remain real.
        const frame = await readAgentLaunchFrame(process.stdin);
        if ('action' in frame || !frame.nativeIdentity) throw new Error('Expected member launch');
        const result = await executeAgentLaunchPayload(frame, { agentHome: frame.nativeIdentity.home,
            input: process.stdin, stdout: process.stdout, stderr: process.stderr });
        process.exitCode = result.code ?? 1;
        return;
    }
    if (process.argv[2] === 'agent-install-effect') {
        await runMemberAgentInstallEffect(process.stdin, process.stdout, new AbortController().signal);
        return;
    }
    if (process.argv[2] === 'agent-launch') {
        await runAgentLaunchShim(process.argv.slice(3));
        return;
    }
    if (process.argv[2] !== 'mcp-probe') throw new Error('Unknown real-UID fixture command');
    const identity = userInfo();
    const denied = async (path: string) => {
        try { await readFile(path); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES') return true; throw error; }
    };
    const privacy = {
        uid: identity.uid,
        homeMode: (await stat(identity.homedir)).mode & 0o777,
        daemonPrivate: await denied(process.env.FIXTURE_DAEMON_PRIVATE!),
        otherMemberPrivate: await denied(process.env.FIXTURE_OTHER_PRIVATE!),
    };
    // Read the selected material through the production owner in both cases.
    // The negative probe knows the valid bearer: kernel UID access must refuse it.
    const context = await readSessionMcpContextFromEnvironment();
    try {
        const connection = await connectSessionMcpClient(context);
        try {
            const tools = await connection.client.listTools();
            process.stdout.write(JSON.stringify({ ...privacy, connected: true,
                server: connection.client.getServerVersion()?.name, tools: tools.tools.map(tool => tool.name) }));
        } finally { await connection.close(); }
    } catch (error) {
        process.stdout.write(JSON.stringify({ ...privacy, connected: false,
            code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
            phase: error && typeof error === 'object' ? Reflect.get(error, 'phase') : undefined }));
    }
}

void main().catch(error => {
    // No exception message: MCP context and native payloads contain capabilities.
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const cause: unknown = error && typeof error === 'object' ? Reflect.get(error, 'cause') : undefined;
    process.stderr.write(JSON.stringify({ code: typeof code === 'string' ? code : 'real_uid_fixture_failed',
        causeCode: cause && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined,
        causePath: cause && typeof cause === 'object' ? Reflect.get(cause, 'path') : undefined,
        causeSyscall: cause && typeof cause === 'object' ? Reflect.get(cause, 'syscall') : undefined }));
    process.exitCode = 1;
});
