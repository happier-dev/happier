import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { LumeNativeClient } from './nativeClient.js';
import type { LumePreparationBuildExecution } from './preparation.js';
import type { LumeSshHost } from './sshGuest.js';
import { observeLumeSshGuest, withLumeSshGuest, lumeProcessSucceeded, lumeShellQuote as quote } from './sshGuest.js';
import { Buffer } from 'node:buffer';
import { LUME_DEFAULT_LOGIN } from './schemas.js';

export function createLumePreparationBuildExecutor(input: Readonly<{
  native: LumeNativeClient; exec: ExecService;
  establishSshHostTrust(carrier: LumeSshHost): Promise<void>;
  waitForNativeObservation(): Promise<void>;
}>): LumePreparationBuildExecution {
  return async build => {
    let carrier: LumeSshHost;
    for (;;) {
      build.signal?.throwIfAborted();
      try {
        ({ carrier } = await observeLumeSshGuest({ ...input, resource: build.resource, signal: build.signal }));
        break;
      } catch (error) {
        build.signal?.throwIfAborted();
        if (!isPluginError(error) || (error.code !== 'native_not_ready' && error.code !== 'native_ssh_host_key_unavailable')) throw error;
        // Native port-22 readiness does not prove SSH can present a host key.
        // Only this credential-free observation waits; trust and guest writes
        // below run once, on the containing host operation's existing cadence.
        await input.waitForNativeObservation();
      }
    }
    await withLumeSshGuest({ ...input, carrier, signal: build.signal }, async guest => {
      const run = async (command: string, stdin?: Uint8Array) => {
        build.signal?.throwIfAborted();
        const result = await guest.runPassword(command, stdin);
        if (!lumeProcessSucceeded(result)) throw new PluginError({ code: 'lume_preparation_guest_failed' });
        return new TextDecoder().decode(result.stdout).trim();
      };
      const stage = await run('umask 077; mktemp -d /tmp/happier-build.XXXXXX');
      // The directory crosses the SSH process boundary before becoming an rm target.
      if (!/^\/tmp\/happier-build\.[A-Za-z0-9]+$/u.test(stage)) throw new PluginError({ code: 'lume_preparation_guest_failed' });
      let cleaned = false;
      try {
        for (const file of build.cli.files) {
          const destination = `${stage}/${file.path}`;
          const parent = destination.slice(0, destination.lastIndexOf('/'));
          await run(`umask 077; mkdir -p -- ${quote(parent)} && cat > ${quote(destination)}`, Buffer.from(file.contentsBase64, 'base64'));
        }
        await run(`set -e\ncd -- ${quote(stage)}\nsh -c ${quote(build.cli.installScript)}\nsh -c ${quote(build.setupScript ?? '')}`);
        // macOS launchd's sshd-keygen-wrapper regenerates missing host keys on
        // each clone's first connection. This must be the base's final SSH
        // connection: even a native GET probes port 22 and would recreate them.
        await run(`set -e\nrm -rf -- ${quote(stage)}\nsudo -S -p '' /bin/sh -c ${quote('rm -f /etc/ssh/ssh_host_*_key* /System/Volumes/Preboot/*/var/db/sshd/ssh_host_*_key* && sync')}`,
          new TextEncoder().encode(`${LUME_DEFAULT_LOGIN.password}\n`));
        cleaned = true;
      } finally {
        // Native cleanup still owns deleting the VM if cancellation prevents this best-effort stage removal.
        if (!cleaned) await guest.runPassword(`rm -rf -- ${quote(stage)}`).catch(() => {});
      }
    });
  };
}
