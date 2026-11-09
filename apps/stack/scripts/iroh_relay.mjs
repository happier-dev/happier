import './utils/env/env.mjs';
import { getRepoDir, getRootDir } from './utils/paths/paths.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { readRelayProfile, resolveRelayRequest } from './utils/server/infra/iroh/configuration.mjs';
import { ensureRelayBinary } from './utils/server/infra/iroh/binary.mjs';
import { inspectHostRelay, stopHostRelay } from './utils/server/infra/iroh/runtime.mjs';
import { TailscaleCommandError } from '@happier-dev/cli-common/tailscale';
import { relayStartupFailure } from './utils/server/infra/iroh/failure.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const action = argv.find(arg => !arg.startsWith('--')) ?? 'status';
  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { commands: ['install', 'status', 'stop'] },
      text: 'hstack tools iroh-relay install|status|stop [--json]' });
    return;
  }
  if (!['install', 'status', 'stop'].includes(action)) throw new Error('relay_command_invalid');
  if (resolveRelayRequest(process.env) === 'sandbox' && action !== 'status') throw new Error('relay_sandbox_disabled');
  let data;
  if (action === 'install') {
    const profile = await readRelayProfile(getRepoDir(getRootDir(import.meta.url), process.env));
    await ensureRelayBinary({ version: profile.version });
    data = { status: 'installed', version: profile.version };
  } else if (action === 'stop') data = await stopHostRelay();
  else data = await inspectHostRelay({ repoDir: getRepoDir(getRootDir(import.meta.url), process.env) });
  printResult({ json, data, text: JSON.stringify(data) });
  if (action === 'stop' && !data.stopped && data.reason !== 'not_started') process.exitCode = 1;
}

main().catch(error => {
  // Never surface captured tool output, certificates, approval URLs or env.
  const data = error instanceof TailscaleCommandError && error.failure
    ? relayStartupFailure(error, 'command')
    : { status: 'degraded', reason: error?.code ?? 'relay_command_failed' };
  if (wantsJson(process.argv.slice(2))) printResult({ json: true, data });
  else console.error(JSON.stringify(data));
  process.exitCode = 1;
});
