import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import { requiredWorkspaceSyncRealBinaryEnvironment } from '../../apps/cli/scripts/runWorkspaceSyncRealIntegration.mjs';
import { withoutV03GateSkip } from './testsWorkflowTestkit.mjs';

const repoRoot = new URL('../..', import.meta.url).pathname;

function readWorkflowText(name) {
  return readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

function loadWorkflow(name) {
  return YAML.parse(readWorkflowText(name), { prettyErrors: true });
}

function workspaceSyncRealJob() {
  const job = loadWorkflow('tests.yml').jobs['workspace-sync-real'];
  assert.ok(job, 'tests.yml must own the real workspace-sync CI lane');
  return job;
}

function stepNamed(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `the real workspace-sync lane must keep its "${name}" step`);
  return step;
}

const GATED_ON_SELECTION = "inputs.select_jobs_explicitly || steps.changes.outputs.workspace_sync_real == 'true'";
const GATED_ON_NON_SELECTION = "${{ !inputs.select_jobs_explicitly && steps.changes.outputs.workspace_sync_real != 'true' }}";

test('the real workspace-sync lane invokes the canonical runner exactly once', () => {
  const job = workspaceSyncRealJob();
  assert.equal(job.name, 'Workspace sync (Mutagen + Iroh real)');
  assert.deepEqual(job.needs, ['trusted_ref_guard']);

  const invocations = job.steps.filter((step) => String(step.run ?? '').includes('test:workspace-sync:real'));
  assert.equal(invocations.length, 1, 'exactly one step may invoke the canonical real workspace-sync runner');
  assert.equal(invocations[0].run.trim(), 'pnpm run test:workspace-sync:real');

  assert.equal(
    job.steps.some((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@')),
    false,
    'the real workspace-sync lane must not upload broad logs that can retain credentials',
  );

  const rootScripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
  assert.equal(rootScripts['test:workspace-sync:real'], 'pnpm --filter @happier-dev/cli run test:workspace-sync:real');
  const cliScripts = JSON.parse(readFileSync(join(repoRoot, 'apps/cli/package.json'), 'utf8')).scripts;
  assert.match(cliScripts['test:workspace-sync:real'], /hstack-exec .*--script=test:workspace-sync:real:local/u);
  assert.match(cliScripts['test:workspace-sync:real:local'], /runWorkspaceSyncRealIntegration\.mjs/u);
});

test('the required lane also proves the production signed release-acquisition path', () => {
  const job = workspaceSyncRealJob();
  const acquisition = stepNamed(job, 'Acquire the pinned engine from the external signed Mutagen release');

  // The lane reuses the canonical opt-in live acquisition test rather than a copied
  // downloader or a fake artifact, and spells the invocation exactly as the release
  // gate does so the two required owners cannot drift into two commands.
  assert.equal(
    acquisition.run.trim(),
    'set -euo pipefail\npnpm --filter @happier-dev/cli-common run test:mutagen-engine:live',
  );
  assert.equal(acquisition.env.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION, '1');
  // Public verification only: the automatic workflow token plus the built-in Happier
  // Minisign trust root. A repository secret here would be an unapproved topology.
  assert.equal(acquisition.env.GITHUB_TOKEN, '${{ github.token }}');
  assert.deepEqual(Object.keys(acquisition.env).sort(), ['GITHUB_TOKEN', 'HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION']);
  assert.doesNotMatch(JSON.stringify(acquisition), /secrets\./u);
  assert.equal(job.permissions?.contents, 'read');

  // Exactly one lane in ordinary CI opts into the live acquisition, and it is this one.
  const tests = loadWorkflow('tests.yml');
  const optedIn = Object.entries(tests.jobs).filter(([, candidate]) =>
    (candidate.steps ?? []).some((step) => JSON.stringify(step ?? {}).includes('HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION')),
  );
  assert.deepEqual(optedIn.map(([id]) => id), ['workspace-sync-real']);

  // Source-built binaries and the released artifact prove different boundaries; the
  // one required job keeps both. Neither may replace the other.
  assert.ok(
    job.steps.some((step) => String(step.run ?? '').includes('cmd/mutagen-sidecar')),
    'the released artifact check must not displace the source-built broker/carrier integration',
  );
  assert.ok(job.steps.some((step) => String(step.run ?? '').trim() === 'pnpm run test:workspace-sync:real'));
  assert.doesNotMatch(acquisition.run, /go build|gh release download/u);

  // Ordinary unit lanes stay offline: the live test is inert unless explicitly opted in.
  const liveTest = readFileSync(
    join(repoRoot, 'packages/cli-common/src/firstPartyRuntime/mutagenEngineAcquisition.live.test.ts'),
    'utf8',
  );
  assert.match(liveTest, /const liveAcquisitionEnabled = process\.env\.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION\?\.trim\(\) === '1'/u);
  assert.match(liveTest, /describe\.skipIf\(!liveAcquisitionEnabled\)/u);
  const rootScripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
  for (const [name, script] of Object.entries(rootScripts)) {
    if (!name.startsWith('test:')) continue;
    assert.doesNotMatch(
      String(script),
      /HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION/u,
      `root script ${name} must not enable the live network acquisition`,
    );
  }
  const cliCommonScripts = JSON.parse(readFileSync(join(repoRoot, 'packages/cli-common/package.json'), 'utf8')).scripts;
  assert.match(cliCommonScripts['test:mutagen-engine:live'], /hstack-exec .*--script=test:mutagen-engine:live:local/u);
  assert.equal(
    cliCommonScripts['test:mutagen-engine:live:local'],
    'node scripts/runMutagenEngineLiveTest.mjs',
    'the package-owned launcher must set the opt-in portably after hstack dispatch',
  );
  const liveLauncher = readFileSync(
    join(repoRoot, 'packages/cli-common/scripts/runMutagenEngineLiveTest.mjs'),
    'utf8',
  );
  assert.match(liveLauncher, /HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION:\s*'1'/u);
  assert.match(liveLauncher, /mutagenEngineAcquisition\.live\.test\.ts/u);
  assert.match(liveLauncher, /process\.execPath/u);
  assert.match(liveLauncher, /stdio:\s*'inherit'/u);
  assert.match(liveLauncher, /process\.kill\(process\.pid, signal\)/u);
});


test('the real workspace-sync lane supplies every executable input the canonical runner requires', () => {
  const job = workspaceSyncRealJob();
  const buildMutagen = stepNamed(job, 'Build source Mutagen prerequisites');
  const testMutagen = stepNamed(job, 'Run pinned Mutagen fork tests');
  const setupCustodyGo = stepNamed(job, 'Setup process-custody Go toolchain');
  const buildCustody = stepNamed(job, 'Build process-custody helper');

  assert.equal(requiredWorkspaceSyncRealBinaryEnvironment.length, 4);
  for (const name of requiredWorkspaceSyncRealBinaryEnvironment.filter((name) => name !== 'HAPPIER_PROCESS_CUSTODY_LIVE_BIN')) {
    assert.match(
      buildMutagen.run,
      new RegExp(`echo "${name}=\\$\\{[a-z_]+_bin\\}"`, 'u'),
      `the lane must export ${name} for the canonical runner`,
    );
  }
  assert.match(buildCustody.run, /echo "HAPPIER_PROCESS_CUSTODY_LIVE_BIN=\$\{custody_bin\}"/u);

  // Each executable comes from a source build; the lane must not pin or download a release asset.
  assert.match(buildMutagen.run, /go build -trimpath -tags "\$\{MUTAGEN_MANAGER_TAGS\}" -o "\$\{manager_bin\}" \.\/cmd\/mutagen-sidecar/u);
  assert.match(buildMutagen.run, /go build -trimpath -tags "\$\{MUTAGEN_AGENT_TAGS\}" -o "\$\{agent_bin\}" \.\/cmd\/mutagen-agent/u);
  assert.match(buildMutagen.run, /go build -trimpath -tags integration -o "\$\{broker_bin\}" \.\/pkg\/externalbroker\/integrationclient/u);
  assert.match(buildMutagen.run, /echo "HAPPIER_MUTAGEN_SOURCE_DIR=\$\{mutagen_source\}"/u);
  assert.doesNotMatch(buildMutagen.run, /apps\/cli\/native\/processcustody/u);
  assert.match(buildCustody.run, /cd apps\/cli\/native\/processcustody/u);
  assert.match(buildCustody.run, /go test \.\/\.\.\./u);
  assert.match(buildCustody.run, /go build -trimpath -o "\$\{custody_bin\}" \./u);
  assert.match(buildCustody.run, /go env GOVERSION/u);
  assert.doesNotMatch(`${buildMutagen.run}\n${buildCustody.run}`, /gh release download|releases\/download/u);

  const policy = stepNamed(job, 'Resolve Mutagen source policy');
  assert.equal(policy.id, 'mutagen_policy');
  assert.match(policy.run, /packages\/cli-common\/mutagen-engine\.json/u);
  assert.equal(buildMutagen.env.MUTAGEN_REMOTE, '${{ steps.mutagen_policy.outputs.remote }}');
  assert.equal(buildMutagen.env.MUTAGEN_COMMIT, '${{ steps.mutagen_policy.outputs.commit }}');
  assert.equal(buildMutagen.env.MUTAGEN_MANAGER_TAGS, '${{ steps.mutagen_policy.outputs.manager_tags }}');
  assert.equal(buildMutagen.env.MUTAGEN_AGENT_TAGS, '${{ steps.mutagen_policy.outputs.agent_tags }}');
  assert.equal(buildMutagen.env.MUTAGEN_GO_VERSION, '${{ steps.mutagen_policy.outputs.go_version }}');

  const installGo = stepNamed(job, 'Install checksum-pinned Go toolchain');
  assert.equal(installGo.env.GO_VERSION, '${{ steps.mutagen_policy.outputs.go_version }}');
  assert.equal(installGo.env.GO_DISTRIBUTION_URL, '${{ steps.mutagen_policy.outputs.go_distribution_url }}');
  assert.equal(installGo.env.GO_DISTRIBUTION_SHA256, '${{ steps.mutagen_policy.outputs.go_distribution_sha256 }}');
  assert.match(installGo.run, /go\$\{GO_VERSION\}\.linux-amd64\.tar\.gz/u);
  assert.match(installGo.run, /sha256sum --check --strict/u);
  assert.match(installGo.run, /GITHUB_PATH/u);
  assert.doesNotMatch(installGo.run, /GITHUB_ENV|GOROOT/u, 'the fork toolchain must not leak into the separately owned process-custody build');
  assert.match(buildMutagen.run, /test "\$\(go env GOVERSION\)" = "go\$\{MUTAGEN_GO_VERSION\}"/u);

  assert.ok(job.steps.indexOf(testMutagen) > job.steps.indexOf(buildMutagen));
  assert.ok(job.steps.indexOf(testMutagen) < job.steps.indexOf(stepNamed(job, 'Run real workspace sync over Mutagen and Iroh')));
  assert.equal(testMutagen.env.MUTAGEN_COMMIT, '${{ steps.mutagen_policy.outputs.commit }}');
  assert.equal(testMutagen.env.MUTAGEN_MANAGER_TAGS, '${{ steps.mutagen_policy.outputs.manager_tags }}');
  assert.equal(testMutagen.env.MUTAGEN_AGENT_TAGS, '${{ steps.mutagen_policy.outputs.agent_tags }}');
  assert.match(testMutagen.run, /cd "\$\{HAPPIER_MUTAGEN_SOURCE_DIR\}"/u);
  assert.match(testMutagen.run, /test "\$\(git rev-parse HEAD\)" = "\$\{MUTAGEN_COMMIT\}"/u);
  // `pkg/agent` extracts the platform agent from `<source>/build/mutagen-agents.tar.gz`,
  // so the fork's own `scripts/ci/test.sh` performs a local build before the broad
  // `./pkg/...` run. Without it the pinned suite fails on a missing bundle rather than
  // on engine behavior, which would make this gate red for an environment reason.
  assert.match(testMutagen.run, /go run scripts\/build\.go --mode=local --sspl/u);
  assert.ok(
    testMutagen.run.indexOf('go run scripts/build.go --mode=local --sspl')
      < testMutagen.run.indexOf('go test -tags mutagensspl -p 1 ./pkg/...'),
    'the agent bundle must exist before the broad pinned-fork package run',
  );
  assert.match(testMutagen.run, /go test -tags mutagensspl -p 1 \.\/pkg\/\.\.\./u);
  assert.match(testMutagen.run, /go test -tags "\$\{MUTAGEN_MANAGER_TAGS\}" -p 1 \.\/cmd\/mutagen-sidecar/u);
  assert.match(testMutagen.run, /go test -tags "\$\{MUTAGEN_AGENT_TAGS\}" -p 1 \.\/cmd\/mutagen-agent/u);

  assert.equal(setupCustodyGo.uses, 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16');
  assert.equal(setupCustodyGo.with['go-version-file'], 'apps/cli/native/processcustody/go.mod');
  assert.equal(setupCustodyGo.with['cache-dependency-path'], 'apps/cli/native/processcustody/go.sum');
  assert.ok(
    job.steps.indexOf(setupCustodyGo) > job.steps.indexOf(buildMutagen),
    'the process-custody toolchain must not replace the checksum-pinned Mutagen toolchain before the fork build',
  );

  assert.match(policy.run, /policy\.toolchain\.distributionSha256\?\.\['linux-amd64'\]/u);
  assert.match(policy.run, /\^\[0-9a-f\]\{64\}\$/u);
  assert.match(policy.run, /goDistributionUrl\.protocol !== 'https:'/u);
  assert.match(policy.run, /go_distribution_url/u);
  assert.match(policy.run, /go_distribution_sha256/u);
});



test('the real workspace-sync lane selects itself from Lane 08 change surfaces', () => {
  const job = workspaceSyncRealJob();
  assert.equal(withoutV03GateSkip(job.if), '${{ !inputs.select_jobs_explicitly || inputs.run_workspace_sync_real || inputs.run_workspace_sync_performance }}');

  const changes = stepNamed(job, 'Detect workspace sync-relevant changes');
  assert.equal(changes.id, 'changes');
  assert.equal(changes.if, '${{ !inputs.select_jobs_explicitly }}');
  // Third-party actions in a required lane are pinned to an immutable commit, like every
  // other action this job uses. `0e4a8c6` is the commit the annotated `v3` tag dereferences
  // to (dorny/paths-filter v3.0.4).
  assert.equal(changes.uses, 'dorny/paths-filter@0e4a8c6effa4802afeda77dc8d303f8176d7dfad');
  const filters = YAML.parse(changes.with.filters).workspace_sync_real;
  for (const path of [
    // Subjects of the three real specs the canonical runner executes.
    'apps/cli/src/workspaces/**',
    // The real runtime is composed by startDaemon, passed into ApiMachine, and
    // exposed through the bounded workspace-sync RPC service. A change at any
    // one of those production roots can disconnect otherwise-green owners.
    'apps/cli/src/daemon/startDaemon.ts',
    'apps/cli/src/daemon/startDaemon.handoff.integration.test.ts',
    'apps/cli/src/daemon/startup/**',
    'apps/cli/src/daemon/peer/**',
    // Direct root-ownership dependencies of the composed daemon workspace-sync
    // runtime: createProductionDaemonWorkspaceSyncRuntime resolves the sync-root
    // ownership directory itself, and workspaceSyncRootOwnership real-path
    // resolves and takes its owner lock through these owners.
    'apps/cli/src/configuration/resolveWorkspaceSyncRootOwnershipDirectory.ts',
    'apps/cli/src/configuration/resolveWorkspaceSyncRootOwnershipDirectory.test.ts',
    'apps/cli/src/utils/fs/jsonOwnerFileLock.ts',
    'apps/cli/src/utils/fs/jsonOwnerFileLock.test.ts',
    'apps/cli/src/utils/fs/writeJsonAtomic.ts',
    'apps/cli/src/utils/fs/writeJsonAtomic.test.ts',
    'apps/cli/src/utils/path/physicalAncestorPath.ts',
    'apps/cli/src/daemon/processIdentity.ts',
    'apps/cli/src/daemon/processIdentity.test.ts',
    'apps/cli/src/api/apiMachine.ts',
    'apps/cli/src/api/machine/rpcHandlers.ts',
    'apps/cli/src/api/machine/rpcHandlers.workspaceSync*',
    'apps/cli/src/api/machine/sessionHandoff/**',
    'apps/cli/src/session/handoff/**',
    // The loaded-daemon proof enters through the production external Action
    // boundary. Keep these exact so unrelated external Actions do not force a
    // source-built Mutagen/Iroh lane.
    'apps/cli/src/daemon/externalActions/executeExternalAction.ts',
    'apps/cli/src/daemon/externalActions/executeExternalAction.test.ts',
    // The carrier spec drives createTrackedSessionHandoffCoordinator directly.
    // Bounded to the session-handoff files; actionOperations at large is not Lane 08.
    'apps/cli/src/daemon/actionOperations/sessionHandoff*',
    'apps/cli/src/daemon/actionOperations/*SessionHandoff*',
    // Workspace transfer/export the handoff resolves, plus the git backend that
    // implements it. scm-git is reached through the SCM registry at runtime, so
    // no static import from the CLI ever names it.
    'apps/cli/src/scm/workspace/**',
    'apps/cli/src/scm/registry.ts',
    'apps/cli/src/scm/runtime.ts',
    'apps/cli/src/scm/runtime*.test.ts',
    'packages/plugins/scm-git/src/workspace/**',
    'packages/plugins/scm-git/src/workspaceIntegration.ts',
    'packages/plugins/scm-git/src/workspaceTransferMetadata.ts',
    'packages/plugins/scm-git/src/types.ts',
    'packages/plugins/scm-git/src/runtime.ts',
    'packages/plugins/scm-git/src/checkoutIdentity.ts',
    'packages/plugins/scm-git/src/worktreeListParser.ts',
    'packages/plugins/scm-git/src/providers/shared/nonInteractiveEnv.ts',
    'packages/plugins/scm-git/src/operations/materializeGitWorkspaceCheckout*',
    'packages/plugins/scm-git/src/operations/reconcileWorkspaceCheckout*',
    'packages/plugins/scm-git/src/operations/resolveGitWorkspaceTransferEntries*',
    'packages/plugins/scm-git/src/operations/repairGitWorktreeAdminReference*',
    'packages/plugins/scm-git/src/operations/worktreeName*',
    'packages/plugins/scm-git/src/backend.ts',
    'packages/plugins/scm-git/.happier-plugin/**',
    // Relationship materialization and mutation use these existing settings
    // owners rather than a Lane-08-local store.
    'apps/cli/src/settings/accountSettings/activeAccountSettingsSnapshot.ts',
    'apps/cli/src/settings/accountSettings/refreshAccountSettingsForMinimumVersion.ts',
    'apps/cli/src/settings/accountSettings/updateAccountSettingsV2WithRetry.ts',
    // Finite bootstrap deliberately stays on the native Machine transfer
    // owner; changes there must re-run the composed seed corridor.
    'apps/cli/src/machines/transfer/**',
    'apps/cli/native/processcustody/**',
    'apps/cli/scripts/runWorkspaceSyncRealIntegration.mjs',
    'apps/cli/scripts/runWorkspaceSyncRealIntegration.test.mjs',
    'scripts/workspaces/execPnpmCommand.mjs',
    'apps/cli/vitest.integration.config.ts',
    // Owns test:workspace-sync:real:local, the only definition of what the lane runs.
    'apps/cli/package.json',
    'packages/cli-common/mutagen-engine.json',
    'packages/cli-common/package.json',
    'packages/cli-common/scripts/runMutagenEngineLiveTest.mjs',
    // The daemon workspace-sync runtime resolves the Mutagen engine artifact
    // target/paths and asserts its payload through this owner before launching.
    'packages/cli-common/src/firstPartyRuntime/**',
    // Signed release download, checksum/Minisign verification and the GitHub
    // release reader the required acquisition step exercises end to end.
    'packages/release-runtime/**',
    'packages/iroh-native/**',
    'packages/protocol/src/sessions/control/handoff/**',
    // The destructive handoff leaf start.ts classifies transcript storage
    // through this exact canonical owner before mutation. Keep the leaf and
    // its test selected without broadening to sessions/external/**.
    'packages/protocol/src/sessions/external/linkedSessionMetadata.ts',
    'packages/protocol/src/sessions/external/linkedSessionMetadata.test.ts',
    // Account Settings owns rehydration of workspaceRefsV1 and
    // workspaceSyncRelationshipsV1; both real specs parse and round-trip them.
    'packages/protocol/src/account/settings/accountSettings.ts',
    'packages/protocol/src/workspaces/workspaceRefV1.ts',
    // The destructive-target handoff proof is raised and replayed through the Action
    // approval owner, so the lane's target-replacement/mirror evidence depends on these
    // exact files. Bounded to the handoff-carrying owners, not Actions at large.
    'apps/cli/src/session/actions/createCliActionDeps.ts',
    'packages/protocol/src/actions/actionExecutor.ts',
    'packages/protocol/src/actions/actionExecutor.sessionHandoff.test.ts',
    'packages/protocol/src/actions/actionExecutor.workspaceSyncConflict.test.ts',
    'packages/protocol/src/actions/actionApprovalMetadata.ts',
    'packages/protocol/src/actions/actionApprovalPolicy.ts',
    'packages/protocol/src/actions/actionIds.ts',
    'packages/protocol/src/actions/actionIds.test.ts',
    'packages/protocol/src/actions/actionSpecs.ts',
    'packages/protocol/src/actions/executor/**',
    'apps/cli/src/session/actions/approvals/artifactStore.ts',
    // Public UI callers must continue entering the same Action owners. These
    // exact source/tests select the composed lane without broadening it to all
    // UI sync changes.
    'apps/ui/sources/sync/domains/sessionHandoff/executeSessionHandoffAction.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/executeSessionHandoffAction.test.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/runSessionHandoffPickerFlow.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/runSessionHandoffPickerFlow.test.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/sessionHandoffDefaults.ts',
    // UI handoff availability/reachability resolution is part of the composed
    // entry: the public callers above import these owners, so a change to
    // them must select the lane too.
    'apps/ui/sources/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId.test.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability.test.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/useSessionHandoffSourceReachability.ts',
    'apps/ui/sources/sync/domains/sessionHandoff/useSessionHandoffSourceReachability.test.ts',
    'apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts',
    'apps/ui/sources/sync/ops/actions/defaultActionExecutor.sessionFork.test.ts',
    // The tracked UI handoff operation client is a direct subject of the
    // thin-client suite; the rest of ops is not on this corridor.
    'apps/ui/sources/sync/ops/sessionHandoffs.ts',
    'apps/ui/sources/sync/ops/sessionHandoffs.thinClient.test.ts',
    'apps/ui/sources/sync/ops/workspaceSync.ts',
    'apps/ui/sources/sync/ops/workspaceSync.test.ts',
    'apps/ui/sources/app/(app)/session/[id]/info.tsx',
    'apps/ui/sources/__tests__/routes/(app)/session/[id]/info.test.tsx',
    'apps/ui/sources/components/sessions/handoff/SessionHandoffPickerModal.tsx',
    'apps/ui/sources/components/sessions/handoff/SessionHandoffPickerModal.test.tsx',
    'apps/ui/sources/components/sessions/actions/SessionHeaderActionMenu.tsx',
    'apps/ui/sources/components/sessions/actions/SessionHeaderActionMenu.sessionHandoff.test.tsx',
    'apps/ui/sources/components/settings/session/SessionHandoffSettingsView.tsx',
    'apps/ui/sources/components/settings/session/SessionHandoffSettingsView.test.tsx',
    'apps/ui/sources/components/workspaces/sync/WorkspaceSyncConflictDetailsView.tsx',
    'apps/ui/sources/components/workspaces/sync/WorkspaceSyncConflictDetailsView.test.tsx',
    '.github/workflows/tests.yml',
    // Owns the manual selection this lane is reachable by.
    '.github/workflows/tests-dispatch.yml',
  ]) {
    assert.ok(filters.includes(path), `Lane 08 change surface ${path} must select the real workspace-sync lane`);
  }

  // The coordinator selection stays bounded: broadening it to the whole
  // actionOperations owner would run a 45-minute source-built lane for every
  // unrelated action-operation change.
  assert.equal(filters.includes('apps/cli/src/daemon/actionOperations/**'), false);

  // Same bound on the Action approval surfaces: only the files that carry the handoff
  // proof are listed. Whole-owner globs would run this 45-minute lane for every unrelated
  // action spec, dep or executor change.
  assert.equal(filters.includes('packages/protocol/src/actions/**'), false);
  assert.equal(filters.includes('apps/cli/src/session/actions/**'), false);

  // WorkspaceSyncRelationshipV1Schema needs no filter entry of its own only for
  // as long as it stays inside the handoff prefix already listed above. Moving
  // it elsewhere silently drops the lane's relationship coverage.
  assert.match(
    readFileSync(join(repoRoot, 'packages/protocol/src/sessions/control/handoff/workspaceSyncSchemas.ts'), 'utf8'),
    /export const WorkspaceSyncRelationshipV1Schema\b/u,
  );

  // Every step that costs runner time (and the runner invocation itself) is gated on that selection.
  for (const step of job.steps) {
    if (step.name === 'Checkout' || step.name === 'Detect workspace sync-relevant changes') continue;
    if (step.name === 'Skip workspace sync (no relevant changes)') {
      assert.equal(step.if, GATED_ON_NON_SELECTION);
      continue;
    }
    assert.equal(step.if, GATED_ON_SELECTION, `step "${step.name}" must obey the workspace-sync change selection`);
  }
});
