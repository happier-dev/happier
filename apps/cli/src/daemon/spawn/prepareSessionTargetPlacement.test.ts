import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type { ManagedSessionTargetRequest } from '@/machines/managed/acquire';
import { connectSessionTarget } from '@/subprocess/supervision/sessionTargetRelay';

import { deliverSessionTargetLaunch, observeSessionTargetRunnerExit, prepareSessionTargetPlacement } from './prepareSessionTargetPlacement';

/**
 * The spawn owner places a Session on a managed target: the target's custody is
 * the managed driver (its own tests); here it is the provider boundary. The
 * placement lives exactly as long as the launch's resources: a failed spawn or
 * the Session's exit ends the authority and removes the relay.
 */
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fakeCustody() {
    const requests: ManagedSessionTargetRequest[] = [];
    return { requests, open: async (request: ManagedSessionTargetRequest) => {
        requests.push(request);
        return { id: 'managed:row-1', holderPath: '/g/.happier/holder/v/happier-session-holder', helperPath: '/g/h', socketDirectory: '/g/run',
            home: '/g', platform: { os: 'linux' as const, arch: 'x64' as const, home: '/g' },
            exec: async (command: string) => ({ status: 0, stdout: `ran:${command}`, stderr: '' }),
            putFile: async () => undefined,
            openChannel: () => new PassThrough() };
    } };
}

type SessionTargetAgent = NonNullable<Parameters<typeof deliverSessionTargetLaunch>[0]['agent']>;

/**
 * The Session's Agent as the spawn's leased runtime registry holds it (catalog facts under `contributes`), with only the
 * members the launch step reads; the full registry needs a materialized plugin runtime this owner does not use.
 */
function leasedAgent(id: string, secretEntries: readonly string[], runtimeSpec?: object): SessionTargetAgent {
    const sharing = { authIsolation: { mode: 'materialized_home', secretEntries } };
    const catalog = { contributes: { agentDefinitionsById: new Map(runtimeSpec ? [[id, { runtimeSpec }]] : []), catalogEntriesById: {} },
        acquireAgentCatalogEntry: async (agentId: string) => agentId === id ? { getConnectedServiceStateSharingDescriptor: async () => sharing } : null };
    return { id, catalog: catalog as unknown as SessionTargetAgent['catalog'] };
}

/** The placement's Session-end steps as the placement runs them (latest first). */
function sessionEnd() {
    const steps: Array<() => Promise<void>> = [];
    return { onSessionEnd: (step: () => Promise<void>) => { steps.push(step); },
        end: async () => { for (const step of [...steps].reverse()) await step(); } };
}

describe('Session placement on a managed target at spawn', () => {
    it('opens the target under the requester, relays it to the runner, and ends it with the launch resources', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const custody = fakeCustody();
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        const prepared = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open, launchResourceScope: scope, socketPath: join(directory, 'relay.sock') });
        expect(prepared).toMatchObject({ ok: true, placement: { id: 'managed:row-1', holderPath: '/g/.happier/holder/v/happier-session-holder',
            socketDirectory: '/g/run', relaySocketPath: join(directory, 'relay.sock') } });
        expect(custody.requests[0]).toMatchObject({ managedId: 'row-1', sessionId: 'spawn-1', requesterAccountId: 'owner' });
        if (!prepared.ok) throw new Error('unreachable');
        await expect(connectSessionTarget(prepared.placement).exec('true')).resolves.toMatchObject({ stdout: 'ran:true' });

        // The Session exits: its transferred launch resources retire, ending the placement.
        const onExit = scope.transfer();
        await onExit?.();
        await expect.poll(() => custody.requests[0]!.lifetime.aborted).toBe(true);
        await expect.poll(() => existsSync(join(directory, 'relay.sock'))).toBe(false);
    });

    it('a Stop retires the launch resources first; the target stays reachable until the runner has stopped its Agents and exited', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const custody = fakeCustody();
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        let runnerExited!: () => void;
        const runnerExit = new Promise<void>(resolve => { runnerExited = resolve; });
        const prepared = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit, openManagedSessionTarget: custody.open, launchResourceScope: scope,
            socketPath: join(directory, 'relay.sock') });
        if (!prepared.ok) throw new Error('unreachable');
        const endSteps: string[] = [];
        prepared.onSessionEnd(async () => { endSteps.push('remove-session-directory'); });

        // Stop: upstream authority retirement runs the transferred launch resources before the runner is signalled.
        await scope.transfer()?.();
        // The runner stops its target Agent through its holder: the relay still answers.
        await expect(connectSessionTarget(prepared.placement).exec('kill-agent')).resolves.toMatchObject({ stdout: 'ran:kill-agent' });
        expect(custody.requests[0]!.lifetime.aborted).toBe(false);
        expect(endSteps).toHaveLength(0);

        runnerExited();
        await expect.poll(() => custody.requests[0]!.lifetime.aborted).toBe(true);
        expect(endSteps).toEqual(['remove-session-directory']);
        await expect.poll(() => existsSync(join(directory, 'relay.sock'))).toBe(false);
    });

    it('a Session in the session host has no runner process: its target lives until the host ended that Session', async () => {
        let observed!: () => void;
        const hostedSession = { end: async () => true, observed: new Promise<void>(resolve => { observed = resolve; }) };
        let exited = false;
        void observeSessionTargetRunnerExit({ hostedSession }).then(() => { exited = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(exited).toBe(false);
        observed();
        await expect.poll(() => exited).toBe(true);
        // A runner process: its exit; already exited or no process: now.
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
        let childExited = false;
        void observeSessionTargetRunnerExit({ childProcess: child }).then(() => { childExited = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(childExited).toBe(false);
        await expect.poll(() => childExited, { timeout: 5_000 }).toBe(true);
        await expect(observeSessionTargetRunnerExit({})).resolves.toBeUndefined();
    });

    it('names the Session\'s guest directory with a plain key derived from any spawn key (Action nonces carry `:`)', async () => {
        const custody = fakeCustody();
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        const prepared = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'session.spawn_new.creation:9f/aa', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open, launchResourceScope: scope, socketPath: join(directory, 'k.sock') });
        if (!prepared.ok) throw new Error('unreachable');
        expect(prepared.sessionKey).toMatch(/^[A-Za-z0-9._-]+$/u);
        expect(custody.requests[0]!.sessionId).toBe(prepared.sessionKey);
        await scope.retire();
    });

    it('refuses without a target custody owner and ends the authority when the spawn fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        await expect(prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), launchResourceScope: scope, socketPath: join(directory, 'r.sock') })).resolves.toMatchObject({ ok: false });

        const custody = fakeCustody();
        const failing = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-2', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open, launchResourceScope: failing, socketPath: join(directory, 'f.sock') });
        await failing.retire();
        expect(custody.requests[0]!.lifetime.aborted).toBe(true);
    });
});

describe('Session target launch step (credentials + Agent CLI into the target)', () => {
    async function localGuest() {
        const guest = await mkdtemp(join(tmpdir(), 'stl-guest-')); directories.push(guest);
        const { spawn } = await import('node:child_process');
        const { Duplex } = await import('node:stream');
        const { writeFile: writeFileAsync } = await import('node:fs/promises');
        const channels: string[][] = [];
        // A fixture guest at the provider boundary: like the real Session authority, nothing runs once its signal ended,
        // and a file put does not create parent directories (devcontainer/Coder `cat > path`).
        const target = { id: 'managed:row-1', holderPath: `${guest}/h`, helperPath: `${guest}/p`, socketDirectory: `${guest}/run`, home: guest,
            platform: { os: 'linux' as const, arch: process.arch === 'arm64' ? 'arm64' as const : 'x64' as const, home: guest },
            exec: (command: string, signal?: AbortSignal) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
                if (signal?.aborted) { reject(Object.assign(new Error('authority ended'), { code: 'intent_changed' })); return; }
                const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                child.once('error', reject); child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
            }),
            putFile: async (path: string, bytes: Uint8Array) => { await writeFileAsync(path, bytes); },
            openChannel: (argv: readonly string[]) => {
                channels.push([...argv]);
                const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
                child.once('close', () => channel.destroy());
                return channel;
            } };
        return { guest, target, channels };
    }
    async function agentHome() {
        const host = await mkdtemp(join(tmpdir(), 'stl-host-')); directories.push(host);
        const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        const home = join(host, 'agent-home');
        await mkdirAsync(join(home, 'accounts', 'a1'), { recursive: true });
        await mkdirAsync(join(home, 'plugins', 'p'), { recursive: true });
        await writeFileAsync(join(home, 'auth.json'), 'fixture-credential');
        await writeFileAsync(join(home, 'accounts', 'a1', 'token.json'), 'fixture-account');
        await writeFileAsync(join(home, 'config.toml'), '[mcp_servers.x.env]\nTOKEN = "fixture-mcp-secret"');
        await writeFileAsync(join(home, 'hooks.json'), '{"hooks":[]}');
        await writeFileAsync(join(home, 'plugins', 'p', 'x.js'), '');
        return home;
    }

    it('delivers only the provider-declared credential entries and the Agent CLI; the Session end removes them', async () => {
        const { guest, target, channels } = await localGuest();
        const home = await agentHome();
        const { readFile: readFileAsync, readdir: readdirAsync } = await import('node:fs/promises');
        const custody = { open: async (request: ManagedSessionTargetRequest) => ({ ...target, exec: (command: string) => target.exec(command, request.lifetime) }) };
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        const placed = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open as never, launchResourceScope: scope, socketPath: join(guest, 'relay.sock') });
        if (!placed.ok) throw new Error('unreachable');
        const launch = await deliverSessionTargetLaunch({ target: { ...target, exec: (command: string) => target.exec(command, placed.signal) },
            sessionKey: 'spawn-1', onSessionEnd: placed.onSessionEnd, agent: leasedAgent('codex', ['auth.json', 'accounts']),
            runnerEnvironment: { CODEX_HOME: home, UNRELATED_PATH: '/usr/share', HAPPIER_X: '1' },
            materializedRoot: home, requestAuthMaterializedRoot: null,
            agentCommand: process.execPath, workspace: { hostRoot: '/host/ws', targetRoot: '/workspaces/ws' } });
        const base = join(guest, '.happier', 'sessions', 'spawn-1');
        expect(launch.env).toEqual({ CODEX_HOME: join(base, 'agent-home') });
        expect((await readdirAsync(join(base, 'agent-home'))).sort()).toEqual(['accounts', 'auth.json']);
        await expect(readFileAsync(join(base, 'agent-home', 'accounts', 'a1', 'token.json'), 'utf8')).resolves.toBe('fixture-account');
        const placedCli = launch.executables[process.execPath]!;
        expect(placedCli).toMatch(new RegExp(`^${join(guest, '.happier', 'agent-cli')}/[0-9a-f]{64}/node$`));
        expect((await readFileAsync(placedCli)).equals(await readFileAsync(process.execPath))).toBe(true);
        expect(launch.lockPath).toBe(join(base, '.live'));

        // A second Session reuses the one CLI copy (same digest): no second transfer.
        const second = sessionEnd();
        const again = await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-2', onSessionEnd: second.onSessionEnd, agent: null,
            runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: process.execPath,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        expect(again.executables[process.execPath]).toBe(placedCli);
        expect(channels).toHaveLength(1);

        // The Session exits: its delivered files are removed while the authority is still live, then it ends.
        await scope.transfer()?.();
        await expect.poll(() => placed.signal.aborted).toBe(true);
        await expect(readdirAsync(base)).rejects.toMatchObject({ code: 'ENOENT' });
        await second.end();
        await expect(readdirAsync(join(guest, '.happier', 'sessions', 'spawn-2'))).rejects.toMatchObject({ code: 'ENOENT' });
    }, 60_000);

    it('sweeps leftovers of ended Sessions, never a directory a live Agent holds', async () => {
        const { guest, target } = await localGuest();
        const { mkdir: mkdirAsync, readdir: readdirAsync } = await import('node:fs/promises');
        const { spawn } = await import('node:child_process');
        const sessions = join(guest, '.happier', 'sessions');
        await mkdirAsync(join(sessions, 'crashed-1', 'agent-home'), { recursive: true });
        await mkdirAsync(join(sessions, 'live-1', 'agent-home'), { recursive: true });
        const holder = spawn('flock', ['-s', join(sessions, 'live-1', '.live'), 'sleep', '30'], { stdio: 'ignore' });
        try {
            await expect.poll(async () => (await readdirAsync(join(sessions, 'live-1'))).includes('.live')).toBe(true);
            await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-3', onSessionEnd: () => undefined,
                agent: null, runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null,
                workspace: { hostRoot: '/h', targetRoot: '/t' } });
            expect((await readdirAsync(sessions)).sort()).toEqual(['live-1', 'spawn-3']);
        } finally { holder.kill('SIGKILL'); }
    }, 60_000);

    it('a runner crash keeps the Session\'s delivered home while its Agent still holds it (adoption); a later placement sweeps it once released', async () => {
        const { guest, target } = await localGuest();
        const home = await agentHome();
        const { readdir: readdirAsync } = await import('node:fs/promises');
        const { spawn } = await import('node:child_process');
        const ended = sessionEnd();
        const launch = await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-8', onSessionEnd: ended.onSessionEnd, agent: leasedAgent('codex', ['auth.json']),
            runnerEnvironment: { CODEX_HOME: home }, materializedRoot: home, requestAuthMaterializedRoot: null, agentCommand: null,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        const base = join(guest, '.happier', 'sessions', 'spawn-8');
        // The Session's Agent runs under the shared `.live` lock (as the target launch starts it) and outlives its runner.
        const agent = spawn('flock', ['-s', launch.lockPath!, 'sleep', '30'], { stdio: 'ignore', detached: true });
        try {
            await expect.poll(async () => (await readdirAsync(base)).includes('.live')).toBe(true);
            await ended.end();
            expect((await readdirAsync(join(base, 'agent-home')))).toEqual(['auth.json']);
        } finally { process.kill(-agent.pid!, 'SIGKILL'); }
        await new Promise(resolve => agent.once('close', resolve));
        await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-9', onSessionEnd: () => undefined,
            agent: null, runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        await expect(readdirAsync(base)).rejects.toMatchObject({ code: 'ENOENT' });
    }, 60_000);

    it('installs the Agent CLI for the target through the provider\'s Linux install recipe when this Machine\'s CLI cannot run there', async () => {
        const { guest, target, channels } = await localGuest();
        const home = await agentHome();
        const { readFile: readFileAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        // This Machine's CLI is a launcher script (like Muse's), which no target can be handed.
        const launcher = join(await mkdtemp(join(tmpdir(), 'stl-l-')), 'fake-agent'); directories.push(dirname(launcher));
        await writeFileAsync(launcher, '#!/bin/sh\n');
        // The vendor recipe downloads with the Session's own login: it must see the delivered credential home.
        const recipe = 'test -f "$CODEX_HOME/auth.json" && mkdir -p "$HOME/.local/bin" && printf "#!/bin/sh\\n" > "$HOME/.local/bin/fake-agent" '
            + '&& chmod 700 "$HOME/.local/bin/fake-agent" && echo run >> "$HOME/recipe-runs"';
        const agentRuntime = { id: 'fake', title: 'Fake CLI', binaryName: 'fake-agent', knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreferenceDefault: 'system-first' as const, managedInstall: null, manualInstallKind: 'vendor_recipe' as const,
            manualInstallRecipes: { linux: [{ cmd: 'sh', args: ['-c', recipe] }] }, acceptsJavaScriptFileOverride: false };
        const base = { target, runnerEnvironment: { CODEX_HOME: home }, materializedRoot: home, agent: leasedAgent('fake', ['auth.json'], agentRuntime),
            requestAuthMaterializedRoot: null, agentCommand: launcher, workspace: { hostRoot: '/h', targetRoot: '/t' } };
        const launch = await deliverSessionTargetLaunch({ ...base, sessionKey: 'spawn-5',
            onSessionEnd: () => undefined });
        expect(launch.executables[launcher]).toBe(join(guest, '.local', 'bin', 'fake-agent'));
        expect(channels).toHaveLength(0);

        // Installed once per target: a later Session finds it and runs no recipe.
        const again = await deliverSessionTargetLaunch({ ...base, sessionKey: 'spawn-6',
            onSessionEnd: () => undefined });
        expect(again.executables[launcher]).toBe(join(guest, '.local', 'bin', 'fake-agent'));
        await expect(readFileAsync(join(guest, 'recipe-runs'), 'utf8')).resolves.toBe('run\n');

        // A recipe that cannot complete in the target (missing tool, failed download) is a typed refusal.
        const { guest: other, target: bare } = await localGuest();
        await expect(deliverSessionTargetLaunch({ ...base, target: bare, sessionKey: 'spawn-7',
            agent: leasedAgent('fake', ['auth.json'], { ...agentRuntime, manualInstallRecipes: { linux: [{ cmd: 'sh', args: ['-c', 'exit 3'] }] } }),
            onSessionEnd: () => undefined }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
        expect(existsSync(join(other, '.local', 'bin', 'fake-agent'))).toBe(false);
    }, 60_000);

    it('reads the Agent\'s declared auth files and install recipe from the leased catalog; a nested auth path (Muse `muse/auth.json`) crosses alone', async () => {
        const { guest, target } = await localGuest();
        const { mkdir: mkdirAsync, readdir: readdirAsync, writeFile: writeFileAsync, readFile: readFileAsync } = await import('node:fs/promises');
        // The Session's materialized native home (Muse: XDG_CONFIG_HOME) with the auth file next to config that must not cross.
        const home = await mkdtemp(join(tmpdir(), 'stl-muse-')); directories.push(home);
        await mkdirAsync(join(home, 'muse'), { recursive: true });
        await writeFileAsync(join(home, 'muse', 'auth.json'), 'fixture-login');
        await writeFileAsync(join(home, 'muse', 'settings.json'), '{}');
        await writeFileAsync(join(home, 'muse', 'trust.json'), '{}');
        const launcher = join(await mkdtemp(join(tmpdir(), 'stl-l-')), 'fixture-muse'); directories.push(dirname(launcher));
        await writeFileAsync(launcher, '#!/bin/sh\n');
        // A fixture-only binary name: the fixture guest is this host, whose own PATH may hold a real `muse`.
        // Muse's installer downloads with the login: it only succeeds when the declared auth file reached the target.
        const recipe = 'test -f "$XDG_CONFIG_HOME/muse/auth.json" && mkdir -p "$HOME/.local/bin" && printf "#!/bin/sh\\n" > "$HOME/.local/bin/fixture-muse" '
            + '&& chmod 700 "$HOME/.local/bin/fixture-muse" && echo run >> "$HOME/recipe-runs"';
        const runtimeSpec = { id: 'muse', title: 'Muse CLI', binaryName: 'fixture-muse', knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreferenceDefault: 'system-first' as const, managedInstall: null, manualInstallKind: 'vendor_recipe' as const,
            manualInstallRecipes: { linux: [{ cmd: 'sh', args: ['-c', recipe] }] }, acceptsJavaScriptFileOverride: false };
        const launch = await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-10', agent: leasedAgent('muse', ['muse/auth.json'], runtimeSpec),
            onSessionEnd: () => undefined,
            runnerEnvironment: { XDG_CONFIG_HOME: home }, materializedRoot: home, requestAuthMaterializedRoot: null,
            agentCommand: launcher, workspace: { hostRoot: '/h', targetRoot: '/t' } });
        const agentHome = join(guest, '.happier', 'sessions', 'spawn-10', 'agent-home');
        expect(launch.env).toEqual({ XDG_CONFIG_HOME: agentHome });
        expect((await readdirAsync(agentHome, { recursive: true })).sort()).toEqual(['muse', join('muse', 'auth.json')]);
        await expect(readFileAsync(join(agentHome, 'muse', 'auth.json'), 'utf8')).resolves.toBe('fixture-login');
        expect(launch.executables[launcher]).toBe(join(guest, '.local', 'bin', 'fixture-muse'));
        await expect(readFileAsync(join(guest, 'recipe-runs'), 'utf8')).resolves.toBe('run\n');
    }, 60_000);

    it('refuses what a target cannot use: a loopback credential, an undeclared Agent home, a script or foreign-architecture CLI', async () => {
        const { target } = await localGuest();
        const base = { target, sessionKey: 'spawn-4', runnerEnvironment: {}, materializedRoot: null, agent: null, onSessionEnd: () => undefined,
            workspace: { hostRoot: '/h', targetRoot: '/t' } };
        // The two names of the workspace must not overlap: `/workspace/a/x` would be both a Session path and a target path.
        for (const workspace of [{ hostRoot: '/workspace/a', targetRoot: '/workspace' }, { hostRoot: '/srv', targetRoot: '/srv/ws' }]) {
            await expect(deliverSessionTargetLaunch({ ...base, workspace, requestAuthMaterializedRoot: null, agentCommand: process.execPath }))
                .rejects.toMatchObject({ code: 'workspace_root_unsafe' });
        }
        await expect(deliverSessionTargetLaunch({ ...base, requestAuthMaterializedRoot: '/host/request-auth', agentCommand: process.execPath }))
            .rejects.toMatchObject({ code: 'connected_service_target_unsupported' });
        await expect(deliverSessionTargetLaunch({ ...base, materializedRoot: await agentHome(), requestAuthMaterializedRoot: null, agentCommand: null }))
            .rejects.toMatchObject({ code: 'connected_service_target_unsupported' });
        const script = join(await mkdtemp(join(tmpdir(), 'stl-s-')), 'agent.sh'); directories.push(dirname(script));
        const { writeFile: writeFileAsync } = await import('node:fs/promises');
        await writeFileAsync(script, '#!/bin/sh\n');
        await expect(deliverSessionTargetLaunch({ ...base, requestAuthMaterializedRoot: null, agentCommand: script }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
        await expect(deliverSessionTargetLaunch({ ...base, requestAuthMaterializedRoot: null, agentCommand: process.execPath,
            target: { ...target, platform: { ...target.platform, arch: target.platform.arch === 'x64' ? 'arm64' : 'x64' } } }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
    });
});
