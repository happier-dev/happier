import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createLumeNativeClient } from './nativeClient.js';
import { createLumePreparationBuildExecutor } from './preparationGuest.js';

const success = (stdout = ''): PluginProcessResult => ({ stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
  termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutTruncated: false, stderrTruncated: false });
const cli = { identity: 'home:public-payload', versionId: '0.3.0', binaryPath: '/Users/lume/.happier/cli/happier',
  installScript: 'install-published-cli --managed-guest', files: [{ path: 'cli/payload.tar.gz', contentsBase64: Buffer.from('public-bytes\u0000').toString('base64') }] };
function fixture() {
  const resource = { storage: 'home', vmName: 'happier-prepared-guest-executor' };
  const events: string[] = [], requests: Parameters<ExecService['run']>[0][] = [];
  const observations: PluginProcessResult[] = [];
  let nativeReady = true;
  const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({
    name: resource.vmName, locationName: 'home', status: 'running', os: 'macos', cpuCount: 2, memorySize: 4 * 1024 ** 3,
    diskSize: { allocated: 1024 ** 3, total: 150 * 1024 ** 3 }, ipAddress: '192.168.64.7', sshAvailable: nativeReady,
  }) });
  // Only the OS/process boundary is substituted; native identity and SSH observation stay real.
  const exec = { run: async request => {
    requests.push(request);
    if (request.executable.id.localId === 'ssh-keyscan') { events.push('observe'); return observations.shift() ?? success('192.168.64.7 ssh-ed25519 cHVibGlj\n'); }
    events.push('guest');
    return request.args?.at(-1)?.includes('mktemp -d') ? success('/tmp/happier-build.fixture\n') : success();
  }, spawn: async () => { throw new Error('Prepare must not start a persistent guest process'); }, systemTools: { resolve: async ({ toolId }) => ({
    executable: { kind: 'systemTool', id: { pluginId: 'happier.machine.lume', localId: toolId } }, executablePath: `/usr/bin/${toolId}`,
  }) } } satisfies ExecService;
  return { resource, native, exec, events, requests, observations,
    waitForNativeObservation: async () => { events.push('wait'); },
    setNativeReady(value: boolean) { nativeReady = value; } };
}
describe('credential-free Lume guest build execution', () => {
  it('removes and flushes the base SSH host identity in the final authenticated connection after stage cleanup', async () => {
    const f = fixture();
    await createLumePreparationBuildExecutor({ ...f, establishSshHostTrust: async () => {} })({ resource: f.resource, cli });
    const last = f.requests.at(-1);
    expect(last?.args?.at(-1)).toContain('/etc/ssh/ssh_host_');
    expect(last?.args?.at(-1)).toContain('sudo');
    expect(last?.args?.at(-1)).toContain(' && sync');
    expect(last?.stdin).toEqual(new TextEncoder().encode('lume\n'));
    expect(last?.args?.at(-1)?.indexOf('rm -rf')).toBeLessThan(last?.args?.at(-1)?.indexOf('/etc/ssh/ssh_host_') ?? -1);
  });
  it('asks for host trust, transfers public CLI bytes through stdin and runs the supplied CLI and setup without enrolling a daemon', async () => {
    const f = fixture();
    // Real Mac failure: nc accepted port 22, but the first credential-free
    // keyscan exited 1 with empty stdout/stderr before any trust or guest write.
    f.observations.push({ ...success(), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } } });
    const execute = createLumePreparationBuildExecutor({ ...f, establishSshHostTrust: async () => { f.events.push('trust'); } });
    await execute({ resource: f.resource, cli, setupScript: 'prepare-my-tools' });
    expect(f.events.slice(0, 5)).toEqual(['observe', 'wait', 'observe', 'trust', 'guest']);
    expect(f.requests.find(request => request.stdin)?.stdin).toEqual(Buffer.from('public-bytes\u0000'));
    const commands = f.requests.map(request => request.args?.at(-1) ?? '').join('\n');
    expect(commands).toContain(cli.installScript);
    expect(commands).toContain('prepare-my-tools');
    expect(commands).not.toMatch(/authorized_keys|daemon start|session-runner|private[_-]?key/u);
    expect(commands).not.toContain(cli.files[0].contentsBase64);
    expect(commands).toContain('rm -rf');
    expect(f.requests.filter(request => request.args?.at(-1)?.includes(cli.installScript))).toHaveLength(1);
  });
  it('waits for a native connection before observing SSH identity or requesting trust', async () => {
    const f = fixture(); f.setNativeReady(false);
    const execute = createLumePreparationBuildExecutor({ ...f,
      waitForNativeObservation: async () => { f.events.push('wait'); f.setNativeReady(true); },
      establishSshHostTrust: async () => { f.events.push('trust'); } });
    await execute({ resource: f.resource, cli });
    expect(f.events.slice(0, 4)).toEqual(['wait', 'observe', 'trust', 'guest']);
  });
  it('cancels readiness waiting before trust or guest writes', async () => {
    const f = fixture(), controller = new AbortController(), cancelled = new Error('cancelled');
    f.observations.push({ ...success(), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } } });
    const execute = createLumePreparationBuildExecutor({ ...f,
      waitForNativeObservation: async () => { f.events.push('wait'); controller.abort(cancelled); },
      establishSshHostTrust: async () => { f.events.push('trust'); } });
    await expect(execute({ resource: f.resource, cli, signal: controller.signal })).rejects.toBe(cancelled);
    expect(f.events).toEqual(['observe', 'wait']);
  });
  it.each(['ssh_host_trust_rejected', 'native_ssh_host_key_unavailable'])('preserves trust rejection %s without retrying authentication or CLI delivery', async code => {
    const f = fixture(), refused = new PluginError({ code });
    const execute = createLumePreparationBuildExecutor({ ...f, establishSshHostTrust: async () => { f.events.push('trust'); throw refused; } });
    await expect(execute({ resource: f.resource, cli })).rejects.toBe(refused);
    expect(f.events).toEqual(['observe', 'trust']);
  });
  it('surfaces non-readiness observation failures without waiting or requesting trust', async () => {
    const f = fixture(), refused = new PluginError({ code: 'system_tool_unavailable' });
    f.exec.systemTools.resolve = async () => { throw refused; };
    const execute = createLumePreparationBuildExecutor({ ...f, establishSshHostTrust: async () => { f.events.push('trust'); } });
    await expect(execute({ resource: f.resource, cli })).rejects.toBe(refused);
    expect(f.events).toEqual([]);
  });
  it('cleans its remote stage when the supplied setup fails and retains a typed failure', async () => {
    const f = fixture();
    const run = f.exec.run;
    f.exec.run = async request => {
      const result = await run(request);
      return request.args?.at(-1)?.includes('broken-setup') ? { ...result,
        termination: { observed: { kind: 'exit', exitCode: 7 }, requestedBy: { kind: 'none' } } } : result;
    };
    await expect(createLumePreparationBuildExecutor({ ...f, establishSshHostTrust: async () => {} })({
      resource: f.resource, cli, setupScript: 'broken-setup',
    })).rejects.toMatchObject({ code: 'lume_preparation_guest_failed' });
    expect(f.requests.at(-1)?.args?.at(-1)).toContain("rm -rf -- '/tmp/happier-build.fixture'");
  });
});
