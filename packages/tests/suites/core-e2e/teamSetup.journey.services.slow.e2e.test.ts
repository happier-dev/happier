import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { parseLocalServiceDeclarationPreviewLandingUrlV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipCreateResultV1Schema,
  WorkspaceSyncRelationshipsListActionOutputV1Schema } from '@happier-dev/protocol';
import { createProjectServiceDeclarationTargetIdV1, type LocalServiceManagedServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceLauncherStartResponseV1Schema, DaemonLocalServiceLauncherSnapshotResponseV1Schema,
  LocalServiceStartApprovalReviewV1Schema, isLocalServiceStateRunningV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { ProjectServicePlacementGetResultV1Schema, ProjectServicePlacementMutationResultV1Schema } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { ProjectWorkerCopyInspectResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectServiceRelocateResultV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { waitFor } from '../../src/testkit/timing';

let fixture: ProjectDaemonFixture | undefined;
let account: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
const running = new Map<string, LocalServiceManagedServiceActionTargetV1>();
const lockedDirectories: string[] = [];

async function action(id: ActionId, input: unknown): Promise<unknown> {
  const result = await account.executeAsPerson(id, input);
  expect(result, `${id} must succeed as the signed-in person`).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`${id}: ${result.errorCode}`);
  return result.result;
}

afterAll(async () => {
  const failures: unknown[] = [];
  for (const directory of lockedDirectories) await chmod(directory, 0o755);
  for (const target of running.values()) {
    try { await action('localServices.actions.stopManaged', { requestId: randomUUID(), target, action: 'stop_managed' }); }
    catch (error) { failures.push(error); }
  }
  await fixture?.stop();
  if (failures.length) throw new AggregateError(failures, 'Service journey cleanup failed');
}, 0);

it.skipIf(process.platform === 'win32')('TS.J.services: copied worker Python Start, changed-script review, address and Stop', async () => {
  const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
  if (!databaseUrl) throw new Error('Service journey requires the disposable PostgreSQL harness');
  const testDir = await mkdtemp(join(tmpdir(), 'team-journey-services-'));
  fixture = await startProjectDaemonFixture({ testDir, serverEnv: { DATABASE_URL: databaseUrl,
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1' } });
  account = await fixture.createAccount('service-owner');
  const source = await fixture.enrollDaemon(account);
  const worker = await fixture.enrollDaemon({ ...account, name: 'service-worker' });
  const root = join(source.workspaceDir, 'python-project');
  const targetRoot = join(worker.workspaceDir, 'python-copy');
  await initGitRepo({ repoDir: root });
  await mkdir(join(root, '.happier'), { recursive: true });
  await mkdir(join(root, '.venv/bin'), { recursive: true });
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const interpreter = (label: string) => `#!/bin/sh\n# ${label} Machine interpreter\nexec '${python.replaceAll("'", "'\\''")}' "$@"\n`;
  const sourcePython = join(source.workspaceDir, 'machine-python');
  await writeFile(sourcePython, interpreter('SOURCE'), { mode: 0o755 });
  await symlink(sourcePython, join(root, '.venv/bin/python'));
  await writeFile(join(root, '.gitignore'), '.venv/\nlocked/\n');
  const script = (marker: string) => `import http.server, os\nclass Handler(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.send_header('X-Process-Port', os.environ['PORT']); self.send_header('X-Worktree-Port', os.environ['HAPPIER_WORKTREE_PORT']); self.send_header('X-Worktree-Url', os.environ['HAPPIER_WORKTREE_URL']); self.end_headers(); self.wfile.write(b'${marker}')\nhttp.server.HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()\n`;
  await writeFile(join(root, 'server.py'), script('first-worker'));
  await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
    worktreePorts: { enabled: true, slots: 1 }, services: { web: { execution: 'portable',
      source: { kind: 'command', command: '.venv/bin/python server.py || sh locked/fallback.sh' },
      runtime: { primary: true, portSlot: 0 } } } }));
  execGit(root, ['add', '.']);
  execGit(root, ['commit', '-m', 'test: portable Python Service fixture']);
  const opened = OpenProjectResultV1Schema.parse(await action('projects.open', { ...source.target,
    source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }));
  if (opened.kind !== 'opened') throw new Error(`Source open: ${opened.kind}`);
  const workspace = opened.workspace;
  const address = { serverId: fixture.serverId, refId: workspace.workspaceId };
  const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const copy = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await action('workspace.sync.relationship.create', {
    v: 1, sourceWorkspaceRefId: workspace.workspaceId, targetMachineId: worker.target.machineId,
    targetPath: targetRoot, mode: 'keep_synced', destinationIntent: 'materialize_from_source_workspace',
    purpose: 'worker_clean_copy', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
  }));
  expect(copy.created).toBe(true);
  expect(await readFile(join(targetRoot, 'server.py'), 'utf8')).toBe(script('first-worker'));
  await mkdir(join(targetRoot, '.venv/bin'), { recursive: true });
  const workerPython = join(worker.workspaceDir, 'machine-python');
  await writeFile(workerPython, interpreter('WORKER'), { mode: 0o755 });
  await symlink(workerPython, join(targetRoot, '.venv/bin/python'));
  // bfec9da58e0: only SOURCE owns executed-file review. Reading this worker-only
  // fallback again fails, although the first command is valid and never uses it.
  const locked = join(targetRoot, 'locked');
  await mkdir(locked);
  await writeFile(join(locked, 'fallback.sh'), 'exit 1\n');
  await chmod(locked, 0o000);
  lockedDirectories.push(locked);

  const placementRead = ProjectServicePlacementGetResultV1Schema.parse(await action('projects.service.placement.get', { workspace: address, serviceName: 'web' }));
  expect(placementRead.status).toBe('ready');
  if (placementRead.status !== 'ready') throw new Error('Placement unavailable');
  const placement = { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: worker.target.machineId } }, unavailable: 'fail' as const };
  expect(ProjectServicePlacementMutationResultV1Schema.parse(await action('projects.service.placement.set', {
    workspace: address, serviceName: 'web', expectedRevision: placementRead.revision,
    expected: { kind: 'absent' }, value: placement,
  })).status).toBe('applied');
  expect(await action('projects.service.placement.get', { workspace: address, serviceName: 'web' })).toMatchObject({ placement });

  const selection = { kind: 'manifest' as const, name: 'web' };
  const request = { machineId: source.target.machineId, workspace,
    targetId: createProjectServiceDeclarationTargetIdV1({ serverId: workspace.serverId, machineId: workspace.machineId, id: workspace.workspaceId }, selection),
    declaration: { workspaceRefId: workspace.workspaceId, selection } };
  const review = async () => {
    const snapshot = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await action('localServices.launcher.snapshot', {
      machineId: source.target.machineId, workspaceRoot: root, startReview: { request, surface: 'ui' },
    }));
    return LocalServiceStartApprovalReviewV1Schema.parse(snapshot.startReview);
  };
  const firstReview = await review();
  const start = async (expectedEffectDigest: string, marker: string) => {
    const started = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action('localServices.launcher.start', { ...request, expectedEffectDigest }));
    if (started.currentTarget) running.set(started.currentTarget.managedServiceId, started.currentTarget);
    expect(started, 'Portable copied Service must start with its Machine-local interpreter').toMatchObject({ status: 'succeeded', machineId: worker.target.machineId });
    const target = started.snapshot.targets.find(value => value.source === 'managed_service');
    expect(target?.endpointUrl).toEqual(expect.any(String));
    if (!target?.endpointUrl || !started.currentTarget) throw new Error('Started Service omitted its address/control target');
    const url = target.endpointUrl;
    await waitFor(async () => (await fetch(url)).status === 200, { context: 'worker Service healthy address' });
    const response = await fetch(url);
    expect(response.headers.get('X-Process-Port')).toBe(new URL(url).port);
    expect(response.headers.get('X-Worktree-Port')).toBe(new URL(url).port);
    expect(parseLocalServiceDeclarationPreviewLandingUrlV1(response.headers.get('X-Worktree-Url') ?? '')).toEqual({
      serverId: fixture!.serverId, machineId: worker.target.machineId, targetId: target.id,
    });
    expect(target.portSource).toBe('assigned');
    expect(started.snapshot.worktreePorts).toMatchObject({ rootPath: targetRoot,
      result: { kind: 'ready', assignment: { ports: [Number(new URL(url).port)] } } });
    expect(await response.text()).toBe(marker);
    await action('localServices.actions.stopManaged', { requestId: randomUUID(), target: started.currentTarget, action: 'stop_managed' });
    running.delete(started.currentTarget.managedServiceId);
    await waitFor(async () => { try { await fetch(url); return false; } catch { return true; } }, { context: 'stopped worker Service endpoint retired' });
  };
  await start(firstReview.reviewedEffectDigest, 'first-worker');
  await writeFile(join(root, 'server.py'), script('edited-worker'));
  const editedReview = await review();
  expect(editedReview.reviewedEffectDigest, 'Editing a copied script must re-prompt review').not.toBe(firstReview.reviewedEffectDigest);
  expect(DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action('localServices.launcher.start', {
    ...request, expectedEffectDigest: firstReview.reviewedEffectDigest,
  }))).toMatchObject({ status: 'failed', reasonCode: 'project_service_effect_changed' });
  await start(editedReview.reviewedEffectDigest, 'edited-worker');
  // Move starts with a real primary occurrence, then uses the same prepared copy.
  const primary = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action('localServices.launcher.start', {
    ...request, choice: { kind: 'primary' },
  }));
  if (primary.currentTarget) running.set(primary.currentTarget.managedServiceId, primary.currentTarget);
  expect(primary).toMatchObject({ status: 'succeeded', machineId: source.target.machineId });
  if (!primary.currentTarget) throw new Error('Primary Service omitted its control target');
  const currentPlacement = ProjectServicePlacementGetResultV1Schema.parse(await action('projects.service.placement.get', {
    workspace: address, serviceName: 'web',
  }));
  if (currentPlacement.status !== 'ready') throw new Error('Move placement unavailable');
  const move = ProjectServiceRelocateResultV1Schema.parse(await action('projects.service.relocate', {
    workspace: address, serviceName: 'web', requestId: randomUUID(), sourceMachineId: source.target.machineId,
    currentTarget: primary.currentTarget, selectedTarget: { machineId: worker.target.machineId }, destination: placement.runsOn,
    desiredPlacement: { workspace: address, serviceName: 'web', expectedRevision: currentPlacement.revision,
      expected: { kind: 'value', value: placement }, value: placement },
  }));
  expect(move).toMatchObject({ status: 'accepted' });
  if (move.status !== 'accepted') throw new Error(`Move did not start: ${move.status}`);
  const moved = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
    operationId: move.operation.operationId, waitForTerminal: true,
  }));
  expect(moved).toMatchObject({ kind: 'found', operation: { state: 'succeeded', domainRef: {
    kind: 'projectService', currentTarget: { machineId: worker.target.machineId },
  } } });
  if (moved.kind !== 'found' || moved.operation.domainRef?.kind !== 'projectService'
    || !moved.operation.domainRef.currentTarget) throw new Error('Moved Service omitted its new control target');
  running.delete(primary.currentTarget.managedServiceId);
  const movedTarget = moved.operation.domainRef.currentTarget;
  running.set(movedTarget.managedServiceId, movedTarget);
  const movedSnapshot = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await action('localServices.launcher.snapshot', {
    machineId: worker.target.machineId, workspaceRoot: targetRoot, projection: 'managed_bindings',
  }));
  const sourceAfterMove = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await action('localServices.launcher.snapshot', {
    machineId: source.target.machineId, workspaceRoot: root, projection: 'managed_bindings',
  }));
  expect(sourceAfterMove.snapshot.targets.filter(value => isLocalServiceStateRunningV1(value.serviceState)),
    'Move must stop the incumbent before replacing it on the worker').toHaveLength(0);
  const liveReplacement = movedSnapshot.snapshot.targets.filter(value => isLocalServiceStateRunningV1(value.serviceState));
  expect(liveReplacement, 'Move must leave exactly one live replacement').toHaveLength(1);
  expect(liveReplacement[0]?.sourceClass).toMatchObject({ kind: 'managed_service', managedServiceId: movedTarget.managedServiceId });
  const movedUrl = movedSnapshot.snapshot.targets.find(value => value.sourceClass?.kind === 'managed_service'
    && value.sourceClass.managedServiceId === movedTarget.managedServiceId)?.endpointUrl;
  if (!movedUrl) throw new Error('Moved Service omitted its address');
  await waitFor(async () => (await fetch(movedUrl)).status === 200, { context: 'moved Service healthy address' });
  expect(await (await fetch(movedUrl)).text()).toBe('edited-worker');
  await action('localServices.actions.stopManaged', { requestId: randomUUID(), target: movedTarget, action: 'stop_managed' });
  running.delete(movedTarget.managedServiceId);
  await chmod(locked, 0o755);
  const relationships = WorkspaceSyncRelationshipsListActionOutputV1Schema.parse(await action('workspace.sync.relationships.list', { controllerMachineId: copy.controllerMachineId }));
  const relationship = relationships.relationships.find(value => value.definition.relationshipId === copy.relationshipId)?.definition;
  if (!relationship) throw new Error('Committed worker copy missing');
  const inspect = { workspace: address, machineId: copy.controllerMachineId, expectedRelationship: relationship,
    kind: 'preview' as const, targetMachineId: worker.target.machineId, targetWorkspaceRefId: copy.targetWorkspaceRefId };
  expect(ProjectWorkerCopyInspectResultV1Schema.parse(await action('projects.worker.copy.inspect', inspect))).toMatchObject({ ok: true });
  expect(ProjectWorkerCopyInspectResultV1Schema.parse(await action('projects.worker.copy.inspect', {
    ...inspect, expectedRelationship: { ...relationship, relationshipId: randomUUID() },
  }))).toMatchObject({ ok: false, errorCode: 'workspace_copy_not_owned' });
}, 180_000);
