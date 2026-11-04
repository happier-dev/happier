import { request } from 'node:http';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { observeAgentIsolationNativeReadiness, type AgentIsolationReadinessSystem } from './agentIsolationReadiness';

// Native identity and ACL commands are OS boundaries. Socket authentication,
// frame parsing, readiness decisions and subprocess byte capture remain real.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => {
    const [command] = args;
    if (command === 'getent') return Reflect.apply(actual.execFile, undefined, [process.execPath,
      ['-e', 'process.stdout.write("happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\\n")'], ...args.slice(2)]);
    if (command !== 'setfacl') return Reflect.apply(actual.execFile, undefined, args);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
    return undefined;
  } };
});

it.skipIf(process.platform !== 'linux')('preserves binary launch challenges through real subprocess capture', async () => {
  const system: AgentIsolationReadinessSystem = { run: async (command, args, options) => {
    if (command === 'getent') return { stdout: args.includes('group')
      ? args.at(-1) === 'happier-agent' ? 'happier-agent:x:988:\n' : 'happier-workspace:x:1001:happier-agent\n'
      : 'happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
    if (!options?.inputBytes) throw new Error('Expected framed launch at the process boundary');
    const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes], { objectMode: false }));
    const header = frame.selectedMaterials.find(file => file.relativePath === 'files/headers');
    const challenge = frame.selectedMaterials.find(file => file.relativePath === 'files/challenge');
    if (!header || !challenge) throw new Error('Missing readiness material');
    const authorization = Buffer.from(header.contentBase64, 'base64').toString('utf8').trim().slice('Authorization: '.length);
    for (const value of [authorization, undefined]) await new Promise<void>((resolve, reject) => {
      const call = request({ socketPath: frame.args[7]!, path: '/readiness',
        ...(value ? { headers: { authorization: value } } : {}) }, response => {
        response.resume(); response.once('end', resolve);
      });
      call.once('error', reject); call.end();
    });
    return execFileWithDeadline(process.execPath, ['-e',
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(Buffer.from(process.argv[1], "base64")));',
      challenge.contentBase64], options);
  } };
  expect(await observeAgentIsolationNativeReadiness({ installedCli: '/opt/happier/cli/current/happier',
    roots: [], privateRoots: [], system })).toEqual({ kind: 'effective', platform: 'linux', agentUser: 'happier-agent' });
});
