import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { ensureInstalledFirstPartyComponent } from './ensureInstalledFirstPartyComponent.js';
import {
  MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
  MUTAGEN_ENGINE_PROTOCOL_EPOCH,
  MUTAGEN_ENGINE_UPSTREAM_COMMIT,
  MUTAGEN_ENGINE_UPSTREAM_TAG,
  MUTAGEN_ENGINE_VERSION,
  assertMutagenEngineArtifactPayload,
  resolveMutagenEngineArtifactPaths,
  resolveMutagenEngineArtifactTarget,
  resolveMutagenEngineReleaseTag,
  type MutagenEngineArtifactManifest,
} from './mutagenEngineArtifact.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { execFileWithDeadline } from '../process/execFileWithDeadline.js';

/**
 * Opt-in live acquisition test for the pinned Mutagen engine.
 *
 * This is the only first-party managed-component test that exercises the real
 * production acquisition chain end to end against the real GitHub release:
 *
 *   daemon composition root
 *     (`createDaemonWorkspaceSyncRuntime.resolveRuntime` in apps/cli validates
 *     with exactly the `validatePayload` mirrored below)
 *   → `ensureInstalledFirstPartyComponent`
 *   → `prepareFirstPartyComponentPayloadFromGitHubRelease`
 *   → `prepareMutagenEnginePayloadFromGitHubRelease` (existing GitHub-release
 *     provider + standard Happier Minisign trust root)
 *   → `installVersionedPayload` (versioned install under HAPPIER_HOME_DIR)
 *   → `resolveInstalledFirstPartyComponentPaths`
 *     + `resolveMutagenEngineArtifactPaths`
 *
 * It derives the engine version, release tag, fork commit, toolchain, target
 * triple, and license policy from the canonical policy exports only; it never
 * pins the pending engine version locally.
 *
 * The test is skipped unless explicitly opted in, so ordinary unit suites never
 * touch the network:
 *
 *   HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION=1 \
 *     corepack yarn -s vitest run --root packages/cli-common \
 *     src/firstPartyRuntime/mutagenEngineAcquisition.live.test.ts
 */

const liveAcquisitionEnabled = process.env.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION?.trim() === '1';

/**
 * Pass-through observation of the genuine network boundary: the real GitHub
 * release provider still performs every request; we only count how many
 * acquisitions start for the engine release tag so the concurrent-dedupe
 * contract is discriminating at a system boundary rather than asserted on
 * internal bookkeeping.
 */
const observedEngineReleaseTagFetches = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock('@happier-dev/release-runtime/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/release-runtime/github')>();
  return {
    ...actual,
    fetchGitHubReleaseByTag: async (params: Parameters<typeof actual.fetchGitHubReleaseByTag>[0]) => {
      observedEngineReleaseTagFetches.tags.push(params.tag);
      return await actual.fetchGitHubReleaseByTag(params);
    },
  };
});

const ENGINE_CHANNEL: PublicReleaseRingId = 'stable';
const ENGINE_VERSION = MUTAGEN_ENGINE_VERSION;
const ENGINE_RELEASE_TAG = resolveMutagenEngineReleaseTag(ENGINE_VERSION);
const ENGINE_TARGET_TRIPLE = resolveMutagenEngineArtifactTarget();
/** Manager/agent `version` prints the pinned upstream base version. */
const EXPECTED_BINARY_VERSION = MUTAGEN_ENGINE_UPSTREAM_TAG.replace(/^v/u, '');
const LIVE_ACQUISITION_TIMEOUT_MS = 10 * 60_000;

/**
 * Exactly the payload validator the daemon composition root passes to
 * `ensureInstalledFirstPartyComponent`; it also records the signed manifest
 * facts validated from the downloaded payload.
 */
function createDaemonPayloadValidator(): Readonly<{
  validatePayload(payloadRoot: string): Promise<void>;
  validatedManifest(): MutagenEngineArtifactManifest;
}> {
  let manifest: MutagenEngineArtifactManifest | null = null;
  return {
    async validatePayload(payloadRoot: string): Promise<void> {
      manifest = await assertMutagenEngineArtifactPayload({
        payloadRoot,
        targetTriple: ENGINE_TARGET_TRIPLE,
        engineVersion: ENGINE_VERSION,
      });
    },
    validatedManifest(): MutagenEngineArtifactManifest {
      expect(manifest, 'payload validator must have run').not.toBeNull();
      return manifest!;
    },
  };
}

function createEmptyHomeProcessEnv(): Readonly<{ homeDir: string; processEnv: NodeJS.ProcessEnv }> {
  const homeDir = mkdtempSync(join(tmpdir(), 'happier-mutagen-engine-live-'));
  // Start from a completely empty Happier home; only the host environment is
  // inherited (GitHub token/user agent), never an existing Happier home.
  const processEnv: NodeJS.ProcessEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };
  return { homeDir, processEnv };
}

describe.skipIf(!liveAcquisitionEnabled)(`live Mutagen engine acquisition from an empty Happier home (${ENGINE_RELEASE_TAG})`, () => {
  it('acquires the pinned engine once for two concurrent requests, installs a verified manager/agent pair, and runs harmless version commands', { timeout: LIVE_ACQUISITION_TIMEOUT_MS }, async () => {
    const { homeDir, processEnv } = createEmptyHomeProcessEnv();
    try {
      const validator = createDaemonPayloadValidator();

      // Two concurrent acquisitions on a completely empty home share one
      // download/install attempt through the canonical owner.
      const ensureParams = {
        componentId: 'mutagen-engine' as const,
        channel: ENGINE_CHANNEL,
        versionId: ENGINE_VERSION,
        processEnv,
        validatePayload: validator.validatePayload,
      };
      const [first, second] = await Promise.all([
        ensureInstalledFirstPartyComponent(ensureParams),
        ensureInstalledFirstPartyComponent(ensureParams),
      ]);

      // The installed payload is the exact pinned immutable engine version,
      // resolved through the canonical install layout inside the empty home.
      const expectedVersionPath = join(homeDir, 'mutagen', 'versions', ENGINE_VERSION);
      expect(first.resolvedCurrentPath).toBe(expectedVersionPath);
      expect(second.resolvedCurrentPath).toBe(expectedVersionPath);
      // The canonical resolution owner resolves the installed payload for the
      // empty home, exactly as the daemon consumer resolves it.
      expect(resolveInstalledFirstPartyComponentPaths({
        componentId: 'mutagen-engine' as const,
        channel: ENGINE_CHANNEL,
        processEnv,
      }).resolvedCurrentPath).toBe(expectedVersionPath);
      expect(readdirSync(join(homeDir, 'mutagen', 'versions'))).toEqual([ENGINE_VERSION]);

      // The versioned install closure is exactly the validated, signed
      // manifest plus the manager/agent binaries it describes.
      const artifactPaths = resolveMutagenEngineArtifactPaths(expectedVersionPath, ENGINE_TARGET_TRIPLE);
      for (const path of [artifactPaths.managerPath, artifactPaths.agentPath]) {
        expect(existsSync(path), path).toBe(true);
        // `assertMutagenEngineArtifactPayload` below re-checks executability on
        // POSIX; the mode assertion records the acceptance fact explicitly.
        if (process.platform !== 'win32') {
          expect(statSync(path).mode & 0o111, path).not.toBe(0);
        }
      }

      // Re-validate the installed payload through the existing artifact
      // validator, exactly as the daemon consumer does after acquisition.
      const installedManifest = await assertMutagenEngineArtifactPayload({
        payloadRoot: expectedVersionPath,
        targetTriple: ENGINE_TARGET_TRIPLE,
        engineVersion: ENGINE_VERSION,
      });

      // Manifest facts already required by production policy: pinned version,
      // fork release commit, upstream identity, protocol epoch, resolved
      // target triple, mixed MIT + SSPL license policy, and SSPL-enabled build.
      const expectedWatcher = ENGINE_TARGET_TRIPLE.startsWith('darwin-')
        ? 'fsevents'
        : ENGINE_TARGET_TRIPLE.startsWith('linux-')
          ? 'polling'
          : 'native';
      const executableSuffix = ENGINE_TARGET_TRIPLE === 'windows-amd64' ? '.exe' : '';
      expect(installedManifest).toMatchObject({
        component: 'mutagen-engine',
        engineVersion: ENGINE_VERSION,
        forkCommit: MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
        sourceRepository: 'https://github.com/happier-dev/mutagen',
        upstreamTag: MUTAGEN_ENGINE_UPSTREAM_TAG,
        upstreamCommit: MUTAGEN_ENGINE_UPSTREAM_COMMIT,
        protocolEpoch: MUTAGEN_ENGINE_PROTOCOL_EPOCH,
        targetTriple: ENGINE_TARGET_TRIPLE,
        managerPath: `bin/happier-mutagen${executableSuffix}`,
        agentPath: `bin/happier-mutagen-agent${executableSuffix}`,
        licensePolicy: 'mixed-mit-sspl',
        ssplEnabled: true,
        releaseTag: ENGINE_RELEASE_TAG,
        cgoEnabled: ENGINE_TARGET_TRIPLE.startsWith('darwin-'),
        watcher: expectedWatcher,
      });
      // The downloaded payload was validated during acquisition, too.
      expect(validator.validatedManifest()).toMatchObject({ engineVersion: ENGINE_VERSION });

      // Dedupe at the real network boundary: exactly one acquisition started
      // for the pinned engine release tag.
      expect(observedEngineReleaseTagFetches.tags.filter((tag) => tag === ENGINE_RELEASE_TAG)).toHaveLength(1);

      // Both installed binaries execute a harmless version command.
      const managerVersion = await execFileWithDeadline(artifactPaths.managerPath, ['version'], {
        timeout: 60_000,
        encoding: 'utf8',
      });
      expect(managerVersion.stdout.toString().trim()).toBe(EXPECTED_BINARY_VERSION);
      const agentVersion = await execFileWithDeadline(artifactPaths.agentPath, ['version'], {
        timeout: 60_000,
        encoding: 'utf8',
      });
      expect(agentVersion.stdout.toString().trim()).toBe(EXPECTED_BINARY_VERSION);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
