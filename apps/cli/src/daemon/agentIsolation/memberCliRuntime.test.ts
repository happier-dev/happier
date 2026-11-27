import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MUTAGEN_ENGINE_ARTIFACT_FORMAT,
  MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION,
  MUTAGEN_ENGINE_FORK_BRANCH,
  MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
  MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256,
  MUTAGEN_ENGINE_GO_VERSION,
  MUTAGEN_ENGINE_PROTOCOL_EPOCH,
  MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT,
  MUTAGEN_ENGINE_UPSTREAM_COMMIT,
  MUTAGEN_ENGINE_UPSTREAM_TAG,
  MUTAGEN_ENGINE_VERSION,
  resolveMutagenEngineArtifactTarget,
  resolveMutagenEngineReleaseTag,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createDaemonAgentIsolationEffects } from './createDaemonAgentIsolationEffects';
import {
  buildAgentIsolationMemberCliRuntimeSteps,
  isAgentIsolationMemberCliCurrent,
  resolveAgentIsolationMemberCliRuntime,
  resolveAgentIsolationMemberMutagenAgent,
  resolveAgentIsolationMemberNativeAgent,
} from './memberCliRuntime';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(async () => {
      execFileSync('/bin/chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
      await rm(dir, { recursive: true, force: true });
    });
  }
});

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function writeValidMutagenPayload(payloadRoot: string, agentBytes: string | Buffer = '#!/bin/sh\nexit 0\n'): Promise<{ agentPath: string; agentSha256: string }> {
  const targetTriple = resolveMutagenEngineArtifactTarget();
  const managerBytes = '#!/bin/sh\nexit 0\n';
  const managerSha256 = sha256(managerBytes);
  const agentSha256 = sha256(agentBytes);
  const releaseTag = resolveMutagenEngineReleaseTag(MUTAGEN_ENGINE_VERSION);
  const mutagenLicense = 'MIT License\nServer Side Public License Version 1\n';
  const ssplLicense = 'Server Side Public License Version 1\n';
  const notices = 'Third-party notices\n';

  await mkdir(join(payloadRoot, 'bin'), { recursive: true });
  await mkdir(join(payloadRoot, 'licenses'), { recursive: true });
  const managerPath = join(payloadRoot, 'bin', 'happier-mutagen');
  const agentPath = join(payloadRoot, 'bin', 'happier-mutagen-agent');
  await writeFile(managerPath, managerBytes, { mode: 0o755 });
  await writeFile(agentPath, agentBytes, { mode: 0o755 });
  await writeFile(join(payloadRoot, 'licenses', 'MUTAGEN-LICENSE'), mutagenLicense, { mode: 0o644 });
  await writeFile(join(payloadRoot, 'licenses', 'SSPL-LICENSE'), ssplLicense, { mode: 0o644 });
  await writeFile(join(payloadRoot, 'licenses', 'THIRD-PARTY-NOTICES'), notices, { mode: 0o644 });

  const manifest = {
    format: MUTAGEN_ENGINE_ARTIFACT_FORMAT,
    schemaVersion: MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION,
    component: 'mutagen-engine',
    engineVersion: MUTAGEN_ENGINE_VERSION,
    forkCommit: MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
    sourceRepository: 'https://github.com/happier-dev/mutagen',
    sourceTag: releaseTag,
    sourceArchive: `happier-mutagen-source-${releaseTag}.tar.gz`,
    forkBranch: MUTAGEN_ENGINE_FORK_BRANCH,
    transportSpikeCommit: MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT,
    upstreamTag: MUTAGEN_ENGINE_UPSTREAM_TAG,
    upstreamCommit: MUTAGEN_ENGINE_UPSTREAM_COMMIT,
    toolchain: {
      go: MUTAGEN_ENGINE_GO_VERSION,
      goChecksum: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256[targetTriple],
    },
    protocolEpoch: MUTAGEN_ENGINE_PROTOCOL_EPOCH,
    targetTriple,
    managerPath: 'bin/happier-mutagen',
    agentPath: 'bin/happier-mutagen-agent',
    licensePolicy: 'mixed-mit-sspl',
    ssplEnabled: true,
    buildTags: ['mutagensidecar', 'mutagensspl', 'mutagenagent'],
    managerBuildTags: ['mutagensidecar', 'mutagensspl'],
    agentBuildTags: ['mutagenagent', 'mutagensspl'],
    cgoEnabled: false,
    watcher: 'polling',
    releaseTag,
    managerSha256,
    agentSha256,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(payloadRoot, '.happier-mutagen-engine.json'), manifestText, { mode: 0o644 });

  const checksums = [
    `${managerSha256}  bin/happier-mutagen`,
    `${agentSha256}  bin/happier-mutagen-agent`,
    `${sha256(mutagenLicense)}  licenses/MUTAGEN-LICENSE`,
    `${sha256(ssplLicense)}  licenses/SSPL-LICENSE`,
    `${sha256(notices)}  licenses/THIRD-PARTY-NOTICES`,
    `${sha256(manifestText)}  .happier-mutagen-engine.json`,
  ].join('\n') + '\n';
  await writeFile(join(payloadRoot, 'checksums.txt'), checksums, { mode: 0o644 });

  return { agentPath, agentSha256 };
}

async function createPublishedMemberStore(options?: Readonly<{
  agentBytes?: string;
  generation?: string;
  withMutagen?: boolean;
}>) {
  const parentDir = await createTempDir('happier-member-store-opt-');
  const storeHash = 'a'.repeat(64);
  const generation = options?.generation ?? 'b'.repeat(64);
  const store = join(parentDir, `happier-member-cli-${storeHash}`);
  const genDir = join(store, generation);
  await mkdir(genDir, { recursive: true, mode: 0o755 });
  await chmod(parentDir, 0o755);
  await chmod(store, 0o755);
  await chmod(genDir, 0o755);
  await writeFile(join(genDir, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o555 });
  await symlink(generation, join(store, 'current'));

  const agentBytes = options?.agentBytes ?? '#!/bin/sh\necho member-agent\n';
  const expectedSha256 = sha256(agentBytes);
  const mutagenDir = join(genDir, '.happier-member-mutagen');
  const agentPath = join(mutagenDir, 'happier-mutagen-agent');
  if (options?.withMutagen !== false) {
    await mkdir(mutagenDir, { mode: 0o755 });
    await writeFile(agentPath, agentBytes, { mode: 0o555 });
    await chmod(mutagenDir, 0o555);
  }
  const boundary = {
    parentDir,
    expectedOwnerUid: process.getuid!(),
    platform: 'linux' as const,
  };
  return {
    parentDir,
    store,
    genDir,
    currentDir: join(store, 'current'),
    executable: join(store, 'current', 'happier'),
    mutagenDir,
    agentPath,
    expectedSha256,
    boundary,
  };
}

describe('memberCliRuntime mutagen agent publishing and resolution', () => {
  it.skipIf(process.platform !== 'linux')('includes verified mutagen agent in member CLI steps, changes generation when added, and validates POSIX sh syntax', async () => {
    const home = await createTempDir('happier-private-home-');
    const cliVersion = join(home, 'cli', 'versions', 'v1');
    await mkdir(cliVersion, { recursive: true });
    await writeFile(join(cliVersion, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await symlink('versions/v1', join(home, 'cli', 'current'));

    const sourceCli = join(home, 'cli', 'current', 'happier');
    const sourceMutagenInstallRoot = join(home, 'mutagen');
    const runtime = resolveAgentIsolationMemberCliRuntime(sourceCli, { sourceMutagenInstallRoot });

    const stepsWithoutMutagen = await buildAgentIsolationMemberCliRuntimeSteps(runtime);
    const payloadStepWithout = stepsWithoutMutagen.find(step => step.id === 'member-cli-payload');
    expect(payloadStepWithout?.kind).toBe('script');
    if (payloadStepWithout?.kind !== 'script') throw new Error('Missing member-cli-payload step');
    execFileSync('/bin/sh', ['-n', '-c', payloadStepWithout.body]);
    expect(payloadStepWithout.body.split('\n')[0]).not.toContain('happier-mutagen-agent');

    // Now install a valid mutagen-engine payload under the private home.
    const mutagenVersion = join(sourceMutagenInstallRoot, 'versions', MUTAGEN_ENGINE_VERSION);
    const { agentPath, agentSha256 } = await writeValidMutagenPayload(mutagenVersion);
    await symlink(`versions/${MUTAGEN_ENGINE_VERSION}`, join(sourceMutagenInstallRoot, 'current'));

    const stepsWithMutagen = await buildAgentIsolationMemberCliRuntimeSteps(runtime);
    const payloadStepWith = stepsWithMutagen.find(step => step.id === 'member-cli-payload');
    expect(payloadStepWith?.kind).toBe('script');
    if (payloadStepWith?.kind !== 'script') throw new Error('Missing member-cli-payload step');
    execFileSync('/bin/sh', ['-n', '-c', payloadStepWith.body]);
    expect(payloadStepWith.body).toContain(agentPath);
    expect(payloadStepWith.body).toContain(agentSha256);
    expect(payloadStepWith.body).not.toBe(payloadStepWithout.body);

    // Tampering the host mutagen agent causes it to be rejected and omitted from root publication.
    await writeFile(agentPath, '#!/bin/sh\necho tampered\n', { mode: 0o755 });
    const stepsTampered = await buildAgentIsolationMemberCliRuntimeSteps(runtime);
    const payloadStepTampered = stepsTampered.find(step => step.id === 'member-cli-payload');
    if (payloadStepTampered?.kind !== 'script') throw new Error('Missing member-cli-payload step');
    expect(payloadStepTampered.body).not.toContain(agentSha256);
  });

  it.skipIf(process.platform !== 'linux')('resolves verified root-owned non-writable published mutagen agent and ignores ambient env overrides', async () => {
    const fixture = await createPublishedMemberStore();
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '/tmp/spoofed-install-home');
    vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', '/tmp/spoofed-tools');

    const resolved = await resolveAgentIsolationMemberMutagenAgent(fixture.currentDir, {
      expectedSha256: fixture.expectedSha256,
      boundary: fixture.boundary,
    });
    expect(resolved).toBe(fixture.agentPath);

    const nativeAgent = await resolveAgentIsolationMemberNativeAgent({
      hostAgent: { executablePath: '/home/rwsqa/.happier/mutagen/versions/0.18.1-happier.12/bin/happier-mutagen-agent', sha256: fixture.expectedSha256 },
      memberCliExecutablePath: fixture.executable,
      boundary: fixture.boundary,
    });
    expect(nativeAgent).toEqual({ executablePath: fixture.agentPath });

    // Non-member runtime roots keep the host agent path unchanged.
    const passthrough = await resolveAgentIsolationMemberNativeAgent({
      hostAgent: { executablePath: '/opt/happier/mutagen/current/bin/happier-mutagen-agent', sha256: fixture.expectedSha256 },
      memberCliExecutablePath: '/opt/happier/cli/current/happier',
      boundary: fixture.boundary,
    });
    expect(passthrough).toEqual({ executablePath: '/opt/happier/mutagen/current/bin/happier-mutagen-agent' });
  });

  it.skipIf(process.platform !== 'linux')('fails closed when published mutagen agent is missing, symlinked, writable, non-executable, setgid, wrong owner, or sha256 mismatched', async () => {
    // 1. Missing mutagen directory/file
    const missing = await createPublishedMemberStore({ withMutagen: false });
    expect(await resolveAgentIsolationMemberMutagenAgent(missing.currentDir, {
      expectedSha256: missing.expectedSha256,
      boundary: missing.boundary,
    })).toBeNull();
    await expect(resolveAgentIsolationMemberNativeAgent({
      hostAgent: { executablePath: '/home/rwsqa/.happier/mutagen/current/bin/happier-mutagen-agent', sha256: missing.expectedSha256 },
      memberCliExecutablePath: missing.executable,
      boundary: missing.boundary,
    })).rejects.toMatchObject({
      code: 'agent_isolation_unavailable',
      details: expect.objectContaining({ reason: 'payload_not_accessible', readinessCode: 'payload_not_accessible' }),
    });

    // 2. Wrong owner (production default expects root uid 0; temp file is owned by current non-root user)
    if (process.getuid!() !== 0) {
      const wrongOwner = await createPublishedMemberStore();
      expect(await resolveAgentIsolationMemberMutagenAgent(wrongOwner.currentDir, {
        expectedSha256: wrongOwner.expectedSha256,
        boundary: { ...wrongOwner.boundary, expectedOwnerUid: 0 },
      })).toBeNull();
    }

    // 3. Symlinked agent binary
    const symlinkFile = await createPublishedMemberStore({ withMutagen: false });
    const outsideTarget = join(symlinkFile.parentDir, 'outside-agent');
    await writeFile(outsideTarget, '#!/bin/sh\necho member-agent\n', { mode: 0o555 });
    await mkdir(symlinkFile.mutagenDir, { mode: 0o755 });
    await symlink(outsideTarget, symlinkFile.agentPath);
    await chmod(symlinkFile.mutagenDir, 0o555);
    expect(await resolveAgentIsolationMemberMutagenAgent(symlinkFile.currentDir, {
      expectedSha256: sha256('#!/bin/sh\necho member-agent\n'),
      boundary: symlinkFile.boundary,
    })).toBeNull();

    // 4. Symlinked .happier-member-mutagen directory
    const symlinkDir = await createPublishedMemberStore({ withMutagen: false });
    const outsideDir = join(symlinkDir.parentDir, 'outside-mutagen');
    await mkdir(outsideDir, { mode: 0o755 });
    await writeFile(join(outsideDir, 'happier-mutagen-agent'), '#!/bin/sh\necho member-agent\n', { mode: 0o555 });
    await chmod(outsideDir, 0o555);
    await symlink(outsideDir, symlinkDir.mutagenDir);
    expect(await resolveAgentIsolationMemberMutagenAgent(symlinkDir.currentDir, {
      expectedSha256: sha256('#!/bin/sh\necho member-agent\n'),
      boundary: symlinkDir.boundary,
    })).toBeNull();

    // 5. Group-writable agent binary (0775)
    const groupWritable = await createPublishedMemberStore();
    await chmod(groupWritable.mutagenDir, 0o755);
    await chmod(groupWritable.agentPath, 0o775);
    await chmod(groupWritable.mutagenDir, 0o555);
    expect(await resolveAgentIsolationMemberMutagenAgent(groupWritable.currentDir, {
      expectedSha256: groupWritable.expectedSha256,
      boundary: groupWritable.boundary,
    })).toBeNull();

    // 6. World-writable .happier-member-mutagen directory (0757)
    const writableDir = await createPublishedMemberStore();
    await chmod(writableDir.mutagenDir, 0o757);
    expect(await resolveAgentIsolationMemberMutagenAgent(writableDir.currentDir, {
      expectedSha256: writableDir.expectedSha256,
      boundary: writableDir.boundary,
    })).toBeNull();

    // 7. Non-executable agent binary (0444)
    const nonExecutable = await createPublishedMemberStore();
    await chmod(nonExecutable.mutagenDir, 0o755);
    await chmod(nonExecutable.agentPath, 0o444);
    await chmod(nonExecutable.mutagenDir, 0o555);
    expect(await resolveAgentIsolationMemberMutagenAgent(nonExecutable.currentDir, {
      expectedSha256: nonExecutable.expectedSha256,
      boundary: nonExecutable.boundary,
    })).toBeNull();

    // 8. Setgid agent binary (02555)
    const setgidFile = await createPublishedMemberStore();
    await chmod(setgidFile.mutagenDir, 0o755);
    await chmod(setgidFile.agentPath, 0o2555);
    await chmod(setgidFile.mutagenDir, 0o555);
    expect(await resolveAgentIsolationMemberMutagenAgent(setgidFile.currentDir, {
      expectedSha256: setgidFile.expectedSha256,
      boundary: setgidFile.boundary,
    })).toBeNull();

    // 9. SHA-256 mismatch
    const mismatched = await createPublishedMemberStore();
    expect(await resolveAgentIsolationMemberMutagenAgent(mismatched.currentDir, {
      expectedSha256: '0'.repeat(64),
      boundary: mismatched.boundary,
    })).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('marks member CLI stale in isAgentIsolationMemberCliCurrent when mutagen-engine is installed after initial CLI publish', async () => {
    const home = await createTempDir('happier-stale-mutagen-');
    const cliVersion = join(home, 'cli', 'versions', 'v1');
    await mkdir(cliVersion, { recursive: true });
    await writeFile(join(cliVersion, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await symlink('versions/v1', join(home, 'cli', 'current'));

    const sourceCli = join(home, 'cli', 'current', 'happier');
    const sourceMutagenInstallRoot = join(home, 'mutagen');
    const storeRoot = await createTempDir('happier-stale-store-');
    const runtime = {
      sourceCli,
      sourceMutagenInstallRoot,
      root: storeRoot,
      executable: join(storeRoot, 'current', 'happier'),
    };
    const stepsWithout = await buildAgentIsolationMemberCliRuntimeSteps(runtime);
    const payloadWithout = stepsWithout.find(step => step.id === 'member-cli-payload');
    if (payloadWithout?.kind !== 'script') throw new Error('Missing payload step');
    const generationMatch = /'([0-9a-f]{64})'/u.exec(payloadWithout.body);
    if (!generationMatch) throw new Error('Missing generation hash in script');
    await symlink(generationMatch[1]!, dirname(runtime.executable));
    expect(await isAgentIsolationMemberCliCurrent(runtime)).toBe(true);

    // Installing mutagen-engine invalidates the prior CLI-only generation.
    const mutagenVersion = join(sourceMutagenInstallRoot, 'versions', MUTAGEN_ENGINE_VERSION);
    await writeValidMutagenPayload(mutagenVersion);
    await symlink(`versions/${MUTAGEN_ENGINE_VERSION}`, join(sourceMutagenInstallRoot, 'current'));
    expect(await isAgentIsolationMemberCliCurrent(runtime)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('fails closed on setuid, sticky, world-writable binary, writable store/generation ancestors, and missing/empty/malformed hostAgent.sha256', async () => {
    // 1. Setuid agent binary (04555)
    const setuidFile = await createPublishedMemberStore();
    await chmod(setuidFile.mutagenDir, 0o755);
    await chmod(setuidFile.agentPath, 0o4555);
    await chmod(setuidFile.mutagenDir, 0o555);
    expect((await lstat(setuidFile.agentPath)).mode & 0o4000).toBe(0o4000);
    expect(await resolveAgentIsolationMemberMutagenAgent(setuidFile.currentDir, {
      expectedSha256: setuidFile.expectedSha256,
      boundary: setuidFile.boundary,
    })).toBeNull();

    // 2. Sticky-bit agent binary (01555)
    const stickyFile = await createPublishedMemberStore();
    await chmod(stickyFile.mutagenDir, 0o755);
    await chmod(stickyFile.agentPath, 0o1555);
    await chmod(stickyFile.mutagenDir, 0o555);
    expect((await lstat(stickyFile.agentPath)).mode & 0o1000).toBe(0o1000);
    expect(await resolveAgentIsolationMemberMutagenAgent(stickyFile.currentDir, {
      expectedSha256: stickyFile.expectedSha256,
      boundary: stickyFile.boundary,
    })).toBeNull();

    // 3. World-writable agent binary (0557)
    const worldWritableFile = await createPublishedMemberStore();
    await chmod(worldWritableFile.mutagenDir, 0o755);
    await chmod(worldWritableFile.agentPath, 0o557);
    await chmod(worldWritableFile.mutagenDir, 0o555);
    expect(await resolveAgentIsolationMemberMutagenAgent(worldWritableFile.currentDir, {
      expectedSha256: worldWritableFile.expectedSha256,
      boundary: worldWritableFile.boundary,
    })).toBeNull();

    // 4. Writable store ancestor (0775 and 0757)
    for (const badMode of [0o775, 0o757]) {
      const writableStore = await createPublishedMemberStore();
      await chmod(writableStore.store, badMode);
      expect(await resolveAgentIsolationMemberMutagenAgent(writableStore.currentDir, {
        expectedSha256: writableStore.expectedSha256,
        boundary: writableStore.boundary,
      })).toBeNull();
    }

    // 5. Writable generation ancestor (0775 and 0757)
    for (const badMode of [0o775, 0o757]) {
      const writableGen = await createPublishedMemberStore();
      await chmod(writableGen.genDir, badMode);
      expect(await resolveAgentIsolationMemberMutagenAgent(writableGen.currentDir, {
        expectedSha256: writableGen.expectedSha256,
        boundary: writableGen.boundary,
      })).toBeNull();
    }

    // 6. Missing, empty, whitespace, or malformed hostAgent.sha256 fails closed
    const validStore = await createPublishedMemberStore();
    for (const badSha of [undefined, '', '   ', 'not-a-valid-sha256']) {
      await expect(resolveAgentIsolationMemberNativeAgent({
        hostAgent: {
          executablePath: '/home/rwsqa/.happier/mutagen/current/bin/happier-mutagen-agent',
          ...(badSha !== undefined ? { sha256: badSha } : {}),
        },
        memberCliExecutablePath: validStore.executable,
        boundary: validStore.boundary,
      })).rejects.toMatchObject({
        code: 'agent_isolation_unavailable',
        details: expect.objectContaining({ reason: 'payload_not_accessible', readinessCode: 'payload_not_accessible' }),
      });
    }
  });

  it.skipIf(process.platform !== 'linux')('executes publishMemberCli script safely and blocks TOCTOU symlink/FIFO swaps before chmod touches targets', async () => {
    const uid = process.getuid!();
    const gid = process.getgid!();
    const adaptOwnershipChecksForNonRootTest = (scriptBody: string) =>
      scriptBody.replaceAll('0:0:555', `${uid}:${gid}:555`).replaceAll('0:0', `${uid}:${gid}`);

    const setupScenario = async (label: string) => {
      const base = await createTempDir(`happier-publish-sh-${label}-`);
      const cliVersion = join(base, 'home', 'cli', 'versions', 'v1');
      await mkdir(cliVersion, { recursive: true });
      await writeFile(join(cliVersion, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await symlink('versions/v1', join(base, 'home', 'cli', 'current'));

      const sourceMutagenInstallRoot = join(base, 'home', 'mutagen');
      const mutagenVersion = join(sourceMutagenInstallRoot, 'versions', MUTAGEN_ENGINE_VERSION);
      const { agentPath, agentSha256 } = await writeValidMutagenPayload(mutagenVersion, '#!/bin/sh\necho real-agent\n');
      await symlink(`versions/${MUTAGEN_ENGINE_VERSION}`, join(sourceMutagenInstallRoot, 'current'));

      const storeRoot = join(base, 'store');
      await mkdir(storeRoot, { mode: 0o755 });
      await chmod(storeRoot, 0o755);

      const runtime = {
        sourceCli: join(base, 'home', 'cli', 'current', 'happier'),
        sourceMutagenInstallRoot,
        root: storeRoot,
        executable: join(storeRoot, 'current', 'happier'),
      };
      const steps = await buildAgentIsolationMemberCliRuntimeSteps(runtime);
      const payloadStep = steps.find(step => step.id === 'member-cli-payload');
      if (payloadStep?.kind !== 'script' || !payloadStep.check) throw new Error('Missing member-cli-payload step');
      return { base, cliVersion, agentPath, agentSha256, storeRoot, payloadStep };
    };

    // 1. Happy path: real apply + check execution publishes mode 0555 agent with verified digest.
    const happy = await setupScenario('happy');
    const applyRes = spawnSync('/bin/sh', ['-c', adaptOwnershipChecksForNonRootTest(happy.payloadStep.body)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(applyRes.status, applyRes.stderr).toBe(0);
    const checkRes = spawnSync('/bin/sh', ['-c', adaptOwnershipChecksForNonRootTest(happy.payloadStep.check.body)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(checkRes.status, checkRes.stderr).toBe(0);
    const publishedAgent = join(happy.storeRoot, 'current', '.happier-member-mutagen', 'happier-mutagen-agent');
    const publishedStat = await lstat(publishedAgent);
    expect(publishedStat.isFile()).toBe(true);
    expect(publishedStat.mode & 0o7777).toBe(0o555);

    // 2. TOCTOU symlink swap on $mutagen_agent after pre-check, strictly before cp -RP / chmod 0555:
    // must exit 2 before chmod ever touches the symlink target.
    const symlinkRace = await setupScenario('symlink-race');
    const victimFile = join(symlinkRace.base, 'victim-secret');
    await writeFile(victimFile, 'top-secret\n', { mode: 0o600 });
    await chmod(victimFile, 0o600);
    const needleMutagenCp = 'cp -RP --reflink=auto -- "$mutagen_agent" "$stage/payload/$mutagen_rel"';
    expect(symlinkRace.payloadStep.body).toContain(needleMutagenCp);
    const racedSymlinkScript = adaptOwnershipChecksForNonRootTest(symlinkRace.payloadStep.body).replace(
      needleMutagenCp,
      `rm -f -- "$mutagen_agent" && ln -s -- '${victimFile}' "$mutagen_agent"\n    ${needleMutagenCp}`,
    );
    const symlinkRes = spawnSync('/bin/sh', ['-c', racedSymlinkScript], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(symlinkRes.status).toBe(2);
    expect((await lstat(victimFile)).mode & 0o7777).toBe(0o600);

    // 3. TOCTOU FIFO swap on $mutagen_agent right before cp -RP:
    // cp -RP copies the FIFO node without opening/hanging, and the -f check fails with exit 2.
    const fifoRace = await setupScenario('fifo-race');
    const racedFifoScript = adaptOwnershipChecksForNonRootTest(fifoRace.payloadStep.body).replace(
      needleMutagenCp,
      `rm -f -- "$mutagen_agent" && mkfifo -- "$mutagen_agent"\n    ${needleMutagenCp}`,
    );
    const fifoRes = spawnSync('/bin/sh', ['-c', racedFifoScript], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(fifoRes.signal).toBeNull();
    expect(fifoRes.status).toBe(2);

    // 4. TOCTOU symlink swap on $source right before cp -RP:
    // must exit 2 before chmod touches the symlink target directory.
    const sourceRace = await setupScenario('source-race');
    const victimDir = join(sourceRace.base, 'victim-dir');
    await mkdir(victimDir, { mode: 0o700 });
    await chmod(victimDir, 0o700);
    const needleSourceCp = 'cp -RP --reflink=auto -- "$source" "$stage/payload"';
    expect(sourceRace.payloadStep.body).toContain(needleSourceCp);
    const racedSourceScript = adaptOwnershipChecksForNonRootTest(sourceRace.payloadStep.body).replace(
      needleSourceCp,
      `rm -rf -- "$source" && ln -s -- '${victimDir}' "$source"\n  ${needleSourceCp}`,
    );
    const sourceRes = spawnSync('/bin/sh', ['-c', racedSourceScript], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(sourceRes.status).toBe(2);
    expect((await lstat(victimDir)).mode & 0o7777).toBe(0o700);
  });

  it.skipIf(process.platform !== 'linux')('caches verified metadata in isAgentIsolationMemberCliCurrent without re-hashing binaries on repeated calls, while detecting tampering immediately and keeping launch-time verification uncached', async () => {
    const home = await createTempDir('happier-hotpath-home-');
    const cliVersion = join(home, 'cli', 'versions', 'v1');
    await mkdir(cliVersion, { recursive: true });
    await writeFile(join(cliVersion, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await symlink('versions/v1', join(home, 'cli', 'current'));

    const sourceMutagenInstallRoot = join(home, 'mutagen');
    const mutagenVersion = join(sourceMutagenInstallRoot, 'versions', MUTAGEN_ENGINE_VERSION);
    const payloadPrefix = Buffer.from('#!/bin/sh\n# ');
    const agentBytes = Buffer.concat([payloadPrefix, Buffer.alloc(256 * 1024, 0x41), Buffer.from('\nexit 0\n')]);
    const { agentPath, agentSha256 } = await writeValidMutagenPayload(mutagenVersion, agentBytes);
    await symlink(`versions/${MUTAGEN_ENGINE_VERSION}`, join(sourceMutagenInstallRoot, 'current'));

    const parentDir = await createTempDir('happier-hotpath-opt-');
    await chmod(parentDir, 0o755);
    const storeHash = 'c'.repeat(64);
    const store = join(parentDir, `happier-member-cli-${storeHash}`);
    await mkdir(store, { mode: 0o755 });
    await chmod(store, 0o755);

    const runtime = {
      sourceCli: join(home, 'cli', 'current', 'happier'),
      sourceMutagenInstallRoot,
      root: store,
      executable: join(store, 'current', 'happier'),
    };
    const steps = await buildAgentIsolationMemberCliRuntimeSteps(runtime);
    const payloadStep = steps.find(step => step.id === 'member-cli-payload');
    if (payloadStep?.kind !== 'script') throw new Error('Missing payload step');
    const generationMatch = /'([0-9a-f]{64})'/u.exec(payloadStep.body);
    if (!generationMatch) throw new Error('Missing generation hash');
    const generation = generationMatch[1]!;

    const genDir = join(store, generation);
    const mutagenDir = join(genDir, '.happier-member-mutagen');
    const publishedAgentPath = join(mutagenDir, 'happier-mutagen-agent');
    await mkdir(mutagenDir, { recursive: true, mode: 0o755 });
    await writeFile(join(genDir, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o555 });
    await writeFile(publishedAgentPath, agentBytes, { mode: 0o555 });
    await chmod(genDir, 0o755);
    await chmod(mutagenDir, 0o555);
    await symlink(generation, join(store, 'current'));

    const boundary = {
      parentDir,
      expectedOwnerUid: process.getuid!(),
      platform: 'linux' as const,
    };

    const probeHandle = await open(publishedAgentPath, 'r');
    const fileHandleProto = Object.getPrototypeOf(probeHandle) as { read: (...args: unknown[]) => Promise<unknown> };
    await probeHandle.close();
    const hashProto = Object.getPrototypeOf(createHash('sha256')) as { update: (data: string | Uint8Array) => unknown };

    let fdReadCalls = 0;
    let hashedBytes = 0;
    const origFdRead = fileHandleProto.read;
    const origHashUpdate = hashProto.update;
    const fdReadSpy = vi.spyOn(fileHandleProto, 'read').mockImplementation(function (this: unknown, ...args: unknown[]) {
      fdReadCalls += 1;
      return origFdRead.apply(this, args);
    });
    const hashUpdateSpy = vi.spyOn(hashProto, 'update').mockImplementation(function (this: unknown, data: string | Uint8Array) {
      hashedBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      return origHashUpdate.call(this, data);
    });

    try {
      // Cold call verifies published binary from FD and warms the published digest cache.
      expect(await isAgentIsolationMemberCliCurrent(runtime, boundary)).toBe(true);
      expect(fdReadCalls).toBeGreaterThan(0);
      expect(hashedBytes).toBeGreaterThanOrEqual(agentBytes.byteLength);

      // Hot-path repeated calls: zero FD binary reads and zero binary re-hashing.
      fdReadCalls = 0;
      hashedBytes = 0;
      for (let i = 0; i < 10; i++) {
        expect(await isAgentIsolationMemberCliCurrent(runtime, boundary)).toBe(true);
      }
      expect(fdReadCalls).toBe(0);
      expect(hashedBytes).toBeLessThan(16 * 1024);

      // Launch-time resolveAgentIsolationMemberNativeAgent MUST still hash directly from the open FD.
      fdReadCalls = 0;
      hashedBytes = 0;
      expect(await resolveAgentIsolationMemberNativeAgent({
        hostAgent: { executablePath: agentPath, sha256: agentSha256 },
        memberCliExecutablePath: runtime.executable,
        boundary,
      })).toEqual({ executablePath: publishedAgentPath });
      expect(fdReadCalls).toBeGreaterThan(0);
      expect(hashedBytes).toBeGreaterThanOrEqual(agentBytes.byteLength);

      // Replacing the published binary immediately invalidates the cache and fails closed.
      await chmod(mutagenDir, 0o755);
      const replacedTemp = join(mutagenDir, 'happier-mutagen-agent.tmp');
      await writeFile(replacedTemp, '#!/bin/sh\necho tampered-member-agent\n', { mode: 0o555 });
      await rename(replacedTemp, publishedAgentPath);
      await chmod(mutagenDir, 0o555);
      fdReadCalls = 0;
      expect(await isAgentIsolationMemberCliCurrent(runtime, boundary)).toBe(false);
      expect(fdReadCalls).toBeGreaterThan(0);

      // Restore published binary, verify cache re-warms, then tamper host installed mutagen binary.
      await chmod(mutagenDir, 0o755);
      await writeFile(replacedTemp, agentBytes, { mode: 0o555 });
      await rename(replacedTemp, publishedAgentPath);
      await chmod(mutagenDir, 0o555);
      expect(await isAgentIsolationMemberCliCurrent(runtime, boundary)).toBe(true);

      await writeFile(agentPath, '#!/bin/sh\necho tampered-host-agent\n', { mode: 0o755 });
      expect(await isAgentIsolationMemberCliCurrent(runtime, boundary)).toBe(false);
    } finally {
      fdReadSpy.mockRestore();
      hashUpdateSpy.mockRestore();
    }
  });

  it.skipIf(process.platform !== 'linux')('propagates releaseChannel in createDaemonAgentIsolationEffects to matching mutagen-engine and happier-cli install roots', async () => {
    const installHome = await createTempDir('happier-channel-parity-');
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', installHome);

    const makeEffects = (releaseChannel: 'stable' | 'preview' | 'publicdev') =>
      createDaemonAgentIsolationEffects({
        getMachineClient: () => null,
        adminAccess: {
          target: () => null,
          observer: createMachineAdminAccessObserver({ onChanged: async () => {} }),
        },
        readRoots: () => [],
        trackedSessions: new Map(),
        protectedRoots: [installHome],
        privateRoots: [installHome],
        releaseChannel,
      });

    const stable = makeEffects('stable');
    expect(stable.installedCli).toBe(join(installHome, 'cli', 'current', 'happier'));
    expect(stable.memberCliRuntime?.sourceMutagenInstallRoot).toBe(join(installHome, 'mutagen'));

    const preview = makeEffects('preview');
    expect(preview.installedCli).toBe(join(installHome, 'cli-preview', 'current', 'happier'));
    expect(preview.memberCliRuntime?.sourceMutagenInstallRoot).toBe(join(installHome, 'mutagen-preview'));

    const dev = makeEffects('publicdev');
    expect(dev.installedCli).toBe(join(installHome, 'cli-dev', 'current', 'happier'));
    expect(dev.memberCliRuntime?.sourceMutagenInstallRoot).toBe(join(installHome, 'mutagen-dev'));
  });
});
