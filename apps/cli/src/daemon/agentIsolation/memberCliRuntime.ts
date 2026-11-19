import { createHash } from 'node:crypto';
import { readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

export function resolveAgentIsolationMemberCliRuntime(installedCli: string) {
  const root = `/opt/happier-member-cli-${createHash('sha256').update(installedCli).digest('hex')}`;
  return { sourceCli: installedCli, root, executable: join(root, 'current', basename(installedCli)) };
}

export type AgentIsolationMemberCliRuntime = ReturnType<typeof resolveAgentIsolationMemberCliRuntime>;

async function readInstalledPayload(runtime: AgentIsolationMemberCliRuntime) {
  const installRoot = await realpath(dirname(dirname(runtime.sourceCli)));
  const payload = await realpath(dirname(runtime.sourceCli));
  if (payload !== join(installRoot, 'current') && dirname(payload) !== join(installRoot, 'versions')) {
    throw new Error('Agent isolation requires an installed CLI payload');
  }
  const binary = join(payload, basename(runtime.sourceCli));
  if (await realpath(binary) !== binary) throw new Error('Managed CLI executable must be part of its installed payload');
  const { dev, ino, mtimeNs, size, mode } = await stat(binary, { bigint: true });
  if ((mode & 0o170000n) !== 0o100000n || (mode & 0o111n) === 0n) throw new Error('Managed CLI is not executable');
  const generation = createHash('sha256').update(JSON.stringify([payload, String(dev), String(ino), String(mtimeNs), String(size)])).digest('hex');
  return { payload, generation };
}

export async function isAgentIsolationMemberCliCurrent(runtime: AgentIsolationMemberCliRuntime): Promise<boolean> {
  try {
    const { generation } = await readInstalledPayload(runtime);
    return await readlink(dirname(runtime.executable)) === generation;
  } catch { return false; }
}

// The elevated setup interpreter checks and applies these fixed bytes. The
// protected directory step owns destination ancestry. Publish the payload
// atomically and keep its previous generation, as the managed installer does.
const publishMemberCli = `set -eu
PATH=/usr/bin:/bin
export PATH
mode=$1 root=$2 source=$3 generation=$4 executable=$5
target=$root/$generation
[ -d "$source" ] && [ -f "$source/$executable" ] || exit 2
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
if [ "$incumbent" = "$generation" ] && [ -x "$target/$executable" ]; then exit 0; fi
[ "$mode" = apply ] || exit 1
stage=$(mktemp -d -- "$root/.payload.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 2' HUP INT TERM
if [ ! -d "$target" ]; then
  umask 022
  cp -RP --reflink=auto -- "$source" "$stage/payload"
  [ -z "$(find "$stage/payload" ! -type d ! -type f ! -type l -print -quit)" ] || exit 2
  chmod -R a+rX,go-w,u-s,g-s -- "$stage/payload"
  [ -x "$stage/payload/$executable" ] || exit 2
  mv -T -- "$stage/payload" "$target" || [ -d "$target" ]
fi
[ ! -L "$target" ] && [ -x "$target/$executable" ] || exit 2
ln -s -- "$generation" "$stage/current"
mv -Tf -- "$stage/current" "$root/current"
if [ -n "$incumbent" ] && [ "$incumbent" != "$generation" ]; then
  older=$(readlink -- "$root/previous" || :)
  ln -s -- "$incumbent" "$stage/previous"
  mv -Tf -- "$stage/previous" "$root/previous"
  if [ "$older" != "$generation" ] && [ "$older" != "$incumbent" ] &&
      printf '%s\\n' "$older" | grep -Eq '^[0-9a-f]{64}$'; then
    rm -rf -- "$root/$older"
  fi
fi
`;

export async function buildAgentIsolationMemberCliRuntimeSteps(runtime: AgentIsolationMemberCliRuntime): Promise<MachineRecipeStepV1[]> {
  const { payload, generation } = await readInstalledPayload(runtime);
  const args = (mode: 'check' | 'apply') => [
    '-c', publishMemberCli, 'happier-member-cli-runtime', mode, runtime.root, payload, generation, basename(runtime.executable),
  ];
  return [
    { id: 'member-cli-root', kind: 'directory', path: runtime.root, owner: 'root', group: 'root', mode: 0o755, protectedAncestors: true },
    { id: 'member-cli-payload', kind: 'command', executable: '/bin/sh', args: args('apply'),
      check: { executable: '/bin/sh', args: args('check'), unsatisfiedExitCodes: [1] } },
  ];
}
