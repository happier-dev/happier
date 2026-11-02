import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it, onTestFailed } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { formatProcessOwnerTag } from '@/processes/ownerTag';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { isPidPresent } from '@happier-dev/cli-common/process';

it('opens an owner Project and replays native Service Start through the full daemon retention owner without member effects', async () => {
    let phase = 'start_installed_daemon';
    onTestFailed(() => { console.error(`Installed native Project phase: ${phase}`); });
    const h = await startInstalledDaemonFixture({
      onStartupPhase: phase => { console.info('Installed Project daemon startup:', phase); },
      onShutdownPhase: phase => { console.info('Installed Project daemon shutdown:', phase); }, env: {
        HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED: '1',
        HAPPIER_FEATURE_LOCAL_SERVICES_LAUNCHER__ENABLED: '1',
        HAPPIER_FEATURE_LOCAL_SERVICES_ACTIONS__ENABLED: '1',
        HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: '1',
    } });
    phase = 'create_machine_members';
    const members = await Promise.all([h.home.createMachineMember('view'), h.home.createMachineMember('admin'), h.home.createForeignAccount()]);
    const foreign = members[2]!;
    const home = h.home.homeId;
    const nativeLog = join(h.directory, 'original-start-effects.log');
    const nativeProgram = `require('node:fs').appendFileSync(${JSON.stringify(nativeLog)}, ${JSON.stringify('native-owner-service\n')}); setInterval(() => {}, 1000);`;
    await mkdir(join(h.directory, '.happier'));
    await writeFile(join(h.directory, '.happier', 'project.json'), JSON.stringify({ version: 1,
        services: { worker: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(nativeProgram)}` } } } }));
    const openRequest = { serverId: home, machineId: h.machineId,
        source: { kind: 'folder', path: h.directory }, materialization: { kind: 'attach' } };
    const refuse = async (caller: (typeof members)[number], method: string, request: unknown, domainDenial: unknown) => {
        const refusal = await h.invoke(method, request, caller).then(value => ({ kind: 'value' as const, value }), error => ({
            kind: 'error' as const, code: readRpcErrorCode(error), status: readHttpStatus(error),
            name: error instanceof Error ? error.name : null, disposition: readMachineRpcRequestDisposition(error),
        }));
        if (refusal.kind === 'error') {
            // This ungranted Account cannot see the exact Machine at the
            // transport's HTTP target read, before any RPC can be issued.
            expect(refusal).toMatchObject(caller === foreign && refusal.status === 404
                ? { kind: 'error', status: 404, disposition: 'notSent' }
                : { kind: 'error', code: RPC_ERROR_CODES.FORBIDDEN });
            return;
        }
        const nativeDenial = refusal.kind === 'value' && refusal.value !== null && typeof refusal.value === 'object'
            && 'errorCode' in refusal.value && refusal.value.errorCode === 'agent_isolation_unavailable';
        expect(refusal).toEqual({ kind: 'value', value: nativeDenial
            ? { errorCode: 'agent_isolation_unavailable', error: expect.any(String) } : domainDenial });
    };
    try {
        phase = 'execute_confirmed_project_open';
        const input = getActionSpec('projects.open').inputSchema.parse(openRequest);
        const requestId = 'native-confirmed-project-open';
        const marker = { actionId: 'projects.open' as const,
            inputDigest: computeActionInputApprovalDigestV1('projects.open', input), requestId,
            accountId: h.home.accountId, serverId: home, target: { kind: 'machine' as const, machineId: h.machineId } };
        const executor = h.createActionExecutor();
        const deliver = () => executor.execute('projects.open', input, { actionRequestId: requestId,
            // Fresh decoding models a second network delivery, not marker
            // object identity. Home still mints and seals real requester custody.
            presentUserConfirmation: ExternalActionRequesterInvocationV1Schema.parse(JSON.parse(JSON.stringify({
                caller: { kind: 'host' }, surface: 'ui', authority: 'present_user', presentUserConfirmation: marker,
            }))).presentUserConfirmation,
        });
        const first = await deliver();
        expect(first).toMatchObject({ ok: true, result: { kind: 'opened' } });
        if (!first.ok) throw new Error(`Installed confirmed Project Open refused: ${first.errorCode}`);
        const opened = OpenProjectResultV1Schema.parse(first.result);
        const afterFirstOpen = await readProjectAccountRows({ credentials: h.ownerCredentials, serverId: h.serverId,
            selection: { kinds: ['workspace-ref'] } });
        phase = 'rejoin_confirmed_project_open';
        expect(await deliver()).toEqual(first);
        // This reader timestamps each observation; every domain row and
        // revision must remain identical across the repeated delivery.
        expect(await readProjectAccountRows({ credentials: h.ownerCredentials, serverId: h.serverId,
            selection: { kinds: ['workspace-ref'] } })).toEqual({ ...afterFirstOpen, loadedAtMs: expect.any(Number) });
        phase = 'verify_project_receipt';
        const operations = ActionOperationListV1ResponseSchema.parse(await h.invoke(ACTION_OPERATION_RPC_METHODS_V2.list, {}));
        const projectOperations = operations.items.filter(operation => operation.actionId === 'projects.open');
        expect(projectOperations).toMatchObject([{ requestId, state: 'succeeded' }]);
        const receipt = ActionOperationGetV1ResponseSchema.parse(await h.invoke(ACTION_OPERATION_RPC_METHODS_V2.get,
            { operationId: projectOperations[0]!.operationId }));
        expect(receipt).toMatchObject({ kind: 'found', operation: { requestId, state: 'succeeded', result: opened } });
        const changedDirectory = join(h.directory, 'changed-after-review');
        await mkdir(changedDirectory);
        phase = 'reject_changed_project_input';
        expect(await executor.execute('projects.open', { ...input, source: { kind: 'folder', path: changedDirectory } }, {
            actionRequestId: requestId, presentUserConfirmation: { ...marker },
        })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
        phase = 'ordinary_project_approval';
        expect(await executor.execute('projects.open', input, { actionRequestId: 'unconfirmed-project-open' }))
            .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
        expect(await readProjectAccountRows({ credentials: h.ownerCredentials, serverId: h.serverId,
            selection: { kinds: ['workspace-ref'] } })).toEqual({ ...afterFirstOpen, loadedAtMs: expect.any(Number) });
        expect(opened).toMatchObject({ kind: 'opened', directory: h.directory,
            workspace: { serverId: home, machineId: h.machineId, rootPath: h.directory } });
        if (opened.kind !== 'opened') throw new Error('Actual Project acceptance did not settle');
        const workspace = opened.workspace;
        phase = 'review_and_start_native_service';
        if (!workspace.workspaceId) throw new Error('Project acceptance omitted canonical Workspace identity');
        const accepted = await readProjectAccountRows({ credentials: h.ownerCredentials, serverId: h.serverId,
            selection: { kinds: ['workspace-ref'] } });
        expect(accepted.workspaceRefs).toContainEqual(expect.objectContaining({ id: workspace.workspaceId, rootPath: h.directory }));
        for (const member of members) await refuse(member, RPC_METHODS.PROJECTS_OPEN, openRequest, {
            kind: 'refused', code: expect.stringMatching(/^requester_(?:account|authority)_unavailable$/),
        });
        expect(await readProjectAccountRows({ credentials: h.ownerCredentials, serverId: h.serverId,
            selection: { kinds: ['workspace-ref'] } })).toEqual({ ...accepted, loadedAtMs: expect.any(Number) });
        const declaration = { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'worker' } } as const;
        const request = { machineId: h.machineId, workspace, workspaceId: workspace.workspaceId, declaration,
            targetId: createProjectServiceDeclarationTargetIdV1({ id: workspace.workspaceId, serverId: home, machineId: h.machineId }, declaration.selection) };
        const review = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await h.invoke(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            { machineId: h.machineId, workspaceRoot: h.directory, startReview: { request, surface: 'rpc' } })).startReview;
        expect(review).toHaveProperty('reviewedEffectDigest');
        if (!review || 'ok' in review) throw new Error('Actual Service review was refused');
        const method = getActionSpec('localServices.launcher.start').bindings!.rpcMethod!;
        const launch = createTargetedActionRpcRequestV1({ ...request, expectedEffectDigest: review.reviewedEffectDigest },
            { kind: 'machine', machineId: h.machineId });
        for (const member of members) await refuse(member, method, launch, {
            ok: false, errorCode: 'requester_credentials_unavailable', error: 'requester_credentials_unavailable',
        });
        await expect(readFile(nativeLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(h.invoke(method, launch)).resolves.toMatchObject({ status: 'succeeded' });
        await expect.poll(() => readFile(nativeLog, 'utf8')).toBe('native-owner-service\n');
        const listRequest = { serverId: home, machineId: h.machineId, scope: 'happier', view: 'owners' };
        const view = MachineProcessesAnswerV1Schema.parse(await h.invoke(RPC_METHODS.MACHINES_PROCESSES_LIST, listRequest));
        const service = view.owners.find(row => row.owner.kind === 'service' && row.owner.workspaceId === workspace.workspaceId);
        if (!service?.root) throw new Error(`Full daemon did not publish the native Service root: ${JSON.stringify({
            state: view.state, reason: view.reason, unverifiableCount: view.unverifiableCount,
            owners: view.owners.map(row => ({ kind: row.owner.kind,
                workspaceMatches: row.owner.kind === 'service' && row.owner.workspaceId === workspace.workspaceId,
                hasRoot: row.root !== undefined })),
        })}`);
        const root = service.root;
        await expect(h.invoke(RPC_METHODS.MACHINES_PROCESSES_STOP, { serverId: home, machineId: h.machineId,
            targets: [{ ref: root.ref, expect: { level: root.level, owner: service.owner } }] })).resolves.toMatchObject({ status: 'ended' });
        const startAgain = { serverId: home, machineId: h.machineId, ref: root.ref };
        for (const member of members) await refuse(member, RPC_METHODS.MACHINES_PROCESSES_START_AGAIN, startAgain, {
            status: 'refused', reasonCode: 'access_denied',
        });
        expect(await readFile(nativeLog, 'utf8')).toBe('native-owner-service\n');
        await expect(h.invoke(RPC_METHODS.MACHINES_PROCESSES_START_AGAIN, startAgain)).resolves.toMatchObject({ status: 'started' });
        await expect.poll(() => readFile(nativeLog, 'utf8')).toBe('native-owner-service\nnative-owner-service\n');
        const rowsAfter = await readProjectAccountRows({ credentials: h.ownerCredentials, serverId: h.serverId,
            selection: { kinds: ['workspace-ref'] } });
        expect(rowsAfter.workspaceRefs).toEqual(accepted.workspaceRefs);
    } finally { await h.stop(); }
}, 120_000);

it('discloses native Run and registered Service attribution through the installed daemon Home binding', async () => {
    let phase = 'start_installed_daemon';
    onTestFailed(() => { console.error(`Installed Process attribution phase: ${phase}`); });
    const h = await startInstalledDaemonFixture();
    let child: ReturnType<typeof spawnInlineNodeTestProcess> | undefined;
    let stopService: (() => Promise<void>) | undefined;
    try {
        phase = 'wait_for_registered_process_routes';
        await Promise.all([
            h.home.waitForMachineRpc(h.machineId, RPC_METHODS.MACHINES_PROCESSES_LIST),
            h.home.waitForMachineRpc(h.machineId, RPC_METHODS.MACHINES_PROCESSES_STOP),
        ]);
        expect(h.serverId).not.toBe(h.home.homeId);
        const serviceOwner = pluginReloadController.getState().activeRegistry?.projectManagedServices;
        if (!serviceOwner) throw new Error('Installed daemon omitted its admitted Service owner');
        const attribution = { serverId: h.serverId, machineId: h.machineId,
            installationId: h.installation.installationId, accountId: h.home.accountId };
        const workspace = { id: 'installed-process-attribution-workspace', serverId: h.serverId,
            machineId: h.machineId, rootPath: h.directory, createdAtMs: Date.now() };
        phase = 'start_registered_native_service';
        const service = await serviceOwner.superviseProject({ kind: 'workspace', workspace,
            declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'worker' } },
            cwd: h.directory, serviceId: 'installed-process-attribution-service', requester: attribution,
            specIdentity: 'installed-process-attribution-launch', isCurrent: () => true,
            processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
            authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {},
                projectLaunch: { status: 'ready', reviewedEffectDigest: 'installed-process-attribution-launch',
                    toolchain: { selection: { kind: 'host' }, root: h.directory, platform: process.platform,
                        io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }) } },
                launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: h.directory,
                    env: {}, release() {} } }),
        });
        stopService = async () => { await service.stop(); };
        const serviceTarget = serviceOwner.readResourceTargets().find(target => target.root.owner.kind === 'service'
            && target.root.owner.serviceId === service.instanceId);
        if (!serviceTarget) throw new Error('Registered Service omitted its native Process target');
        const servicePid = serviceTarget.root.pid;
        expect(serviceTarget.root.requesterWorkAttributionV1).toEqual(attribution);
        phase = 'start_native_run';
        const runId = 'installed-process-attribution-run';
        child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)', { env: { ...process.env,
            HAPPIER_PROCESS_OWNER: formatProcessOwnerTag({ happierHomeDir: h.homeDirectory, owner: { kind: 'run', runId } }),
        } });
        await once(child, 'spawn');
        if (!child.pid) throw new Error('Native Run fixture did not start');
        await writeExecutionRunMarker({ pid: child.pid, runId, happySessionId: null, callId: 'call', sidechainId: 'side',
            intent: 'review', backendTarget: { kind: 'backend', backendId: 'fixture' }, status: 'running',
            startedAtMs: Date.now(), updatedAtMs: Date.now(), requesterWorkAttributionV1: attribution });
        const listRequest = { serverId: h.home.homeId, machineId: h.machineId, scope: 'happier', view: 'owners' };
        phase = 'actual_installed_process_disclosure';
        const view = MachineProcessesAnswerV1Schema.parse(await h.invoke(RPC_METHODS.MACHINES_PROCESSES_LIST, listRequest));
        expect(view.state).toBe('live');
        const runRow = view.owners.find(row => row.owner.kind === 'run' && row.owner.runId === runId);
        expect(runRow, 'Installed Process consumer must disclose its canonical Home-stamped Run').toBeDefined();
        const serviceRow = view.owners.find(row => row.owner.kind === 'service' && row.owner.serviceId === service.instanceId);
        if (!serviceRow?.root) throw new Error('Installed Process consumer did not disclose its registered Service root');
        const stopRequest = { serverId: h.home.homeId, machineId: h.machineId,
            targets: [{ ref: serviceRow.root.ref, expect: { level: serviceRow.root.level, owner: serviceRow.owner } }] };
        phase = 'member_and_foreign_process_refusals';
        for (const caller of [await h.home.createMachineMember('view'), await h.home.createMachineMember('admin'),
            await h.home.createForeignAccount()]) {
            const disclosed = await h.invoke(RPC_METHODS.MACHINES_PROCESSES_LIST, listRequest, caller)
                .then(value => ({ kind: 'value' as const, value: MachineProcessesAnswerV1Schema.parse(value) }), error => ({
                    kind: 'error' as const, code: readRpcErrorCode(error), status: readHttpStatus(error),
                }));
            if (disclosed.kind === 'value') {
                expect(disclosed.value.owners.some(row => row.owner.kind === 'run' && row.owner.runId === runId
                    || row.owner.kind === 'service' && row.owner.serviceId === service.instanceId)).toBe(false);
            } else expect(disclosed.code === RPC_ERROR_CODES.FORBIDDEN || disclosed.status === 404).toBe(true);
            const stopped = await h.invoke(RPC_METHODS.MACHINES_PROCESSES_STOP, stopRequest, caller)
                .then(value => ({ kind: 'value' as const, value }), error => ({
                    kind: 'error' as const, code: readRpcErrorCode(error), status: readHttpStatus(error),
                }));
            if (stopped.kind === 'value') expect(stopped.value).toMatchObject({ status: 'refused' });
            else expect(stopped.code === RPC_ERROR_CODES.FORBIDDEN || stopped.status === 404).toBe(true);
            expect(service.snapshot().state).toBe('running');
        }
        phase = 'owner_native_service_stop';
        expect(await h.invoke(RPC_METHODS.MACHINES_PROCESSES_STOP, stopRequest)).toMatchObject({ status: 'ended' });
        expect(service.snapshot().state).toBe('stopped');
        await expect.poll(() => isPidPresent(servicePid)).toBe(false);
        expect(serviceOwner.readResourceTargets().some(target => target.root.pid === servicePid)).toBe(false);
    } finally {
        try { await stopService?.(); }
        finally {
            try {
                if (child && child.exitCode === null && child.signalCode === null) {
                    const exited = once(child, 'exit');
                    child.kill('SIGKILL');
                    await exited;
                }
            } finally { await h.stop(); }
        }
    }
}, 120_000);
