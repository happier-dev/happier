import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { native, captureResult, png } from './driver/nativeComputerBoundary.testkit';
import './desktopX11Boundary.testkit';
import { runMemberComputerRuntimeInternal } from './memberRuntimeInternal';
import { createMemberComputerRuntimeChannel } from './memberRuntimeProtocol';

const spawned: Array<{ executable: string; environment: NodeJS.ProcessEnv; child: ChildProcess }> = [];
// Desktop subprocesses are the OS boundary. Desktop files and driver logic remain real.
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: (executable: string, _args: string[], options: SpawnOptions) => {
    const name = basename(executable);
    // Keep actual child identities and exit events beneath the real process-tree owner.
    const readiness = name === 'Xvfb' ? 'require("fs").writeSync(3,"73\\n");'
      : name === 'dbus-daemon' ? 'process.stdout.write("unix:path=/fixture/private-bus\\n");' : '';
    const child = real.spawn(process.execPath, ['-e', name === 'gdbus' ? '' : `${readiness}setInterval(() => {}, 1000);`], options);
    spawned.push({ executable, environment: options.env ?? {}, child });
    return child;
  } };
});

describe('member Computer private child', () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    spawned.length = 0;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')('owns its desktop and real driver, preserves frames during input, and cleans up at EOF', async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-member-computer-'));
    for (const name of ['Xvfb', 'dbus-daemon', 'gdbus', 'openbox']) {
      await writeFile(join(root, name), ''); await chmod(join(root, name), 0o755);
    }
    vi.stubEnv('PATH', root);
    vi.stubEnv('DISPLAY', ':owner');
    vi.stubEnv('WAYLAND_DISPLAY', undefined);
    vi.stubEnv('XAUTHORITY', '/owner/private-cookie');
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, process.env[key]);
    let releaseInput = () => {};
    let inputStarted = () => {};
    const inputReady = new Promise<void>(resolve => { inputStarted = resolve; });
    let windowReads = 0;
    native.call.mockImplementation(async ({ name }) => {
      if (name === 'get_window_state') {
        if (++windowReads === 2) { inputStarted(); await new Promise<void>(resolve => { releaseInput = resolve; }); }
        return captureResult();
      }
      if (name === 'list_windows') return { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Member editor' }] } };
      return { structuredContent: { x11: true, xsend_event: true } };
    });
    const input = new PassThrough(); const output = new PassThrough();
    const running = runMemberComputerRuntimeInternal(input, output);
    const channel = createMemberComputerRuntimeChannel({ input, output, dispose: () => running });
    let cookie: string | undefined;
    try {
      const connection = await channel.initialize(root);
      expect(connection.displayId).toBe(':73');
      cookie = connection.environment.XAUTHORITY;
      expect(dirname(dirname(cookie!))).toBe(root);
      expect((await stat(cookie!)).mode & 0o777).toBe(0o600);
      const installedExecutable = join(root, 'owner-installed-driver');
      await writeFile(installedExecutable, 'fixture native executable', { mode: 0o700 });
      const driver = await channel.createDriver({ executablePath: installedExecutable, provider: 'cua' });
      expect(native.instances[0]?.parameters.env).toMatchObject({ DISPLAY: ':73', XAUTHORITY: cookie });
      const memberExecutable = native.instances[0]!.parameters.command;
      expect(dirname(memberExecutable)).toBe(connection.environment.XDG_RUNTIME_DIR);
      expect(await readFile(memberExecutable, 'utf8')).toBe('fixture native executable');
      expect((await stat(memberExecutable)).mode & 0o777).toBe(0o700);
      const otherDriver = await channel.createDriver({ executablePath: installedExecutable, provider: 'cua' });
      expect(native.instances[1]!.parameters.command).toBe(memberExecutable);
      await otherDriver.close();
      await writeFile(installedExecutable, 'upgraded fixture native executable');
      const upgradedDriver = await channel.createDriver({ executablePath: installedExecutable, provider: 'cua' });
      const upgradedExecutable = native.instances[2]!.parameters.command;
      expect(upgradedExecutable).not.toBe(memberExecutable);
      expect(await readFile(upgradedExecutable, 'utf8')).toBe('upgraded fixture native executable');
      await upgradedDriver.close();
      expect(await driver.listTargets()).toMatchObject([
        { target: { kind: 'window', displayId: ':73', pid: 42, windowId: 123 }, title: 'Member editor' },
      ]);
      const target = { kind: 'window' as const, displayId: ':73', pid: 42, windowId: 123 };
      expect(await driver.capture(target)).toMatchObject({ png: Buffer.from(png, 'base64'), captureId: 'capture-1' });
      const controller = new AbortController();
      const effect = driver.input(target, 'capture-1', { kind: 'type', text: 'member text' }, { signal: controller.signal });
      await inputReady;
      expect(await driver.captureFrame(target)).toMatchObject({ png: Buffer.from(png, 'base64') });
      controller.abort();
      // A subsequent request traverses the same ordered pipe after cancellation.
      await driver.checkPermissions();
      releaseInput();
      expect(await effect).toMatchObject({ status: 'interrupted', completion: 'known' });
      expect(native.tools.some(tool => tool.name === 'type_text')).toBe(false);
    } finally { releaseInput(); await channel.dispose(); }
    expect(native.instances.every(instance => instance.close.mock.calls.length > 0)).toBe(true);
    expect(spawned.every(entry => entry.child.exitCode !== null || entry.child.signalCode !== null)).toBe(true);
    await expect(stat(cookie!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
