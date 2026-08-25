import { run, runCaptureResult } from '../proc/proc.mjs';

function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function validateHost(host) {
  if (!host || typeof host !== 'object' || Array.isArray(host)) {
    throw new Error('[managed-lima] host must be an object');
  }
  if (host.kind === 'local') return { kind: 'local' };
  if (host.kind !== 'ssh') throw new Error(`[managed-lima] unsupported host kind: ${String(host.kind)}`);
  const ssh = String(host.ssh ?? '').trim();
  const sshConfigFile = String(host.sshConfigFile ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(ssh)) throw new Error('[managed-lima] invalid outer-host SSH alias');
  if (!sshConfigFile.startsWith('/') || /[\0\r\n]/.test(sshConfigFile)) {
    throw new Error('[managed-lima] outer-host SSH config must be an absolute path');
  }
  return { kind: 'ssh', ssh, sshConfigFile };
}

function defaultBoundary() {
  return {
    runCapture: ({ command, args, env, input }) => runCaptureResult(command, args, { env, input }),
    runInteractive: async ({ command, args, env, input }) => {
      await run(command, args, { env, input, stdio: 'inherit' });
      return { exitCode: 0 };
    },
  };
}

function normalizeHostEnvironment(raw) {
  const result = {};
  for (const [key, rawValue] of Object.entries(raw ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('[managed-lima] invalid host environment key');
    const value = String(rawValue ?? '');
    if (/[\0\r\n]/.test(value)) throw new Error(`[managed-lima] invalid host environment value for ${key}`);
    result[key] = value;
  }
  return result;
}

export function createManagedLimaHostExecutor(
  host,
  boundary = defaultBoundary(),
  env = process.env,
  { hostEnvironment: rawHostEnvironment = {} } = {},
) {
  const normalizedHost = validateHost(host);
  const hostEnvironment = normalizeHostEnvironment(rawHostEnvironment);

  const invocation = (command, args) => {
    if (normalizedHost.kind === 'local') {
      return {
        command,
        args,
        env: Object.keys(hostEnvironment).length > 0 ? { ...env, ...hostEnvironment } : env,
      };
    }
    const environmentArgs = Object.entries(hostEnvironment).map(([key, value]) => `${key}=${value}`);
    const remoteCommand = [
      ...(environmentArgs.length > 0 ? ['env', ...environmentArgs] : []),
      command,
      ...args,
    ].map(posixQuote).join(' ');
    return {
      command: 'ssh',
      args: ['-T', '-F', normalizedHost.sshConfigFile, normalizedHost.ssh, remoteCommand],
      env,
    };
  };

  return {
    host: normalizedHost,
    capture(command, args = [], { input } = {}) {
      return boundary.runCapture({
        ...invocation(command, args),
        ...(input === undefined ? {} : { input }),
      });
    },
    run(command, args = [], { input } = {}) {
      const call = {
        ...invocation(command, args),
        ...(input === undefined ? {} : { input }),
      };
      return (boundary.runInteractive ?? boundary.runCapture)(call);
    },
  };
}
