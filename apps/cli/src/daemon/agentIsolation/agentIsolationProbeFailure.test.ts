import { userInfo } from 'node:os';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { resolveBunCompilerCommand } from '../../../../../packages/cli-common/src/componentArtifacts/commands';
import { withTempDir } from '@/testkit/fs/tempDir';
import { encodeAgentLaunchFrame, readAgentLaunchFrame } from './agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from './provisioning';
import { observeAgentIsolationMemberLaunchReadiness, type AgentIsolationReadinessSystem } from './agentIsolationReadiness';

const current = userInfo();
const bunCommand = (() => {
  try {
    // The test home is isolated; runtime discovery belongs to the real OS user.
    return resolveBunCompilerCommand({ processEnv: { ...process.env, HOME: current.homedir } });
  } catch { return undefined; }
})();
it.skipIf(process.platform !== 'linux' || current.uid <= 0 || current.gid <= 0).each([
  { runtime: 'Node', command: process.execPath, sourceArgs: [
    '--import', fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
  ], preload: '--import' },
  ...(bunCommand ? [{ runtime: 'Bun', command: bunCommand,
    sourceArgs: ['--conditions=happier-source'], preload: '--preload' },
    { runtime: 'Bun shell', command: bunCommand, sourceArgs: [], preload: '--preload' }] : []),
])('preserves the exact native probe marker through the $runtime finite command boundary', async runtime => {
  await withTempDir('member-probe-entry-', async directory => {
    const home = join(directory, 'member');
    await mkdir(home, { mode: 0o700 });
    let nativeFrame: Awaited<ReturnType<typeof readAgentLaunchFrame>> | undefined;
    await observeAgentIsolationMemberLaunchReadiness({ installedCli: '/usr/bin/true',
      memberIdentity: { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
        requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
        username: 'happier-agent', agentUid: current.uid, agentGid: current.gid, home },
      // Capture the canonical host-authored command at its OS launch boundary.
      // The temporary account below uses the existing shared RunAs identity.
      system: { run: async (_command, _args, options) => {
        nativeFrame = await readAgentLaunchFrame(Readable.from([options!.inputBytes!], { objectMode: false }));
        return { stdout: Buffer.from('member-native-ready\n'), stderr: Buffer.alloc(0) };
      } },
    });
    if (!nativeFrame || 'action' in nativeFrame) throw new Error('Native probe frame unavailable');
    const { nativeIdentity: _memberIdentity, ...selectedFrame } = nativeFrame;
    const identityBin = join(directory, 'identity-bin');
    await mkdir(identityBin);
    // The executor's ordinary account can have supplementary groups. Model
    // the selected member's single group at the OS id boundary only.
    await writeFile(join(identityBin, 'id'), `#!/bin/sh
if [ "$1" = -G ]; then printf '%s\\n' '${current.gid}'; else exec /usr/bin/id "$@"; fi
`, { mode: 0o755 });
    const probeFrame = { ...selectedFrame,
      environment: { ...selectedFrame.environment, PATH: `${identityBin}:/usr/bin:/bin` } };
    const identityAdapter = join(directory, 'identity.mjs');
    // Only the OS account identity is simulated. The real early CLI entry,
    // frame parser, material owner, child supervisor and pipe capture execute.
    await writeFile(identityAdapter, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const actual = os.userInfo();
os.userInfo = () => ({ ...actual, username: 'happier-agent', homedir: ${JSON.stringify(home)} });
syncBuiltinESMExports();\n`);
    let entryArgs = [
      ...runtime.sourceArgs, runtime.preload, identityAdapter,
      fileURLToPath(new URL('../../index.ts', import.meta.url)), 'agent-launch',
    ];
    if (runtime.runtime === 'Bun') {
      const entry = join(directory, 'shim.cjs');
      // Reuse the native shim fixture's CJS OS adapter: Bun's named builtin
      // ESM exports do not observe syncBuiltinESMExports in a source preload.
      await build({ stdin: { contents: `
        import { handleAgentLaunchCliCommand } from ${JSON.stringify(fileURLToPath(new URL('../../cli/commands/agentLaunch.ts', import.meta.url)))};
        void handleAgentLaunchCliCommand({ args: ['agent-launch'], rawArgv: process.argv, terminalRuntime: null });
      `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) },
        outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
        define: { 'import.meta.url': JSON.stringify(new URL('../../cli/commands/agentLaunch.ts', import.meta.url).href) },
        tsconfig: fileURLToPath(new URL('../../../tsconfig.runtime.json', import.meta.url)),
        banner: { js: `
          require = require('node:module').createRequire(${JSON.stringify(fileURLToPath(new URL('../../../package.json', import.meta.url)))});
          const os = require('node:os'), current = os.userInfo();
          os.userInfo = () => ({ ...current, username: 'happier-agent', homedir: ${JSON.stringify(home)} });
        ` },
      });
      entryArgs = [entry];
    }
    // A native daemon also captures the shim with Bun's child_process adapter.
    // Keep that outer capture real instead of testing only a Bun child of Node.
    const captureEntry = join(directory, 'capture.mjs');
    const directShell = runtime.runtime === 'Bun shell';
    await writeFile(captureEntry, `import { execFileWithDeadline } from ${JSON.stringify(fileURLToPath(new URL('../../../../../packages/cli-common/src/process/execFileWithDeadline.ts', import.meta.url)))};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
process.umask(0o002);
try {
const result = await execFileWithDeadline(${JSON.stringify(directShell ? probeFrame.executable : runtime.command)}, ${JSON.stringify(directShell ? probeFrame.args : entryArgs)}, {
  inputBytes: Buffer.concat(chunks), ${directShell ? `cwd: ${JSON.stringify(home)}, env: ${JSON.stringify({ ...probeFrame.environment, HOME: home, USER: 'happier-agent' })},` : ''}
});
process.stdout.write(JSON.stringify({ exitCode: 0, stdoutLength: Buffer.byteLength(result.stdout),
  marker: Buffer.from(result.stdout).equals(Buffer.from('member-native-ready\\n')), stderrLength: Buffer.byteLength(result.stderr) }));
} catch (error) {
process.stdout.write(JSON.stringify({ exitCode: error.code, stdoutLength: Buffer.byteLength(error.stdout ?? ''),
  marker: Buffer.from(error.stdout ?? '').equals(Buffer.from('member-native-ready\\n')),
  stdinFailed: String(error.stderr ?? '').includes('stage=stdin') }));
}\n`);
    const result = await execFileWithDeadline(runtime.command, runtime.runtime !== 'Node' ? [captureEntry] : entryArgs,
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      inputBytes: encodeAgentLaunchFrame(probeFrame) });
    if (runtime.runtime === 'Node') expect(Buffer.from(result.stdout)).toEqual(Buffer.from('member-native-ready\n'));
    else expect(JSON.parse(String(result.stdout))).toEqual({ exitCode: 0, stdoutLength: 20, marker: true, stderrLength: 0 });
    expect(Buffer.from(result.stderr)).toEqual(Buffer.alloc(0));
  });
// The real finite command owns completion. Cold source entry loading alone
// exceeded the unit fixture's cutoff on the shared checkout; it is not a
// launch-probe deadline and must not preempt this output assertion.
}, 0);
it.skipIf(process.platform !== 'linux' || current.uid <= 0 || current.gid <= 0)('retains the actual fixed probe check, exit and selected identity without native output', async () => {
  await withTempDir('member-probe-cause-', async directory => {
    const home = join(directory, 'member');
    await mkdir(home, { mode: 0o700 });
    const payload = join(directory, 'happier');
    await writeFile(payload, '#!/bin/sh\nexit 0\n', { mode: 0o555 });
    const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
      requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
      username: current.username, agentUid: current.uid, agentGid: current.gid, home };
    // Replace only sudo/OS identity with this test process. Framing and the
    // actual host-authored probe shell remain real; the shim owns umask 002.
    let nativeExit: unknown;
    const system: AgentIsolationReadinessSystem = { run: async (_command, _args, options) => {
      const frame = await readAgentLaunchFrame(Readable.from([options!.inputBytes!], { objectMode: false }));
      if ('action' in frame) throw new Error('Unexpected cleanup frame');
      try { return await execFileWithDeadline(frame.executable, [frame.args[0]!, `umask 002\n${frame.args[1]}`, ...frame.args.slice(2)], {
        encoding: 'utf8', cwd: frame.cwd, env: { ...frame.environment, HOME: home, USER: current.username },
      }); } catch (error) {
        nativeExit = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        throw error;
      }
    } };
    for (const failure of [
      { check: 'uid', exitCode: 71, identity: { ...identity, agentUid: current.uid + 1 } },
      { check: 'groups', exitCode: 79, identity: { ...identity, agentGid: current.gid + 1 } },
      { check: 'managed_payload', exitCode: 73, identity },
    ] as const) {
      if (failure.check === 'managed_payload') {
        if (process.getgroups?.().some(group => group !== current.gid)) continue;
        await chmod(payload, 0o755);
      }
      const result = await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload, memberIdentity: failure.identity, system });
      expect(nativeExit).toBe(failure.exitCode);
      expect(result).toMatchObject({ kind: 'unavailable', probeFailure: { check: failure.check, exitCode: failure.exitCode,
        identity: { username: identity.username, uid: failure.identity.agentUid, gid: failure.identity.agentGid, home, cwd: home } } });
    }
    const denied: AgentIsolationReadinessSystem = { run: async () => {
      throw Object.assign(new Error('private native command and secret-value'), { code: 1, stderr: 'secret-value' });
    } };
    const result = await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload, memberIdentity: identity, system: denied });
    expect(result).toMatchObject({ kind: 'unavailable', probeFailure: { check: 'launch', exitCode: 1 } });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(JSON.stringify(result)).not.toContain('stderr');
    const unknown: AgentIsolationReadinessSystem = { run: async () => { throw 'secret-value'; } };
    const unavailable = await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload, memberIdentity: identity, system: unknown });
    expect(unavailable).toMatchObject({ kind: 'unavailable', probeFailure: { check: 'launch', transportError: 'execution_failed' } });
    expect(JSON.stringify(unavailable)).not.toContain('secret-value');
  });
});
