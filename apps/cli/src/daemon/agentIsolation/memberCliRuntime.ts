import { createHash } from 'node:crypto';
import { constants, lstatSync, readlinkSync, type BigIntStats, type Stats } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  assertMutagenEngineArtifactPayload,
  MUTAGEN_ENGINE_VERSION,
  resolveMutagenEngineArtifactPaths,
  resolveMutagenEngineArtifactTarget,
  type FirstPartyVersionRootIdentity,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh/shellQuote';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

const memberCliParent = '/opt';
const memberCliPrefix = 'happier-member-cli-';
const memberMutagenDirName = '.happier-member-mutagen';
const memberMutagenAgentName = 'happier-mutagen-agent';
const generationPattern = /^[0-9a-f]{64}$/u;
const maxVerifiedCacheEntries = 16;

type VerifiedInstalledMutagenCacheEntry = Readonly<{
  fingerprint: string;
  agentSha256: string;
}>;

type VerifiedPublishedMutagenCacheEntry = Readonly<{
  fingerprint: string;
  expectedSha256: string;
  expectedOwnerUid: number;
}>;

const verifiedInstalledMutagenCache = new Map<string, VerifiedInstalledMutagenCacheEntry>();
const verifiedPublishedMutagenCache = new Map<string, VerifiedPublishedMutagenCacheEntry>();

function setBoundedCacheEntry<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxVerifiedCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function formatStatFingerprint(entry: Pick<BigIntStats, 'dev' | 'ino' | 'mtimeNs' | 'ctimeNs' | 'size'>): string {
  return `${entry.dev}:${entry.ino}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.size}`;
}

/** OS boundary override for non-root filesystem tests; production callers omit this. */
export type AgentIsolationMemberRuntimeBoundary = Readonly<{
  parentDir?: string;
  expectedOwnerUid?: number;
  platform?: NodeJS.Platform;
}>;

export function resolveAgentIsolationMemberCliRuntime(
  installedCli: string,
  options?: Readonly<{ sourceMutagenInstallRoot?: string }>,
) {
  const root = join(memberCliParent, memberCliPrefix + createHash('sha256').update(installedCli).digest('hex'));
  return {
    sourceCli: installedCli,
    root,
    executable: join(root, 'current', basename(installedCli)),
    ...(options?.sourceMutagenInstallRoot ? { sourceMutagenInstallRoot: options.sourceMutagenInstallRoot } : {}),
  };
}

export type AgentIsolationMemberCliRuntime = Readonly<{
  sourceCli: string;
  root: string;
  executable: string;
  sourceMutagenInstallRoot?: string;
}>;

export function resolveAgentIsolationSharedLaunchCli(input: Readonly<{
  installedCli: string;
  sharedCliRuntime?: AgentIsolationMemberCliRuntime;
}>): string {
  return input.sharedCliRuntime?.executable ?? input.installedCli;
}

function isProtectedDirectory(path: string, expectedOwnerUid = 0): boolean {
  const entry = lstatSync(path);
  return entry.isDirectory() && entry.uid === expectedOwnerUid && (entry.mode & 0o022) === 0;
}

function isProtectedMemberExecutableStat(
  entry: Pick<Stats, 'isFile'> & Readonly<{ uid: number | bigint; mode: number | bigint }>,
  expectedOwnerUid = 0,
): boolean {
  const uid = Number(entry.uid);
  const mode = Number(entry.mode);
  return entry.isFile()
    && uid === expectedOwnerUid
    && (mode & 0o7022) === 0
    && (mode & 0o555) === 0o555;
}

function readMemberCliStore(runtimeRoot: string, boundary?: AgentIsolationMemberRuntimeBoundary): string | null {
  const store = dirname(runtimeRoot);
  const storeName = basename(store);
  const platform = boundary?.platform ?? process.platform;
  const parentDir = boundary?.parentDir ?? memberCliParent;
  if (platform !== 'linux' || dirname(store) !== parentDir
    || !storeName.startsWith(memberCliPrefix) || !generationPattern.test(storeName.slice(memberCliPrefix.length))) return null;
  return store;
}

export function isAgentIsolationMemberCliRuntimeRoot(
  runtimeRoot: string,
  boundary?: AgentIsolationMemberRuntimeBoundary,
): boolean {
  return readMemberCliStore(runtimeRoot, boundary) !== null;
}

/** Read the publisher's root-owned generation store, using its relative pointers. */
export function resolveAgentIsolationMemberCliVersionRoot(
  runtimeRoot: string,
  retainedVersionRootId?: string,
  boundary?: AgentIsolationMemberRuntimeBoundary,
): FirstPartyVersionRootIdentity | null {
  const store = readMemberCliStore(runtimeRoot, boundary);
  if (!store) return null;
  const parentDir = boundary?.parentDir ?? memberCliParent;
  const expectedOwnerUid = boundary?.expectedOwnerUid ?? 0;
  try {
    if (!isProtectedDirectory('/', 0) || ![parentDir, store].every(path => isProtectedDirectory(path, expectedOwnerUid))) return null;
    const executingName = basename(runtimeRoot);
    const executingId = executingName === 'current' || executingName === 'previous'
      ? readlinkSync(runtimeRoot) : executingName;
    if (!generationPattern.test(executingId) || !isProtectedDirectory(join(store, executingId), expectedOwnerUid)) return null;
    const versionRootId = retainedVersionRootId ?? executingId;
    if (!generationPattern.test(versionRootId)) return null;
    const root = join(store, versionRootId);
    if (versionRootId !== executingId && !isProtectedDirectory(root, expectedOwnerUid)) return null;
    return Object.freeze({ root, versionRootId });
  } catch {
    return null;
  }
}

/** Resolve and verify the root-owned, non-writable Mutagen agent published inside the member CLI store. */
export async function resolveAgentIsolationMemberMutagenAgent(
  runtimeRoot: string,
  options: Readonly<{
    expectedSha256: string;
    boundary?: AgentIsolationMemberRuntimeBoundary;
    useVerifiedDigestCache?: boolean;
  }>,
): Promise<string | null> {
  const version = resolveAgentIsolationMemberCliVersionRoot(runtimeRoot, undefined, options.boundary);
  if (!version || !generationPattern.test(options.expectedSha256)) return null;
  const expectedOwnerUid = options.boundary?.expectedOwnerUid ?? 0;
  const mutagenDir = join(version.root, memberMutagenDirName);
  const agentPath = join(mutagenDir, memberMutagenAgentName);
  try {
    if (!isProtectedDirectory(mutagenDir, expectedOwnerUid)) {
      verifiedPublishedMutagenCache.delete(agentPath);
      return null;
    }
    if (!isProtectedMemberExecutableStat(lstatSync(agentPath), expectedOwnerUid)) {
      verifiedPublishedMutagenCache.delete(agentPath);
      return null;
    }
    const handle = await open(agentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fdStat = await handle.stat({ bigint: true });
      if (!isProtectedMemberExecutableStat(fdStat, expectedOwnerUid)) {
        verifiedPublishedMutagenCache.delete(agentPath);
        return null;
      }
      const fingerprint = formatStatFingerprint(fdStat);
      if (options.useVerifiedDigestCache) {
        const cached = verifiedPublishedMutagenCache.get(agentPath);
        if (cached
          && cached.fingerprint === fingerprint
          && cached.expectedSha256 === options.expectedSha256
          && cached.expectedOwnerUid === expectedOwnerUid) {
          return agentPath;
        }
      }
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead <= 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (hash.digest('hex') !== options.expectedSha256) {
        verifiedPublishedMutagenCache.delete(agentPath);
        return null;
      }
      if (options.useVerifiedDigestCache) {
        setBoundedCacheEntry(verifiedPublishedMutagenCache, agentPath, {
          fingerprint,
          expectedSha256: options.expectedSha256,
          expectedOwnerUid,
        });
      }
      return agentPath;
    } finally {
      await handle.close();
    }
  } catch {
    verifiedPublishedMutagenCache.delete(agentPath);
    return null;
  }
}

/** Resolve the verified Mutagen agent binary for an isolated Linux member.
 * When the host launches members from a published root-owned CLI store, fail
 * closed unless that store contains a verified root-owned non-writable copy
 * matching the host's verified agent binary. */
export async function resolveAgentIsolationMemberNativeAgent(input: Readonly<{
  hostAgent: Readonly<{ executablePath: string; sha256?: string }>;
  memberCliExecutablePath?: string;
  boundary?: AgentIsolationMemberRuntimeBoundary;
}>): Promise<Readonly<{ executablePath: string }>> {
  if (!input.memberCliExecutablePath) return { executablePath: input.hostAgent.executablePath };
  const runtimeRoot = dirname(input.memberCliExecutablePath);
  if (!isAgentIsolationMemberCliRuntimeRoot(runtimeRoot, input.boundary)) {
    return { executablePath: input.hostAgent.executablePath };
  }
  const expectedSha256 = input.hostAgent.sha256?.trim();
  const published = expectedSha256 && generationPattern.test(expectedSha256)
    ? await resolveAgentIsolationMemberMutagenAgent(runtimeRoot, {
      expectedSha256,
      ...(input.boundary ? { boundary: input.boundary } : {}),
    })
    : null;
  if (!published) {
    throw new PluginError({
      code: 'agent_isolation_unavailable',
      message: 'The managed member Mutagen agent is unavailable',
      retryable: false,
      details: { reason: 'payload_not_accessible', phase: 'native_execution_preparation', readinessCode: 'payload_not_accessible' },
    });
  }
  return { executablePath: published };
}

async function readInstalledMutagenAgent(
  sourceMutagenInstallRoot?: string,
  options?: Readonly<{ useCache?: boolean }>,
) {
  if (!sourceMutagenInstallRoot) return null;
  try {
    const installRoot = await realpath(sourceMutagenInstallRoot);
    const payload = await realpath(join(installRoot, 'current'));
    if (payload !== join(installRoot, 'current') && dirname(payload) !== join(installRoot, 'versions')) return null;
    const targetTriple = resolveMutagenEngineArtifactTarget();
    const paths = resolveMutagenEngineArtifactPaths(payload, targetTriple);
    if (await realpath(paths.agentPath) !== paths.agentPath) return null;
    const [
      agentStat,
      managerStat,
      manifestStat,
      checksumsStat,
      mutagenLicenseStat,
      ssplLicenseStat,
      noticesStat,
    ] = await Promise.all([
      lstat(paths.agentPath, { bigint: true }),
      lstat(paths.managerPath, { bigint: true }),
      lstat(paths.manifestPath, { bigint: true }),
      lstat(paths.checksumsPath, { bigint: true }),
      lstat(paths.mutagenLicensePath, { bigint: true }),
      lstat(paths.ssplLicensePath, { bigint: true }),
      lstat(paths.thirdPartyNoticesPath, { bigint: true }),
    ]);
    if ((agentStat.mode & 0o170000n) !== 0o100000n || (agentStat.mode & 0o111n) === 0n) return null;
    const fingerprint = JSON.stringify([
      installRoot,
      payload,
      targetTriple,
      MUTAGEN_ENGINE_VERSION,
      formatStatFingerprint(agentStat),
      formatStatFingerprint(managerStat),
      formatStatFingerprint(manifestStat),
      formatStatFingerprint(checksumsStat),
      formatStatFingerprint(mutagenLicenseStat),
      formatStatFingerprint(ssplLicenseStat),
      formatStatFingerprint(noticesStat),
    ]);
    const cached = options?.useCache ? verifiedInstalledMutagenCache.get(sourceMutagenInstallRoot) : undefined;
    if (cached && cached.fingerprint === fingerprint) {
      return {
        payload,
        agentPath: paths.agentPath,
        agentSha256: cached.agentSha256,
        dev: agentStat.dev,
        ino: agentStat.ino,
        mtimeNs: agentStat.mtimeNs,
        size: agentStat.size,
      };
    }
    const manifest = await assertMutagenEngineArtifactPayload({
      payloadRoot: payload,
      targetTriple,
      engineVersion: MUTAGEN_ENGINE_VERSION,
    });
    setBoundedCacheEntry(verifiedInstalledMutagenCache, sourceMutagenInstallRoot, {
      fingerprint,
      agentSha256: manifest.agentSha256,
    });
    return {
      payload,
      agentPath: paths.agentPath,
      agentSha256: manifest.agentSha256,
      dev: agentStat.dev,
      ino: agentStat.ino,
      mtimeNs: agentStat.mtimeNs,
      size: agentStat.size,
    };
  } catch {
    verifiedInstalledMutagenCache.delete(sourceMutagenInstallRoot);
    return null;
  }
}

async function readInstalledPayload(
  runtime: AgentIsolationMemberCliRuntime,
  options?: Readonly<{ useMutagenCache?: boolean }>,
) {
  const installRoot = await realpath(dirname(dirname(runtime.sourceCli)));
  const payload = await realpath(dirname(runtime.sourceCli));
  if (payload !== join(installRoot, 'current') && dirname(payload) !== join(installRoot, 'versions')) {
    throw new Error('Agent isolation requires an installed CLI payload');
  }
  const binary = join(payload, basename(runtime.sourceCli));
  if (await realpath(binary) !== binary) throw new Error('Managed CLI executable must be part of its installed payload');
  const { dev, ino, mtimeNs, size, mode } = await stat(binary, { bigint: true });
  if ((mode & 0o170000n) !== 0o100000n || (mode & 0o111n) === 0n) throw new Error('Managed CLI is not executable');
  const mutagen = await readInstalledMutagenAgent(runtime.sourceMutagenInstallRoot, {
    ...(options?.useMutagenCache ? { useCache: true } : {}),
  });
  const generationInput = mutagen
    ? [payload, String(dev), String(ino), String(mtimeNs), String(size),
        mutagen.payload, mutagen.agentSha256, String(mutagen.dev), String(mutagen.ino), String(mutagen.mtimeNs), String(mutagen.size)]
    : [payload, String(dev), String(ino), String(mtimeNs), String(size)];
  const generation = createHash('sha256').update(JSON.stringify(generationInput)).digest('hex');
  return { payload, generation, mutagen };
}

export async function isAgentIsolationMemberCliCurrent(
  runtime: AgentIsolationMemberCliRuntime,
  boundary?: AgentIsolationMemberRuntimeBoundary,
): Promise<boolean> {
  try {
    const { generation, mutagen } = await readInstalledPayload(runtime, { useMutagenCache: true });
    const runtimeRoot = dirname(runtime.executable);
    if (await readlink(runtimeRoot) !== generation) return false;
    if (mutagen && isAgentIsolationMemberCliRuntimeRoot(runtimeRoot, boundary)) {
      return await resolveAgentIsolationMemberMutagenAgent(runtimeRoot, {
        expectedSha256: mutagen.agentSha256,
        ...(boundary ? { boundary } : {}),
        useVerifiedDigestCache: true,
      }) !== null;
    }
    return true;
  } catch { return false; }
}

// The elevated setup interpreter checks and applies these fixed bytes. The
// protected directory step owns destination ancestry. Publish the payload
// atomically and keep its previous generation, as the managed installer does.
const publishMemberCli = `set -eu
PATH=/usr/bin:/bin
export PATH
mode=$1 root=$2 source=$3 generation=$4 executable=$5 mutagen_agent=\${6:-} mutagen_sha256=\${7:-}
target=$root/$generation
mutagen_rel=${memberMutagenDirName}/${memberMutagenAgentName}
check_published_mutagen() {
  [ -z "$mutagen_agent" ] && return 0
  dir=$1/${memberMutagenDirName}
  bin=$1/$mutagen_rel
  [ ! -L "$dir" ] && [ -d "$dir" ] || return 1
  [ "$(stat -c '%u:%g:%a' -- "$dir")" = 0:0:555 ] || return 1
  [ ! -L "$bin" ] && [ -f "$bin" ] && [ -x "$bin" ] || return 1
  [ "$(stat -c '%u:%g:%a' -- "$bin")" = 0:0:555 ] || return 1
  actual_sha=$(sha256sum -- "$bin") || return 1
  actual_sha=\${actual_sha%% *}
  [ "$actual_sha" = "$mutagen_sha256" ]
}
[ -d "$source" ] && [ -f "$source/$executable" ] || exit 2
if [ -n "$mutagen_agent" ]; then
  [ ! -L "$mutagen_agent" ] && [ -f "$mutagen_agent" ] && [ -x "$mutagen_agent" ] || exit 2
  printf '%s\\n' "$mutagen_sha256" | grep -Eq '${generationPattern.source}' || exit 2
fi
if [ ! -e "$root" ] && [ ! -L "$root" ]; then exit 1; fi
[ ! -L "$root" ] && [ "$(stat -c '%u:%g' -- "$root")" = 0:0 ] || exit 2
if [ "$(stat -c '%a' -- "$root")" != 755 ]; then
  [ "$mode" = check ] && exit 1
  exit 2
fi
if [ "$mode" = apply ]; then
  # Concurrent member setup uses the same root and must serialize rotation.
  exec 9<"$root"
  flock -x 9
fi
incumbent=$(readlink -- "$root/current" || :)
if [ "$incumbent" = "$generation" ] && [ -x "$target/$executable" ] && check_published_mutagen "$target"; then exit 0; fi
[ "$mode" = apply ] || exit 1
stage=$(mktemp -d -- "$root/.payload.XXXXXXXX")
trap 'chmod -R u+w -- "$stage" 2>/dev/null || :; rm -rf -- "$stage"' EXIT
trap 'exit 2' HUP INT TERM
if [ ! -d "$target" ]; then
  umask 022
  cp -RP --reflink=auto -- "$source" "$stage/payload"
  [ ! -L "$stage/payload" ] && [ -d "$stage/payload" ] || exit 2
  if [ -n "$mutagen_agent" ]; then
    [ ! -e "$stage/payload/${memberMutagenDirName}" ] && [ ! -L "$stage/payload/${memberMutagenDirName}" ] || exit 2
    chmod u+w -- "$stage/payload"
    mkdir -- "$stage/payload/${memberMutagenDirName}"
    cp -RP --reflink=auto -- "$mutagen_agent" "$stage/payload/$mutagen_rel"
    [ ! -L "$stage/payload/$mutagen_rel" ] && [ -f "$stage/payload/$mutagen_rel" ] || exit 2
  fi
  [ -z "$(find "$stage/payload" ! -type d ! -type f ! -type l -print -quit)" ] || exit 2
  chmod -R a+rX,go-w,u-s,g-s -- "$stage/payload"
  if [ -n "$mutagen_agent" ]; then
    chmod 0555 -- "$stage/payload/${memberMutagenDirName}" "$stage/payload/$mutagen_rel"
    check_published_mutagen "$stage/payload" || exit 2
  fi
  [ -x "$stage/payload/$executable" ] || exit 2
  mv -T -- "$stage/payload" "$target" || [ -d "$target" ]
fi
[ ! -L "$target" ] && [ -x "$target/$executable" ] && check_published_mutagen "$target" || exit 2
ln -s -- "$generation" "$stage/current"
mv -Tf -- "$stage/current" "$root/current"
if [ -n "$incumbent" ] && [ "$incumbent" != "$generation" ]; then
  older=$(readlink -- "$root/previous" || :)
  ln -s -- "$incumbent" "$stage/previous"
  mv -Tf -- "$stage/previous" "$root/previous"
  if [ "$older" != "$generation" ] && [ "$older" != "$incumbent" ] &&
      printf '%s\\n' "$older" | grep -Eq '${generationPattern.source}'; then
    chmod -R u+w -- "$root/$older" 2>/dev/null || :
    rm -rf -- "$root/$older"
  fi
fi
`;

export async function buildAgentIsolationMemberCliRuntimeSteps(runtime: AgentIsolationMemberCliRuntime): Promise<MachineRecipeStepV1[]> {
  const { payload, generation, mutagen } = await readInstalledPayload(runtime);
  const script = (mode: 'check' | 'apply') => {
    const args = [mode, runtime.root, payload, generation, basename(runtime.executable),
      ...(mutagen ? [mutagen.agentPath, mutagen.agentSha256] : [])];
    return `set -- ${args.map(safeBashSingleQuote).join(' ')}\n${publishMemberCli}`;
  };
  return [
    { id: 'member-cli-root', kind: 'directory', path: runtime.root, owner: 'root', group: 'root', mode: 0o755, protectedAncestors: true },
    { id: 'member-cli-payload', kind: 'script', shell: 'sh', body: script('apply'),
      check: { body: script('check'), unsatisfiedExitCodes: [1] } },
  ];
}
