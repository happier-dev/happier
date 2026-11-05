import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

type Mount = Readonly<{ path: string; backing: string; uid: number; gid: number; mode: number }>;

/** Native OS and pipe boundary only; the real framed Workspace worker runs beneath it. */
export const workspaceCheckoutNativeBoundary = {
  privateRoot: '',
  privateRoots: [] as string[],
  identity: new AsyncLocalStorage<'daemon' | 'member'>(),
  mounts: [] as Mount[],
  accountLookups: new Map<string, string>(),
  launch: undefined as undefined | ((input: PassThrough, output: PassThrough) => Promise<void>),
  childFailure: undefined as unknown,
  phases: [] as string[],
  runAsUsers: [] as string[],
  completed: false,
  reset() {
    this.identity.disable();
    this.privateRoot = ''; this.privateRoots = []; this.mounts = []; this.accountLookups.clear(); this.launch = undefined;
    this.childFailure = undefined; this.phases = []; this.runAsUsers = []; this.completed = false;
  },
};

export function workspaceCheckoutFilesystemBoundary(actual: typeof import('node:fs/promises')) {
  const boundary = workspaceCheckoutNativeBoundary;
  const mountFor = (path: unknown) => boundary.mounts.find(mount => String(path) === mount.path || String(path).startsWith(`${mount.path}/`));
  const mapped = (path: unknown) => {
    const mount = mountFor(path);
    return mount ? `${mount.backing}${String(path).slice(mount.path.length)}` : path;
  };
  // The assertion is restricted to the overloaded Node filesystem adapter.
  return { ...actual,
    async lstat(path: Parameters<typeof actual.lstat>[0], ...args: unknown[]) {
      const state = await Reflect.apply(actual.lstat, actual, [mapped(path), ...args]);
      const mount = boundary.mounts.find(entry => entry.path === String(path));
      return mount ? Object.assign(state, { uid: mount.uid, gid: mount.gid, mode: mount.mode }) : state;
    },
    async realpath(path: Parameters<typeof actual.realpath>[0], ...args: unknown[]) {
      if (boundary.identity.getStore() !== 'member' && [boundary.privateRoot, ...boundary.privateRoots].some(root => root
        && (String(path) === root || String(path).startsWith(`${root}/`)))) {
        boundary.phases.push('daemon_private_readback_denied');
        throw Object.assign(new Error('Member private traversal denied'), { code: 'EACCES' });
      }
      const result = await Reflect.apply(actual.realpath, actual, [mapped(path), ...args]);
      return mountFor(path) ? String(path) : result;
    },
    readFile: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.readFile, actual, [mapped(path), ...args]),
    stat: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.stat, actual, [mapped(path), ...args]),
    writeFile: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.writeFile, actual, [mapped(path), ...args]),
    open: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.open, actual, [mapped(path), ...args]),
    access: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.access, actual, [mapped(path), ...args]),
    mkdir: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.mkdir, actual, [mapped(path), ...args]),
    chmod: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.chmod, actual, [mapped(path), ...args]),
    link: (source: unknown, destination: unknown, ...args: unknown[]) => Reflect.apply(actual.link, actual, [mapped(source), mapped(destination), ...args]),
    unlink: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.unlink, actual, [mapped(path), ...args]),
    readdir: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.readdir, actual, [mapped(path), ...args]),
    copyFile: (source: unknown, destination: unknown, ...args: unknown[]) => Reflect.apply(actual.copyFile, actual, [mapped(source), mapped(destination), ...args]),
    cp: (source: unknown, destination: unknown, ...args: unknown[]) => Reflect.apply(actual.cp, actual, [mapped(source), mapped(destination), ...args]),
    rename: (source: unknown, destination: unknown, ...args: unknown[]) => Reflect.apply(actual.rename, actual, [mapped(source), mapped(destination), ...args]),
    rm: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.rm, actual, [mapped(path), ...args]),
  } as typeof actual;
}

export function spawnWorkspaceCheckoutNativeBoundary() {
  const boundary = workspaceCheckoutNativeBoundary;
  boundary.phases.push('native_spawn');
  const input = new PassThrough();
  class NativeOutput extends PassThrough {
    override emit(event: string | symbol, ...values: unknown[]): boolean {
      return boundary.identity.run('daemon', () => super.emit(event, ...values));
    }
  }
  const output = new NativeOutput();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: new PassThrough(),
    pid: undefined, exitCode: null as number | null, signalCode: null, killed: false });
  queueMicrotask(() => {
    void boundary.identity.run('member', async () => {
      try {
        if (!boundary.launch) throw new Error('Missing native operation fixture');
        await boundary.launch(input, output);
        child.exitCode = 0;
      } catch (error) { boundary.childFailure = error; child.exitCode = 1; }
      boundary.phases.push('native_worker_ended');
      output.end(); child.stderr.end();
      child.emit('exit', child.exitCode, null); child.emit('close', child.exitCode, null);
      boundary.phases.push('native_closed');
    });
  });
  return child;
}
