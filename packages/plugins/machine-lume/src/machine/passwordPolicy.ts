import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService, PluginExecSpawnRequest, PluginProcessHandle } from '@happier-dev/plugin-sdk/exec';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { LUME_DEFAULT_LOGIN } from './schemas.js';

function quote(value: string) { return `'${value.replace(/'/gu, "'\\''")}'`; }

/** macOS launchd starts sshd per connection. Keep the root session open until
 * fresh key authentication succeeds, restoring the prior drop-in on failure.
 * The image password enters sudo only through this session's private stdin.
 */
export async function hardenMacosSshPasswordLogin(input: Readonly<{
  exec: ExecService; request: PluginExecSpawnRequest; user: string;
  proveKey(): Promise<boolean>; signal?: AbortSignal;
}>): Promise<void> {
  const root = `set -eu
umask 077
policy=/etc/ssh/sshd_config.d/000-happier-key-only.conf
mkdir -p /etc/ssh/sshd_config.d
scratch=$(mktemp -d /etc/ssh/sshd_config.d/.happier-key-only.XXXXXX)
had_policy=no
committed=no
cleanup() {
  if [ "$committed" != yes ]; then
    if [ "$had_policy" = yes ]; then mv "$scratch/prior" "$policy"; else rm -f "$policy"; fi
  fi
  rm -rf "$scratch"
}
# A failed backup must leave the original alone.
if [ -e "$policy" ]; then cp -p "$policy" "$scratch/prior" || { rm -rf "$scratch"; exit 1; }; had_policy=yes; fi
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > "$scratch/next"
chmod 644 "$scratch/next"
mv "$scratch/next" "$policy"
/usr/sbin/sshd -t
user=${quote(input.user)}
# sudo resets the environment; the unprivileged shell passes SSH_CONNECTION
# as one non-secret argument rather than depending on sudo's environment policy.
set -- $1
settings=$(/usr/sbin/sshd -T -C "user=$user,host=$1,addr=$1,laddr=$3,lport=$4")
printf '%s\n' "$settings" | grep -qx 'passwordauthentication no'
printf '%s\n' "$settings" | grep -qx 'kbdinteractiveauthentication no'
printf 'READY\n'
IFS= read -r decision
[ "$decision" = COMMIT ]
committed=yes`;
  const command = `IFS= read -r begin && [ "$begin" = BEGIN ] || exit 1
policy_script=${quote(root)}
if sudo -n true 2>/dev/null; then
  sudo -n /bin/sh -c "$policy_script" -- "$SSH_CONNECTION"
else
  printf 'PASSWORD\n'
  sudo -S -p '' /bin/sh -c "$policy_script" -- "$SSH_CONNECTION"
fi`;
  let handle: PluginProcessHandle | undefined;
  let subscription: Disposable | undefined;
  try {
    handle = await input.exec.spawn({ ...input.request, args: [...input.request.args ?? [], command] }, { signal: input.signal });
    const process = handle;
    const ended = process.wait();
    let resolveReady: () => void = () => {};
    let rejectReady: (reason: unknown) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ended.then(() => rejectReady(new Error('policy process ended')), rejectReady);
    let pending = '';
    const decoder = new TextDecoder();
    let passwordWrite: Promise<void> | undefined;
    subscription = process.onOutput(chunk => {
      if (chunk.stream !== 'stdout') return;
      pending += decoder.decode(chunk.data, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (line === 'PASSWORD' && !passwordWrite) {
          const bytes = new TextEncoder().encode(`${LUME_DEFAULT_LOGIN.password}\n`);
          passwordWrite = process.write(bytes).finally(() => bytes.fill(0));
          void passwordWrite.catch(rejectReady);
        } else if (line === 'READY') resolveReady();
      }
    });
    await process.write(new TextEncoder().encode('BEGIN\n'));
    await ready;
    await passwordWrite;
    if (!await input.proveKey()) throw new PluginError({ code: 'native_ssh_post_policy_key_failed' });
    await process.write(new TextEncoder().encode('COMMIT\n'));
    await process.closeStdin();
    const result = await ended;
    if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
      || result.termination.requestedBy.kind !== 'none' || result.stdoutTruncated || result.stderrTruncated) {
      throw new Error('policy process failed');
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof PluginError && error.code === 'native_ssh_post_policy_key_failed') throw error;
    throw new PluginError({ code: 'native_ssh_password_policy_failed' });
  } finally {
    subscription?.dispose();
    if (handle) {
      // EOF rolls back an uncommitted shell. Settle cleanup before returning;
      // transport errors must never leak native output or replace typed causes.
      await handle.closeStdin().catch(() => {});
      await handle.wait().catch(() => {});
      await handle.dispose().catch(() => {});
    }
  }
}
