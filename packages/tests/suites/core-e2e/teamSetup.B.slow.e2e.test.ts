import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { DaemonLocalServiceLauncherStartResponseV1Schema, LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePreviewOpenOrCreateResponseV1Schema, parseLocalServiceDeclarationPreviewLandingUrlV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { ProjectPrepareResultV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { WorktreePortsResultV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';
import { ManagedServiceNativeLogResultV1Schema } from '@happier-dev/protocol/local/services/nativeLogsV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/sessionTerminalActionFamily';
import { SessionTerminalTargetV1Schema, type SessionTerminalViewTargetV1 } from '@happier-dev/protocol/terminal/workspace';
import { decodeTerminalStreamBytesFrame, TerminalStreamReadResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { createProjectServiceDeclarationTargetIdV1, LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import type { LocalServiceManagedServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol';
import { LocalServicePreviewNativeDirectAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import { loadIrohNodeNative } from '@happier-dev/iroh-native/node';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { appPaneReduce, createAppPaneState } from '../../../../apps/ui/sources/components/appShell/panes/model/appPaneReducer';
import { buildProjectPaneScopeId } from '../../../../apps/ui/sources/components/projects/detail/projectPaneScope';
import { registerSessionTerminalWorkspaceOwner } from '../../../../apps/ui/sources/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { storage } from '../../../../apps/ui/sources/sync/domains/state/storage';

import { repoRootDir } from '../../src/testkit/paths';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { waitFor } from '../../src/testkit/timing';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import type { CliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { runStressTasksWithConcurrencyLimit } from '../../src/testkit/stress/scenarios/runStressTasksWithConcurrencyLimit';
import { spawnLoggedProcess } from '../../src/testkit/process/spawnProcess';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';

let fixture: ProjectDaemonFixture | undefined;
let starter: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let retireTerminalPresentation: (() => void) | undefined;
let happyHomeDir: string;
let cliLaunchSpec: CliTestLaunchSpec;
let testDir: string;
let serverId: string;
let machineId: string;
let cliServerId: string;
const startedServices = new Map<string, LocalServiceManagedServiceActionTargetV1>();
const finiteOperations = new Set<string>();
const nativeRoots = new Set<string>();
const nativeProjects = new Map<string, { project: string; port: string }>();

beforeAll(async () => {
    // Only the disposable PostgreSQL harness may provide this URL. Never
    // inherit a retained development Stack's DATABASE_URL as a fallback.
    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    if (!databaseUrl) throw new Error('TS.B requires the disposable PostgreSQL harness URL');
    testDir = await mkdtemp(resolve(tmpdir(), 'team-setup-b-'));
    console.info(`[TS.B.fixture] ${testDir}`);
    fixture = await startProjectDaemonFixture({ testDir, serverEnv: {
        DATABASE_URL: databaseUrl, HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: '1',
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: '1',
    } });
    const account = await fixture.createAccount('member');
    starter = account;
    cliLaunchSpec = { command: process.execPath, args: ['--import',
        resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
        resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() };
    const enrolled = await fixture.enrollDaemon(account, { cliLaunchSpec,
        env: { HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink' },
    });
    happyHomeDir = enrolled.homeDir;
    serverId = enrolled.target.serverId;
    machineId = enrolled.target.machineId;
    cliServerId = enrolled.cliServerId;
}, 0);

// The canonical UI setup clears device storage before each test. Connect after
// that reset while retaining the external server and daemon for the suite.
beforeEach(async () => {
    if (!fixture) throw new Error('Fixture is unavailable');
    ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: starter.uiCredentials });
    try {
        await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId));
    } catch (cause) {
        const state = storage.getState();
        throw new Error(`B fixture readiness unavailable: ${JSON.stringify({
            accountReady: ui.isAccountReady(), machineActive: ui.isMachineActive(machineId),
            expectedMachineId: machineId, serverId, uiServerId: ui.serverId,
            profileScopeServerId: state.profileScope?.serverId ?? null,
            displayedMachines: Object.values(state.machines).map(machine => ({
                id: machine.id, active: machine.active, daemonStatus: machine.daemonState?.status ?? null,
            })),
        })}`, { cause });
    }
}, 0);

afterEach(async () => {
    retireTerminalPresentation?.();
    retireTerminalPresentation = undefined;
    const failures: unknown[] = [];
    for (const operationId of finiteOperations) {
        try { await action('action.operations.cancel', { operationId });
            await action('action.operations.get', { operationId, waitForTerminal: true });
        } catch (error) { failures.push(error); }
    }
    // Service lifetime intentionally survives daemon reconnect/re-adoption.
    // Stop our exact public service targets before stopping the fixture daemon.
    for (const target of startedServices.values()) {
        try { await action('localServices.actions.stopManaged', {
            requestId: randomUUID(), target, action: 'stop_managed',
        }); } catch (error) { failures.push(error); }
    }
    for (const root of nativeRoots) {
        try { await retainNativeProject(root); } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) failures.push(error);
        }
    }
    for (const root of nativeRoots) {
        try {
            // Native Stop retains stopped containers. Discover only containers
            // labelled with this exact fixture root, then use their observed
            // Compose project for complete container/network cleanup.
            const ids = execFileSync('docker', ['ps', '--all', '--no-trunc', '--quiet', '--filter',
                `label=com.docker.compose.project.working_dir=${root}`], { encoding: 'utf8' })
                .trim().split(/\r?\n/).filter(Boolean);
            const projects = new Set<string>();
            for (const id of ids) {
                if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker returned an inexact fixture container identity');
                projects.add(execFileSync('docker', ['inspect', '--format',
                    '{{ index .Config.Labels "com.docker.compose.project" }}', id], { encoding: 'utf8' }).trim());
            }
            for (const project of projects) {
                if (!project) throw new Error('Fixture container has no Compose project');
                execFileSync('docker', ['compose', '-f', resolve(testDir, 'compose-retire-compose-cleanup.yaml'),
                    '-p', project, 'down', '--remove-orphans'], {
                    env: { ...process.env, HAPPIER_WORKTREE_SLUG: project,
                        HAPPIER_WORKTREE_PORT: nativeProjects.get(root)?.port ?? '1' }, stdio: 'pipe',
                });
            }
        } catch (error) { failures.push(error); }
    }
    try { await ui?.close(); } catch (error) { failures.push(error); }
    ui = undefined;
    finiteOperations.clear();
    startedServices.clear();
    nativeRoots.clear();
    nativeProjects.clear();
    if (failures.length) throw new AggregateError(failures, 'TS.B composed cleanup failed');
}, 0);

afterAll(async () => { await fixture?.stop(); }, 0);

async function action(actionId: ActionId, input: unknown): Promise<unknown> {
    const execution = await invoke(actionId, input);
    expect(execution, `${actionId} must succeed at the real UI Action receiver`).toMatchObject({ ok: true });
    if (!execution.ok) throw new Error(`${actionId} refused: ${execution.errorCode}`);
    return execution.result;
}

async function invoke(actionId: ActionId, input: unknown) {
    if (!ui) throw new Error('Fixture UI is not ready');
    return invokeAs(ui, actionId, input);
}

async function invokeAs(client: Awaited<ReturnType<typeof connectUiActionClient>>, actionId: ActionId, input: unknown) {
    return client.executeConfirmed(actionId, input, {
        surface: 'ui', authority: 'present_user', serverId: client.serverId,
        actionCaller: { kind: 'host' },
    });
}

async function invokeCli(actionId: ActionId, input: unknown, observeApproval?: (artifactId: string) => void): Promise<unknown> {
    if (!fixture) throw new Error('Fixture is unavailable');
    const logPrefix = resolve(testDir, `cli-${randomUUID()}`);
    const launched = spawnLoggedProcess({ ...cliLaunchSpec, cwd: cliLaunchSpec.cwd ?? repoRootDir(),
        args: [...cliLaunchSpec.args, 'actions', 'invoke', actionId, '--input-json', JSON.stringify(input),
            '--server-id', cliServerId, '--json'],
        env: { ...sanitizeCliTestEnv(process.env), HAPPIER_HOME_DIR: happyHomeDir,
            HAPPIER_SERVER_URL: fixture.server.baseUrl, HAPPIER_WEBAPP_URL: fixture.server.baseUrl,
            HAPPIER_VARIANT: 'dev', CI: '1' },
        stdoutPath: `${logPrefix}.stdout.log`, stderrPath: `${logPrefix}.stderr.log`,
    });
    // The attenuated terminal credential requests approval. The independently
    // authenticated Account app decides through the existing public Action.
    const pendingDecisions = new Set<string>();
    let decisions = Promise.resolve();
    let failDecision!: (error: unknown) => void;
    const decisionFailure = new Promise<never>((_resolve, reject) => { failDecision = reject; });
    let stderr = '';
    launched.child.stderr?.on('data', chunk => {
        stderr += String(chunk);
        let newline: number;
        while ((newline = stderr.indexOf('\n')) >= 0) {
            const line = stderr.slice(0, newline);
            stderr = stderr.slice(newline + 1);
            let notification: unknown;
            try { notification = JSON.parse(line); } catch { continue; }
            if (!notification || typeof notification !== 'object' || !('data' in notification)) continue;
            const data = notification.data;
            if (!data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'approval_request_created'
                || !('artifactId' in data) || typeof data.artifactId !== 'string' || pendingDecisions.has(data.artifactId)) continue;
            const artifactId = data.artifactId;
            pendingDecisions.add(artifactId);
            observeApproval?.(artifactId);
            decisions = decisions.then(async () => { await action('approval.request.decide', { artifactId, decision: 'approve' }); });
            void decisions.catch(failDecision);
        }
    });
    const exited = new Promise<void>((resolve, reject) => {
        launched.child.once('error', reject);
        launched.child.once('close', () => resolve());
    });
    try {
        await Promise.race([exited, decisionFailure]);
        await decisions;
        const lines = (await readFile(launched.stdoutPath, 'utf8')).trim().split(/\r?\n/);
        const result: unknown = JSON.parse(lines.at(-1) ?? '');
        expect(result).toMatchObject({ v: 1, ok: expect.any(Boolean) });
        return result;
    } finally { await launched.stop(); }
}

async function cliAction(actionId: ActionId, input: unknown): Promise<unknown> {
    const result = await invokeCli(actionId, input);
    expect(result, `${actionId} must succeed at the real CLI receiver`).toMatchObject({ ok: true });
    if (!result || typeof result !== 'object' || !('data' in result)) throw new Error('CLI Action returned no data');
    return result.data;
}

function serviceTerminalPresentation(workspace: WorkspaceAddressV1) {
    const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
    let pane = appPaneReduce(createAppPaneState({ maxScopesInMemory: 1 }), { type: 'activateScope', scopeId });
    retireTerminalPresentation = registerSessionTerminalWorkspaceOwner({ getState: () => pane,
        dispatch: command => { pane = appPaneReduce(pane, command); } });
    return {
        scopeId,
        present: async (target: SessionTerminalViewTargetV1) => SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS['session.terminals.open']
            .parse(await action('session.terminals.open', { scopeId, target })),
        presentedWorkspace: async () => SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS['session.terminals.list']
            .parse(await action('session.terminals.list', { scopeId })).workspace,
    };
}

async function open(root: string): Promise<WorkspaceAddressV1> {
    const result = OpenProjectResultV1Schema.parse(await action('projects.open', {
        serverId, machineId, source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
    }));
    expect(result).toMatchObject({ kind: 'opened' });
    if (result.kind !== 'opened') throw new Error(`Project open did not complete: ${result.kind}`);
    return result.workspace;
}

function serviceRequest(workspace: WorkspaceAddressV1) {
    const selection = { kind: 'manifest' as const, name: 'web' };
    const targetId = createProjectServiceDeclarationTargetIdV1({ serverId: workspace.serverId,
        machineId: workspace.machineId, id: workspace.workspaceId }, selection);
    return { machineId, targetId, workspace, declaration: { workspaceRefId: workspace.workspaceId, selection } };
}

async function start(workspace: WorkspaceAddressV1, receiver: 'ui' | 'cli' = 'ui') {
    const request = serviceRequest(workspace);
    const raw = await (receiver === 'cli' ? cliAction : action)('localServices.launcher.start', request);
    const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(raw);
    if (result.currentTarget) startedServices.set(result.currentTarget.managedServiceId, result.currentTarget);
    expect(result, `Project service start status=${result.status} reason=${result.reasonCode ?? 'none'}`)
        .toMatchObject({ status: 'succeeded' });
    const target = result.snapshot.targets.find(target => target.id === request.targetId);
    expect(target?.endpointUrl, 'Serving endpoint comes from the real service supervisor').toEqual(expect.any(String));
    if (!target?.endpointUrl) throw new Error('Started service has no observed endpoint');
    return { result, target, url: target.endpointUrl };
}

async function withOccupiedPort(port: number, run: () => Promise<void>) {
    const foreign = createServer((_request, response) => response.end('foreign-marker'));
    try {
        await new Promise<void>((resolve, reject) => {
            foreign.once('error', reject);
            foreign.listen(port, '127.0.0.1', resolve);
        });
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('foreign-marker');
        await run();
    } finally {
        foreign.closeAllConnections();
        if (foreign.listening) await new Promise<void>((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
    }
}

async function previewTunnel(previewId: string) {
    if (!fixture) throw new Error('Fixture is unavailable');
    const loaded = loadIrohNodeNative(process.env.HAPPIER_IROH_TEST_PACKAGE_ROOT ?? resolve(repoRootDir(), 'packages/iroh-native'));
    if (!loaded.available) throw new Error('The real native preview addon is unavailable');
    const native = loaded.native;
    const viewer = await native.createEndpoint({ relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const proof = createEphemeralPeerRouteProofHandleV2({ randomBytes });
    let leaseId: string | undefined;
    const close = async () => {
        try { if (leaseId) await native.stopMachineTunnel(leaseId); }
        finally { proof.dispose(); await native.shutdownEndpoint({ endpointHandle: viewer.endpointHandle }); }
    };
    try {
        const response = await fetch(`${fixture.server.baseUrl}/v1/local-services/preview/${encodeURIComponent(previewId)}/access`, {
            method: 'POST', headers: { authorization: `Bearer ${starter.auth.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, initiator: { kind: 'account_client', endpointId: viewer.endpointId },
                ephemeralPublicKeyBase64Url: proof.publicKeyBase64Url }),
        });
        expect(response.status).toBe(200);
        const access = LocalServicePreviewNativeDirectAccessV1Schema.parse(await response.json());
        const signedProof = proof.sign(access.grant);
        const grant = access.grant.payload;
        if (grant.scope.kind !== 'tcp_tunnel' || !grant.iroh) throw new Error('Preview access did not return its native tunnel grant');
        const open = { v: 2, kind: 'open', tunnelId: grant.scope.tunnelId, targetMachineId: machineId,
            routeKind: 'iroh_peer', destination: access.destination, grant: access.grant, proof: signedProof };
        const handshake = { v: 1, flow: 'tcp_tunnel', accountId: grant.accountId,
            initiator: grant.iroh.initiator, target: grant.iroh.target, grant: access.grant, proof: signedProof };
        const lease = await native.startMachineTunnel({ endpointHandle: viewer.endpointHandle,
            endpointId: access.target.endpointId, directAddresses: access.target.directAddresses,
            relayUrls: access.target.relayUrls, handshakeJson: JSON.stringify(handshake),
            nativeHttpLease: { openJson: JSON.stringify(open) }, capProfile: 'machineBulk' });
        leaseId = lease.machineTunnelId;
        return { url: `http://127.0.0.1:${lease.localPort}`, close };
    } catch (error) { await close(); throw error; }
}

async function stop(target: LocalServiceManagedServiceActionTargetV1) {
    await action('localServices.actions.stopManaged', { requestId: randomUUID(), target, action: 'stop_managed' });
    startedServices.delete(target.managedServiceId);
}

async function admittedControl(label: string, receiver: 'ui' | 'cli' = 'ui') {
    const root = resolve(testDir, `admitted-control-${label}`);
    const port = await reserveAvailablePort();
    await initGitRepo({ repoDir: root });
    await mkdir(resolve(root, '.happier'), { recursive: true });
    await writeFile(resolve(root, 'control.cjs'), `require('node:http').createServer((_request,response)=>{
response.setHeader('content-type','application/json');response.end(JSON.stringify({marker:'admitted-${label}',pid:process.pid}));
}).listen(Number(process.argv[2]),'127.0.0.1');`);
    await writeFile(resolve(root, '.happier/project.json'), JSON.stringify({ version: 1, services: { web: {
        source: { kind: 'command', command: `"${process.execPath}" ./control.cjs ${port}` }, port,
    } } }));
    execGit(root, ['add', '.']);
    execGit(root, ['commit', '-m', 'test: admitted existing service control']);
    const control = await start(await open(root), receiver);
    try {
        await waitFor(async () => (await fetch(control.url)).ok);
        expect(await (await fetch(control.url)).json()).toMatchObject({ marker: `admitted-${label}`, pid: expect.any(Number) });
        console.info(`[TS.B.control] ${label} passed through ${receiver} Action receiver`);
    } finally {
        if (control.result.currentTarget) await stop(control.result.currentTarget);
    }
}

async function createWorktrees(label: string, runtime: Readonly<Record<string, unknown>> = {}, native = false) {
    const fixtureDir = resolve(testDir, label);
    const firstRoot = resolve(fixtureDir, 'first-worktree');
    const secondRoot = resolve(fixtureDir, 'second-worktree');
    await initGitRepo({ repoDir: firstRoot });
    await mkdir(resolve(firstRoot, '.happier'), { recursive: true });
    await writeFile(resolve(firstRoot, 'server.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const facts = { marker: path.basename(process.cwd()), pid: process.pid,
  port: process.env.PORT, slot: process.env.HAPPIER_WORKTREE_PORT, worktreeUrl: process.env.HAPPIER_WORKTREE_URL };
fs.appendFileSync('launches.jsonl', JSON.stringify(facts) + '\\n');
console.log(JSON.stringify(facts));
http.createServer((request, response) => { response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(facts)); }).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await writeFile(resolve(firstRoot, 'hold.cjs'), "require('node:fs').writeFileSync('finite-active','ready');setInterval(()=>{},1000);");
    if (native) {
        await writeFile(resolve(firstRoot, 'compose.yaml'), `
name: \${HAPPIER_WORKTREE_SLUG}
services:
  web:
    image: busybox:1.37
    ports: ["127.0.0.1:\${HAPPIER_WORKTREE_PORT}:8080"]
    environment:
      WORKTREE_MARKER: \${HAPPIER_WORKTREE_SLUG}
    command:
      - sh
      - -c
      - |
        mkdir -p /www
        printf '%s' "$$WORKTREE_MARKER" >/www/index.html
        exec httpd -f -p 8080 -h /www
`);
        await writeFile(resolve(firstRoot, 'setup.cjs'), "const fs=require('node:fs');if(fs.existsSync('fail-setup'))process.exit(13);fs.appendFileSync('setup-runs','setup\\n');fs.writeFileSync('setup-facts.json',JSON.stringify({project:process.env.HAPPIER_WORKTREE_SLUG,port:process.env.HAPPIER_WORKTREE_PORT}));");
        await writeFile(resolve(firstRoot, 'teardown.cjs'), "const fs=require('node:fs'); if(fs.existsSync('fail-teardown'))process.exit(17);fs.appendFileSync('teardown-runs','teardown\\n');");
        await writeFile(resolve(firstRoot, '.gitignore'), 'launches.jsonl\nsetup-runs\nsetup-facts.json\nteardown-runs\nfail-teardown\nfail-setup\n');
        const cleanupFile = resolve(testDir, `${label}-compose-cleanup.yaml`);
        await writeFile(cleanupFile, await readFile(resolve(firstRoot, 'compose.yaml')));
        nativeRoots.add(firstRoot);
        nativeRoots.add(secondRoot);
    }
    await writeFile(resolve(firstRoot, '.happier/project.json'), JSON.stringify({ version: 1,
        scripts: { hold: { source: { kind: 'command', command: `"${process.execPath}" ./hold.cjs` } } },
        worktreePorts: { enabled: true, slots: 1 }, services: { web: {
            source: native ? { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'web' }
                : { kind: 'command', command: `"${process.execPath}" ./server.cjs` },
            runtime: { primary: true, portSlot: 0, ...runtime },
        } },
        ...(native ? { workspace: {
            setup: [{ kind: 'command', command: `"${process.execPath}" ./setup.cjs` }],
            teardown: [{ kind: 'command', command: `"${process.execPath}" ./teardown.cjs` }],
        } } : {}),
    }));
    execGit(firstRoot, ['add', '.']);
    execGit(firstRoot, ['commit', '-m', 'test: fixture project service']);
    execGit(firstRoot, ['worktree', 'add', '-b', 'second-fixture', secondRoot]);
    return { roots: [firstRoot, secondRoot], workspaces: [await open(firstRoot), await open(secondRoot)] };
}

it('TS.B.environment: two opted-in worktrees receive distinct retained ports and their own app', async () => {
    await admittedControl('environment');
    const { roots, workspaces } = await createWorktrees('environment');
    const [first, second] = await Promise.all(workspaces.map(workspace => start(workspace)));
    const readMarker = async (url: string) => {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        return response.json() as Promise<{ marker: string; pid: number; port: string; slot: string }>;
    };
    await waitFor(async () => (await fetch(first.url)).ok && (await fetch(second.url)).ok);
    const facts = await Promise.all([readMarker(first.url), readMarker(second.url)]);
    expect(facts.map(fact => fact.marker)).toEqual(['first-worktree', 'second-worktree']);
    expect(facts[0].port).not.toBe(facts[1].port);
    expect(facts.map(fact => fact.slot)).toEqual(facts.map(fact => fact.port));
    expect(new URL(first.url).port).toBe(facts[0].port);
    expect(new URL(second.url).port).toBe(facts[1].port);
    const retainedFile = resolve(happyHomeDir, 'worktree-ports.json');
    const retainedBytes = await readFile(retainedFile, 'utf8');
    const retainedStat = await stat(retainedFile, { bigint: true });
    const physicalRoots = await Promise.all(roots.map(root => realpath(root)));
    const retained = await assignments();
    expect(physicalRoots.map(root => retained.assignments[root]?.ports.length)).toEqual([1, 1]);
    for (const [index, started] of [first, second].entries()) {
        expect(started.target.portSource).toBe('assigned');
        expect(started.result.snapshot.worktreePorts).toMatchObject({ rootPath: physicalRoots[index], declaredSlots: 1,
            result: { kind: 'ready', assignment: retained.assignments[physicalRoots[index]!] } });
    }
    // These are real unrelated encrypted records delivered by the same Home,
    // not extra daemons. Selected-root assignment work must remain unchanged.
    if (!fixture) throw new Error('Fixture is unavailable');
    const baseUrl = fixture.server.baseUrl;
    const token = starter.credentials.token;
    const encryption = starter.credentials.encryption;
    if (encryption.type !== 'dataKey') throw new Error('B encrypted census requires the fixture Account data key');
    const wrap = (dataKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey,
        recipientPublicKey: encryption.publicKey,
        randomBytes: length => new Uint8Array(randomBytes(length)),
    })).toString('base64');
    const unrelatedMachines = await runStressTasksWithConcurrencyLimit(Array.from({ length: 100 }, (_, index) => index),
        16, async index => {
            const dataKey = new Uint8Array(randomBytes(32));
            const created = await registerMachineIdentity({ baseUrl, token,
                metadata: encryptDataKeyBase64({ host: `unrelated-${index}`, platform: 'linux',
                    homeDir: '/home/test', happyHomeDir: '/home/test/.happier', happyCliVersion: 'test' }, dataKey),
                dataEncryptionKey: wrap(dataKey) });
            expect(created.status).toBe(200);
            return created.machineId;
        });
    await runStressTasksWithConcurrencyLimit(Array.from({ length: 1_000 }, (_, index) => index), 16, async index => {
        const dataKey = new Uint8Array(randomBytes(32));
        return createSessionWithCiphertexts({ baseUrl, token,
            metadataCiphertextBase64: encryptDataKeyBase64({ path: `/home/test/unrelated-${index}`,
                machineId: unrelatedMachines[index % unrelatedMachines.length], host: 'unrelated', flavor: 'claude' }, dataKey),
            dataEncryptionKeyBase64: wrap(dataKey),
            agentStateCiphertextBase64: encryptDataKeyBase64({ requests: {}, completedRequests: {} }, dataKey) });
    });
    await Promise.all(workspaces.map(workspace => start(workspace)));
    expect(await readMarker(first.url)).toEqual(facts[0]);
    expect(await readMarker(second.url)).toEqual(facts[1]);
    expect(await readFile(retainedFile, 'utf8')).toBe(retainedBytes);
    const reusedStat = await stat(retainedFile, { bigint: true });
    expect({ inode: reusedStat.ino, modified: reusedStat.mtimeNs }).toEqual({
        inode: retainedStat.ino, modified: retainedStat.mtimeNs,
    });
    for (const root of roots) {
        expect((await readFile(resolve(root, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    }
    expect(await action('projects.worktree.ports.reassign', { workspace: workspaces[0] })).toMatchObject({
        kind: 'unavailable', code: 'project_worktree_ports_active', reason: 'active',
    });
    if (!first.result.currentTarget) throw new Error('Started service lost its control target');
    await stop(first.result.currentTarget);
    await admittedControl('environment-cli', 'cli');
    await withOccupiedPort(Number(facts[0].port), async () => {
        expect(await invokeCli('localServices.launcher.start', serviceRequest(workspaces[0]!)))
            .toMatchObject({ ok: true, data: { status: 'failed', reasonCode: 'project_service_start_unavailable',
                establishmentFailure: { cause: 'port_in_use', port: Number(facts[0].port),
                    lastStderrLine: expect.stringContaining('EADDRINUSE') } } });
        expect((await assignments()).assignments).toEqual(retained.assignments);
    });
    const finite = ProjectCommandActionOutputV1Schema.parse(await action('projects.script.run', {
        workspace: workspaces[0], selection: { kind: 'named', name: 'hold' },
    }));
    finiteOperations.add(finite.operation.operationId);
    try {
        await waitFor(async () => { await access(resolve(roots[0]!, 'finite-active')); return true; });
        expect(await action('projects.worktree.ports.reassign', { workspace: workspaces[0] })).toMatchObject({
            kind: 'unavailable', code: 'project_worktree_ports_active', reason: 'active',
        });
    } finally {
        await action('action.operations.cancel', { operationId: finite.operation.operationId });
        await action('action.operations.get', { operationId: finite.operation.operationId, waitForTerminal: true });
        finiteOperations.delete(finite.operation.operationId);
    }
    const reassigned = WorktreePortsResultV1Schema.parse(
        await action('projects.worktree.ports.reassign', { workspace: workspaces[0] }));
    expect(reassigned).toMatchObject({ kind: 'ready', assignment: { ports: [expect.any(Number)] } });
    if (reassigned.kind !== 'ready') throw new Error(`Stopped-worktree Reassign refused: ${reassigned.reason}`);
    const afterReassign = await assignments();
    expect(reassigned.assignment).toEqual(afterReassign.assignments[physicalRoots[0]!]);
    expect(afterReassign.assignments[physicalRoots[0]!]!.ports).not.toEqual(retained.assignments[physicalRoots[0]!]!.ports);
    expect(afterReassign.assignments[physicalRoots[1]!]).toEqual(retained.assignments[physicalRoots[1]!]);
    const restarted = await start(workspaces[0]!, 'cli');
    expect(new URL(restarted.url).port).toBe(String(afterReassign.assignments[physicalRoots[0]!]!.ports[0]));
    expect(restarted.target.portSource).toBe('assigned');
    expect(restarted.result.snapshot.worktreePorts).toMatchObject({ rootPath: physicalRoots[0],
        result: reassigned });
    expect(await readMarker(restarted.url)).toMatchObject({ marker: 'first-worktree',
        port: String(afterReassign.assignments[physicalRoots[0]!]!.ports[0]) });
});

async function prepare(workspace: WorkspaceAddressV1, phase: 'setup' | 'teardown' = 'setup', expectedState: 'succeeded' | 'failed' = 'succeeded') {
    const started = ProjectPrepareResultV1Schema.parse(await action('projects.prepare', { workspace, phase }));
    if (!('operation' in started)) return started;
    const observed = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
        operationId: started.operation.operationId, waitForTerminal: true, includeSetupReview: true,
    }));
    if (observed.kind !== 'found') throw new Error('Project preparation operation disappeared');
    if (observed.operation.setupReview) {
        await action('projects.prepare', { workspace, phase, heldOperationId: started.operation.operationId,
            expectedEffectDigest: observed.operation.setupReview.reviewedEffectDigest, consentScope: 'thisTime' });
    }
    const settled = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
        operationId: started.operation.operationId, waitForTerminal: true,
    }));
    expect(settled).toMatchObject({ kind: 'found', operation: { state: expectedState } });
    return settled;
}

async function assignments() {
    // This file belongs solely to the fixture daemon. Read the actual retained
    // owner record so teardown/removal cannot pass by merely changing a view.
    return JSON.parse(await readFile(resolve(happyHomeDir, 'worktree-ports.json'), 'utf8')) as {
        v: 1; assignments: Record<string, { ports: number[]; listenerPorts: Record<string, number> }>;
    };
}

async function retainNativeProject(root: string) {
    const facts: unknown = JSON.parse(await readFile(resolve(root, 'setup-facts.json'), 'utf8'));
    if (!facts || typeof facts !== 'object' || !('project' in facts) || typeof facts.project !== 'string'
        || !('port' in facts) || typeof facts.port !== 'string') throw new Error('Native setup did not receive its port/slug environment');
    nativeProjects.set(root, { project: facts.project, port: facts.port });
}

it('TS.B.composeRetire: setup autostarts once, failed teardown retains the root, and successful removal releases only it', async () => {
    await admittedControl('compose-retire');
    const failedSetup = await createWorktrees('compose-failed-setup', { autostart: true }, true);
    await writeFile(resolve(failedSetup.roots[0]!, 'fail-setup'), 'fail');
    expect(await prepare(failedSetup.workspaces[0]!, 'setup', 'failed')).toMatchObject({
        kind: 'found', operation: { error: { errorCode: 'project_setup_step_failed',
            details: { kind: 'finiteCommand', phase: 'setup', step: 0, exitCode: 13 } } },
    });
    expect(execFileSync('docker', ['ps', '--all', '--quiet', '--filter',
        `label=com.docker.compose.project.working_dir=${failedSetup.roots[0]}`], { encoding: 'utf8' }).trim()).toBe('');
    await expect(readFile(resolve(failedSetup.roots[0]!, 'setup-facts.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const { roots, workspaces } = await createWorktrees('compose-retire', { autostart: true }, true);
    await Promise.all(workspaces.map(workspace => prepare(workspace)));
    await Promise.all(roots.map(retainNativeProject));
    for (const root of roots) {
        const native = nativeProjects.get(root);
        if (!native) throw new Error('Successful setup did not record its native Project identity');
        await waitFor(async () => (await fetch(`http://127.0.0.1:${native.port}`)).ok);
    }
    // Start now adopts autostarted native instances. It must not launch another
    // Compose project, nor may preparing again replay the setup/autostart effect.
    await admittedControl('compose-retire-cli', 'cli');
    const [first, second] = await Promise.all(workspaces.map(workspace => start(workspace, 'cli')));
    const markers = await Promise.all([first.url, second.url].map(async url => (await fetch(url)).text()));
    expect(markers[0]).not.toBe(markers[1]);
    const nativeOccurrence = () => execFileSync('docker', ['ps', '--quiet', '--filter',
        `label=com.docker.compose.project.working_dir=${roots[0]}`], { encoding: 'utf8' }).trim();
    const beforeShowLogs = nativeOccurrence();
    expect(beforeShowLogs).not.toBe('');
    const logs = ManagedServiceNativeLogResultV1Schema.parse(await action('machines.services.logs.read', {
        serverId, machineId, serviceId: first.target.id,
    }));
    expect(logs).toMatchObject({ kind: 'page' });
    expect(nativeOccurrence(), 'Show logs keeps the already-running native container').toBe(beforeShowLogs);
    expect(await (await fetch(first.url)).text()).toBe(markers[0]);
    const physicalRoots = await Promise.all(roots.map(root => realpath(root)));
    const before = await assignments();
    expect(before.assignments[physicalRoots[0]!]?.ports[0]).not.toBe(before.assignments[physicalRoots[1]!]?.ports[0]);
    if (!second.result.currentTarget) throw new Error('Native Start lost its control target');
    await stop(second.result.currentTarget);
    await withOccupiedPort(Number(new URL(second.url).port), async () => {
        expect(await invokeCli('localServices.launcher.start', serviceRequest(workspaces[1]!)))
            .toMatchObject({ ok: true, data: { status: 'failed', reasonCode: 'deployment_port_in_use' } });
        expect((await assignments()).assignments).toEqual(before.assignments);
    });
    await prepare(workspaces[1]!);
    expect(await readFile(resolve(roots[1]!, 'setup-runs'), 'utf8')).toBe('setup\n');
    const stopped = await invoke('localServices.preview.openOrCreate', { machineId, launchTargetId: second.target.id });
    expect(stopped).toMatchObject({ ok: false, errorCode: 'service_not_listening',
        error: 'local_service_preview_lifecycle_refused:service_not_listening' });
    await writeFile(resolve(roots[1]!, 'fail-teardown'), 'fail');
    const request = { machineId, cwd: roots[0], worktreePath: roots[1], confirmed: true,
        authorizationToken: 'remove-worktree' };
    const refused = await invoke('scm.worktree.remove', request);
    expect(refused).toMatchObject({ ok: false, errorCode: 'project_setup_step_failed', details: {
        kind: 'finiteCommand', phase: 'teardown', step: 0, exitCode: 17, signal: null,
    } });
    await access(roots[1]!);
    expect((await assignments()).assignments).toEqual(before.assignments);
    await unlink(resolve(roots[1]!, 'fail-teardown'));
    const removalAlias = resolve(testDir, 'compose-retire-removal-alias');
    await symlink(roots[1]!, removalAlias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await realpath(removalAlias)).toBe(physicalRoots[1]);
    const removed = await action('scm.worktree.remove', { ...request, worktreePath: removalAlias });
    expect(removed).toMatchObject({ success: true });
    await expect(access(roots[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await waitFor(async () => !Object.hasOwn((await assignments()).assignments, physicalRoots[1]!));
    const after = await assignments();
    expect(after.assignments).not.toHaveProperty(physicalRoots[1]!);
    expect(after.assignments[physicalRoots[0]!]).toEqual(before.assignments[physicalRoots[0]!]);
    expect(await (await fetch(first.url)).text()).toBe(markers[0]);

    // Explicit removal reconciles Git's retained physical registration after
    // the checkout disappears outside Happier. Availability alone never releases it.
    const external = await createWorktrees('compose-external-removal', { autostart: true }, true);
    await prepare(external.workspaces[1]!);
    await retainNativeProject(external.roots[1]!);
    const externalService = await start(external.workspaces[1]!);
    if (!externalService.result.currentTarget) throw new Error('Native Start lost its control target');
    await stop(externalService.result.currentTarget);
    const externallyRemovedPhysicalRoot = await realpath(external.roots[1]!);
    const beforeExternalRemoval = await assignments();
    expect(beforeExternalRemoval.assignments).toHaveProperty(externallyRemovedPhysicalRoot);
    await rm(external.roots[1]!, { recursive: true });
    expect((await assignments()).assignments).toEqual(beforeExternalRemoval.assignments);
    expect(await action('scm.worktree.remove', { machineId, cwd: external.roots[0], worktreePath: external.roots[1],
        confirmed: true, authorizationToken: 'remove-worktree' })).toMatchObject({ success: true });
    await waitFor(async () => !Object.hasOwn((await assignments()).assignments, externallyRemovedPhysicalRoot));
    expect((await assignments()).assignments[physicalRoots[0]!]).toEqual(beforeExternalRemoval.assignments[physicalRoots[0]!]);
    expect(await (await fetch(first.url)).text()).toBe(markers[0]);
});

it('TS.B.terminal: interactive Start returns the existing service terminal without a second process', async () => {
    await admittedControl('terminal');
    const { roots, workspaces } = await createWorktrees('terminal', { terminal: true });
    const initial = await start(workspaces[0]!);
    expect(initial.result).toMatchObject({ terminalView: { kind: 'terminal_view', machineId,
        terminalId: expect.any(String), terminalKey: expect.any(String), interactive: true } });
    const terminal = SessionTerminalTargetV1Schema.parse(initial.result.terminalView);
    if (terminal.kind !== 'terminal_view') throw new Error('Service response did not return a borrowed terminal');
    const read = async (byteOffset: number, holdForOutput = false) => {
        const result = TerminalStreamReadResponseSchema.parse(await action('machines.terminal.read', {
            serverId: workspaces[0]!.serverId, machineId, terminalId: terminal.terminalId, byteOffset, holdForOutput,
        }));
        if (!result.ok) throw new Error(`Service terminal read refused: ${result.code}`);
        return result;
    };
    let output = await read(0, true);
    expect(output.frames.filter(frame => frame.t === 'bytes')
        .map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)).toString('utf8')).join('')).toContain('first-worktree');
    const firstBody = await (await fetch(initial.url)).json();
    const { scopeId, present, presentedWorkspace } = serviceTerminalPresentation(workspaces[0]!);
    const shown = await present(terminal);
    expect(await present(terminal)).toEqual(shown);
    expect((await presentedWorkspace()).tabs).toHaveLength(1);
    await action('session.terminals.focus', { scopeId, terminalId: shown.terminalId });
    await action('session.terminals.close', { scopeId, terminalId: shown.terminalId });
    expect((await presentedWorkspace()).tabs).toHaveLength(0);
    expect(await (await fetch(initial.url)).json()).toEqual(firstBody);
    await present(terminal);
    expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    if (!fixture) throw new Error('Fixture is unavailable');
    const manager = await fixture.createAccount('other-manager');
    const accountId = readAccountIdFromToken(manager.credentials.token);
    if (!accountId) throw new Error('The second real Account has no identity');
    await action('machines.access.grant.set', { serverId, machineId,
        principal: { kind: 'account', accountId }, level: 'admin' });
    await ui!.close();
    ui = undefined;
    const otherUi = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: manager.uiCredentials });
    try {
        await waitFor(() => otherUi.isAccountReady() && otherUi.isMachineActive(machineId));
        const terminalIdentity = { serverId: workspaces[0]!.serverId, machineId, terminalId: terminal.terminalId };
        expect(await invokeAs(otherUi, 'machines.terminal.read', { ...terminalIdentity, byteOffset: 0 }))
            .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
        expect(await invokeAs(otherUi, 'machines.terminal.write', { ...terminalIdentity,
            event: { t: 'key', key: 'c', modifiers: ['ctrl'] } }))
            .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
        expect(await invokeAs(otherUi, 'machines.services.logs.read', {
            serverId: workspaces[0]!.serverId, machineId, serviceId: initial.target.id,
        })).toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
    } finally {
        await otherUi.close();
        ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: starter.uiCredentials });
        await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId));
    }
    const again = await start(workspaces[0]!);
    expect(again.result).toMatchObject({ terminalView: expect.objectContaining({ kind: 'terminal_view' }) });
    const retainedMember = await present(terminal);
    expect(await (await fetch(again.url)).json()).toEqual(firstBody);
    expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    await action('machines.terminal.write', { serverId: workspaces[0]!.serverId, machineId,
        terminalId: terminal.terminalId, event: { t: 'key', key: 'c', modifiers: ['ctrl'] } });
    while (!output.done) output = await read(output.nextByteOffset, true);
    expect((await read(output.nextByteOffset)).done).toBe(true);
    expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    if (!initial.result.currentTarget) throw new Error('Interactive Start lost its control target');
    await stop(initial.result.currentTarget);
    const restarted = await start(workspaces[0]!);
    expect(await (await fetch(restarted.url)).json()).not.toEqual(firstBody);
    const restartedTerminal = SessionTerminalTargetV1Schema.parse(restarted.result.terminalView);
    if (restartedTerminal.kind !== 'terminal_view') throw new Error('Restarted service has no terminal view');
    expect(restartedTerminal.terminalId).not.toBe(terminal.terminalId);
    expect(await present(restartedTerminal)).toEqual(retainedMember);
    expect((await presentedWorkspace()).tabs).toMatchObject([{ terminals: [{ id: retainedMember.terminalId,
        target: { terminalId: restartedTerminal.terminalId, terminalKey: restartedTerminal.terminalKey } }] }]);
});

it('TS.B.actionParity: CLI Copy/Open preserve the destination and approved Restart changes only its occurrence', async () => {
    await admittedControl('action-parity');
    await admittedControl('action-parity-cli', 'cli');
    const { roots, workspaces } = await createWorktrees('action-parity', { terminal: true });
    const [initial, sibling] = await Promise.all(workspaces.map(workspace => start(workspace)));
    const terminal = SessionTerminalTargetV1Schema.parse(initial.result.terminalView);
    if (terminal.kind !== 'terminal_view') throw new Error('Initial service has no terminal view');
    const { present, presentedWorkspace } = serviceTerminalPresentation(workspaces[0]!);
    const retainedMember = await present(terminal);
    if (!initial.result.currentTarget) throw new Error('Initial service lost its control target');
    const beforeCliRestart = await (await fetch(initial.url)).json();
    const siblingBefore = await (await fetch(sibling.url)).json();
    const copyDestination = async (target: LocalServiceManagedServiceActionTargetV1) => {
        const copied = await cliAction('localServices.actions.copyUrl', { requestId: randomUUID(), target, action: 'copy_url' });
        expect(copied).toMatchObject({ status: 'succeeded', action: 'copy_url', destinationUrl: expect.any(String) });
        if (!copied || typeof copied !== 'object' || !('destinationUrl' in copied) || typeof copied.destinationUrl !== 'string')
            throw new Error('CLI Copy returned no canonical destination');
        return copied.destinationUrl;
    };
    const copiedUrl = await copyDestination(initial.result.currentTarget);
    expect(copiedUrl).toBe(beforeCliRestart.worktreeUrl);
    const copiedLocator = parseLocalServiceDeclarationPreviewLandingUrlV1(copiedUrl);
    expect(copiedLocator).toEqual({ serverId, machineId, targetId: initial.target.id });
    if (!copiedLocator) throw new Error('CLI Copy did not return a stable declaration locator');
    // CI is deliberately headless. Open reaches its real presentation owner
    // and reports that OS prerequisite rather than claiming browser success.
    expect(await invokeCli('localServices.actions.openPreview', { requestId: randomUUID(),
        target: initial.result.currentTarget, action: 'open_preview' })).toMatchObject({
        ok: false, error: { code: 'browser_unavailable', details: { destinationUrl: copiedUrl } },
    });
    expect(await (await fetch(initial.url)).json()).toEqual(beforeCliRestart);
    expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    const approvals = new Set<string>();
    const restartResult = await invokeCli('localServices.actions.restartManaged', {
        requestId: randomUUID(), target: initial.result.currentTarget, action: 'restart_managed',
    }, artifactId => approvals.add(artifactId));
    expect(restartResult, 'The real CLI receiver must admit service Restart').toMatchObject({ ok: true });
    if (!restartResult || typeof restartResult !== 'object' || !('data' in restartResult)) throw new Error('CLI Restart returned no data');
    const cliRestart = LocalServiceActionResultV1Schema.parse(restartResult.data);
    expect(cliRestart).toMatchObject({ status: 'succeeded', action: 'restart_managed' });
    expect(approvals.size, 'One parent approval admits the service Restart').toBe(1);
    const afterCliRestart = LocalServiceLauncherSnapshotV1Schema.parse(await action('localServices.launcher.snapshot', {
        machineId, workspaceRoot: roots[0],
    })).targets.find(target => target.id === initial.target.id);
    if (!afterCliRestart?.endpointUrl) throw new Error('CLI Restart produced no serving occurrence');
    const cliTerminal = SessionTerminalTargetV1Schema.parse(afterCliRestart.terminalView);
    if (cliTerminal.kind !== 'terminal_view') throw new Error('CLI Restart produced no terminal view');
    expect(cliTerminal.terminalId).not.toBe(terminal.terminalId);
    const afterCliRestartFacts = await (await fetch(afterCliRestart.endpointUrl)).json();
    expect(afterCliRestartFacts.pid).not.toBe(beforeCliRestart.pid);
    expect(afterCliRestartFacts.worktreeUrl).toBe(copiedUrl);
    if (afterCliRestart.sourceClass?.kind !== 'managed_service') throw new Error('Restarted service has no managed identity');
    const restartedTarget = { ...initial.result.currentTarget, managedServiceId: afterCliRestart.sourceClass.managedServiceId };
    startedServices.delete(initial.result.currentTarget.managedServiceId);
    startedServices.set(restartedTarget.managedServiceId, restartedTarget);
    expect(await copyDestination(restartedTarget)).toBe(copiedUrl);
    const copiedPreview = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(
        await action('localServices.preview.openOrCreate', { machineId: copiedLocator.machineId, launchTargetId: copiedLocator.targetId }));
    expect(copiedPreview.preview.resource.serviceTarget?.managedServiceId).toBe(restartedTarget.managedServiceId);
    const copiedTunnel = await previewTunnel(copiedPreview.preview.resource.previewId);
    try { expect(await (await fetch(copiedTunnel.url)).json()).toMatchObject({
        marker: 'first-worktree', pid: afterCliRestartFacts.pid, worktreeUrl: copiedUrl,
    }); } finally { await copiedTunnel.close(); }
    expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(await (await fetch(sibling.url)).json()).toEqual(siblingBefore);
    expect(await present(cliTerminal)).toEqual(retainedMember);
    expect((await presentedWorkspace()).tabs).toMatchObject([{ terminals: [{ id: retainedMember.terminalId,
        target: { terminalId: cliTerminal.terminalId, terminalKey: cliTerminal.terminalKey } }] }]);
});

it('TS.B.preview: the declaration locator follows explicit restart and refuses a stopped service', async () => {
    await admittedControl('preview');
    const { roots, workspaces } = await createWorktrees('preview');
    const initial = await start(workspaces[0]!);
    const initialFacts = await (await fetch(initial.url)).json();
    expect(initialFacts.worktreeUrl, 'The service receives its stable private destination').toEqual(expect.any(String));
    const suppliedUrl = String(initialFacts.worktreeUrl);
    const locator = parseLocalServiceDeclarationPreviewLandingUrlV1(suppliedUrl);
    expect(locator).toEqual({ serverId, machineId, targetId: initial.target.id });
    if (!locator) throw new Error('The supplied worktree URL is not a canonical declaration locator');
    const request = { machineId: locator.machineId, launchTargetId: locator.targetId };
    const opened = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(
        await action('localServices.preview.openOrCreate', request));
    expect(opened.preview.resource).toMatchObject({ machineId, serviceTarget: {
        managedServiceId: initial.result.currentTarget?.managedServiceId,
    } });
    const oldTunnel = await previewTunnel(opened.preview.resource.previewId);
    try {
        expect(await (await fetch(oldTunnel.url)).json()).toMatchObject({ marker: 'first-worktree',
            pid: initialFacts.pid, worktreeUrl: suppliedUrl });
        expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
        if (!initial.result.currentTarget) throw new Error('Preview service lost its control target');
        await stop(initial.result.currentTarget);
        await withOccupiedPort(Number(new URL(initial.url).port), async () => {
            const oldGrant = await fetch(oldTunnel.url).then(async response => ({ status: response.status, body: await response.text() }),
                error => ({ refused: error as unknown }));
            if ('refused' in oldGrant) expect(oldGrant.refused).toBeInstanceOf(TypeError);
            else {
                expect(oldGrant.status).toBeGreaterThanOrEqual(400);
                expect(oldGrant.body).not.toContain('foreign-marker');
            }
            const stopped = await invoke('localServices.preview.openOrCreate', request);
            expect(stopped).toMatchObject({ ok: false, errorCode: 'service_not_listening',
                error: 'local_service_preview_lifecycle_refused:service_not_listening' });
            const oldOccurrence = await invoke('localServices.preview.openOrCreate', {
                machineId, serviceTarget: opened.preview.resource.serviceTarget,
            });
            expect(oldOccurrence).toMatchObject({ ok: false, errorCode: 'service_not_listening',
                error: 'local_service_preview_lifecycle_refused:service_not_listening' });
        });
        const restarted = await start(workspaces[0]!);
        const restartedFacts = await (await fetch(restarted.url)).json();
        expect(restartedFacts.worktreeUrl).toBe(suppliedUrl);
        expect(restartedFacts.pid).not.toBe(initialFacts.pid);
        const reopened = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(
            await action('localServices.preview.openOrCreate', request));
        expect(reopened.preview.resource).toMatchObject({ serviceTarget: {
            managedServiceId: restarted.result.currentTarget?.managedServiceId,
        } });
        const newTunnel = await previewTunnel(reopened.preview.resource.previewId);
        try {
            expect(await (await fetch(newTunnel.url)).json()).toMatchObject({ marker: 'first-worktree',
                pid: restartedFacts.pid, worktreeUrl: suppliedUrl });
            expect((await readFile(resolve(roots[0]!, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
        }
        finally { await newTunnel.close(); }
    } finally { await oldTunnel.close(); }
});
