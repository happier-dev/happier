// Native Lima 2.x IO, shared by Stack policy and the public Machine provisioner.
// Contract basis: lima-vm/lima v2.1.0 cmd/limactl/{info,list,start,restart,shell,delete}.go
// and pkg/{store/instance,instance/restart,instance/stop}.go (createAction lives in start.go).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';

// Lima v2.2.1 filenames.LongestSock includes OpenSSH's temporary 16-byte suffix.
const longestLimaSocket = 'ssh.sock.1234567890123456';
const acquisitionDigestWidth = Math.ceil(256 / Math.log2(36));

function limaSocketPathsFit(store, instance) {
  const unixPathMax = process.platform === 'linux' ? 108 : 104;
  return [path.posix.join(store, instance, longestLimaSocket),
    path.posix.join(store, '_networks', 'user-v2', 'user-v2_qemu.sock')]
    .every(socket => Buffer.byteLength(socket) < unixPathMax);
}

function resolveLimaStorePath(store) {
  const missing = [];
  let existing = store;
  while (true) {
    try { return path.posix.join(realpathSync(existing), ...missing); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.unshift(path.posix.basename(existing));
      existing = path.posix.dirname(existing);
    }
  }
}

/** Select once for acquisition; retained resource identities are never rewritten. */
export function limaAcquisitionIdentity({ store, managedId }) {
  const selected = resolveLimaStorePath(validateLimaStore(store));
  const digest = value => BigInt(`0x${createHash('sha256').update(value).digest('hex')}`).toString(36);
  const instance = `happier-${digest(managedId)}`;
  // All acquisitions in one launch store, including prepared bases and clones,
  // choose the same store even when their full digests have different widths.
  if (limaSocketPathsFit(selected, `happier-${'z'.repeat(acquisitionDigestWidth)}`)) {
    return { store: selected, instance };
  }
  // Lima itself uses ~/.lima specifically to fit Unix socket paths. Preserve
  // the entire digest and selected-store scope in the shorter native name.
  const shortStore = resolveLimaStorePath(path.posix.join(homedir(), '.lima'));
  const shortInstance = `h${digest(`${selected}\0${managedId}`)}`;
  if (!limaSocketPathsFit(shortStore, shortInstance)) {
    throw limaError('LIMA_STORE_PATH_TOO_LONG', 'native home cannot fit Lima Unix socket paths');
  }
  return { store: shortStore, instance: shortInstance };
}

export function validateLimaInstanceName(value) {
  const instance = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(instance)) {
    throw limaError('LIMA_INVALID_IDENTITY', 'invalid Lima instance name');
  }
  return instance;
}

export function validateLimaStore(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || /[\0\r\n]/.test(value)
      || path.posix.normalize(value) !== value || (value.length > 1 && value.endsWith('/'))) {
    throw limaError('LIMA_INVALID_IDENTITY', 'Lima store must be an exact resolved absolute path');
  }
  return value;
}

function limaError(code, message, cause) {
  return Object.assign(new Error(`[lima] ${message}`, cause ? { cause } : undefined), { code });
}

export function parseLimaVersion(output) {
  const match = String(output ?? '').match(/(?:version\s+)?(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1).map(Number) : null;
}

export function limaVersionAtLeast(actual, minimum = [2, 0, 0]) {
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function limaInstanceField(instance, lower, upper = lower[0].toUpperCase() + lower.slice(1)) {
  return instance?.[lower] ?? instance?.[upper] ?? null;
}

export function decodeLimaInstanceOutput(output, { instance: rawInstance, store } = {}) {
  const instance = validateLimaInstanceName(rawInstance);
  const text = String(output ?? '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    // Lima's non-TTY JSON format emits one object per line.
    try { parsed = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)); }
    catch (cause) { throw limaError('LIMA_INSPECT_UNAVAILABLE', 'invalid native inspection output', cause); }
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length === 0) return null;
  if (records.length !== 1 || !records[0] || typeof records[0] !== 'object'
      || limaInstanceField(records[0], 'name') !== instance) {
    throw limaError('LIMA_IDENTITY_MISMATCH', 'native inspection does not identify exactly the requested instance');
  }
  let record = records[0];
  if (store !== undefined) {
    const expectedDir = path.posix.join(validateLimaStore(store), instance);
    const nativeDir = limaInstanceField(record, 'dir');
    const resolvedDir = typeof nativeDir === 'string' && !path.posix.isAbsolute(nativeDir)
      ? path.posix.resolve(store, nativeDir) : nativeDir;
    if (resolvedDir !== expectedDir) {
      throw limaError('LIMA_IDENTITY_MISMATCH', 'native instance belongs to a different Lima store');
    }
    if (nativeDir !== resolvedDir) record = { ...record, ...('dir' in record ? { dir: resolvedDir } : { Dir: resolvedDir }) };
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    throw limaError('LIMA_INSPECT_UNAVAILABLE', 'native instance inspection reported errors');
  }
  return record;
}

function limaStoreOptions(store) {
  if (store === undefined) return {};
  const home = validateLimaStore(store);
  // Lima resolves the store before opening SSH/host-agent sockets. Relative
  // LIMA_HOME cannot shorten them and also breaks VZ's unix:// URL parsing.
  return { cwd: home, env: { LIMA_HOME: home } };
}

export async function runLimaCommand({ executor, store, instance, args, input, interactive = false }) {
  const options = { ...limaStoreOptions(store), ...(input === undefined ? {} : { input }) };
  const result = await executor[interactive ? 'run' : 'capture']('limactl', args, options);
  return result;
}

export async function inspectLimaCapabilities({ executor }) {
  try {
    const result = await runLimaCommand({ executor, args: ['info'] });
    if (result.exitCode !== 0) throw new Error('native capability command failed');
    const info = JSON.parse(result.out);
    if (!info || typeof info !== 'object' || typeof info.hostOS !== 'string' || typeof info.hostArch !== 'string'
      || !Array.isArray(info.vmTypes) || info.vmTypes.some((value) => typeof value !== 'string')) {
      throw new Error('invalid native capability facts');
    }
    return { hostOS: info.hostOS, hostArch: info.hostArch, vmTypes: info.vmTypes,
      ...(typeof info.limaHome === 'string' ? { limaHome: info.limaHome } : {}),
      ...(info.defaultTemplate && typeof info.defaultTemplate === 'object' && !Array.isArray(info.defaultTemplate)
        ? { defaultTemplate: info.defaultTemplate } : {}) };
  } catch (cause) { throw limaError('LIMA_INSPECT_UNAVAILABLE', 'native Lima capabilities unavailable', cause); }
}

export async function inspectLimaInstance({ executor, instance: rawInstance, store }) {
  const instance = validateLimaInstanceName(rawInstance);
  let result;
  try { result = await runLimaCommand({ executor, store, instance, args: ['list', '--all-fields', '--format=json', instance] }); }
  catch (cause) { throw limaError('LIMA_INSPECT_UNAVAILABLE', `failed to inspect ${instance}`, cause); }
  if (result.exitCode !== 0) {
    // v2.1.0 listAction uses this precise pair only when the supplied name is unmatched.
    if (result.exitCode === 1 && !String(result.out ?? '').trim()
        && /No instance matching .* found\./i.test(String(result.err ?? ''))
        && /unmatched instances/i.test(String(result.err ?? ''))) return null;
    throw limaError('LIMA_INSPECT_UNAVAILABLE', `failed to inspect ${instance}: ${String(result.err ?? '').trim()}`);
  }
  return decodeLimaInstanceOutput(result.out, { instance, store });
}

export async function getLimaStatus(options) {
  const instance = await inspectLimaInstance(options);
  return instance ? { exists: true, status: String(limaInstanceField(instance, 'status') ?? 'Unknown'), instance }
    : { exists: false, status: 'Absent', instance: null };
}

export async function changeLimaPower({ executor, instance: rawInstance, store, intent, force = false }) {
  const instance = validateLimaInstanceName(rawInstance);
  if (intent !== 'start' && intent !== 'stop') throw limaError('LIMA_UNSUPPORTED_INTENT', 'unsupported native power operation');
  const options = { executor, instance, store };
  const current = await getLimaStatus(options);
  if (!current.exists) throw limaError('MANAGED_LIMA_INSTANCE_ABSENT', `retained instance ${instance} does not exist`);
  if ((intent === 'start') === (current.status.toLowerCase() === 'running')) return { changed: false, status: current.status };
  if (current.status.toLowerCase() === 'broken') throw limaError('MANAGED_LIMA_INSTANCE_BROKEN', `retained instance ${instance} is broken`);
  // `start NAME` can silently create a default guest after an intervening
  // deletion. v2.1.0 restartAction only inspects; StopGracefully(isRestart=true)
  // permits a stopped guest, then starts that existing instance without Create.
  const operation = intent === 'start' ? 'restart' : 'stop';
  const result = await runLimaCommand({ executor, store, instance, interactive: true,
    args: [operation, ...(intent === 'stop' && force ? ['--force'] : []), instance] });
  if (result.exitCode !== 0) throw limaError('LIMA_POWER_UNKNOWN', `native ${intent} did not confirm success`);
  const observed = await getLimaStatus(options);
  return { changed: true, status: observed.status };
}

export async function createLimaInstance({ executor, instance: rawInstance, store, createArgs }) {
  const instance = validateLimaInstanceName(rawInstance);
  const options = { executor, instance, store };
  const existing = await inspectLimaInstance(options);
  if (existing) return { created: false, reconciled: false, instance: existing };
  // The caller owns reviewed configuration; this boundary owns uncertain native outcome.
  if (createArgs[0] !== 'create' || createArgs[createArgs.indexOf('--name') + 1] !== instance) {
    throw limaError('LIMA_IDENTITY_MISMATCH', 'creation arguments do not name the requested instance');
  }
  let uncertain = false;
  let creationFailure;
  try {
    const result = await runLimaCommand({ executor, store, instance, args: createArgs, interactive: true });
    uncertain = result.exitCode !== 0;
  } catch (cause) { uncertain = true; creationFailure = cause; }
  let observed;
  try { observed = await inspectLimaInstance(options); }
  catch (cause) { throw creationFailure ?? limaError('LIMA_ACQUIRE_UNKNOWN', 'creation outcome unavailable; inspect the same store and instance', cause); }
  if (!observed) throw creationFailure ?? limaError('LIMA_ACQUIRE_UNKNOWN', 'creation outcome unconfirmed; inspect the same store and instance');
  return { created: true, reconciled: uncertain, instance: observed };
}

export async function deleteLimaInstance({ executor, instance: rawInstance, store }) {
  const instance = validateLimaInstanceName(rawInstance);
  const options = { executor, instance, store };
  if (!await inspectLimaInstance(options)) return { kind: 'absent' };
  // The provisioner owns failure projection and retained cleanup custody.
  // Preserve native failures so that owner can report why Delete did not settle.
  const result = await runLimaCommand({ executor, store, instance, interactive: true, args: ['delete', '--force', instance] });
  if (result.exitCode !== 0) return { kind: 'unknown' };
  return await inspectLimaInstance(options) ? { kind: 'unknown' } : { kind: 'absent' };
}

function limaGuestShellArgs({ instance: rawInstance, argv, workdir }) {
  const instance = validateLimaInstanceName(rawInstance);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw limaError('LIMA_INVALID_COMMAND', 'guest command must be a nonempty argv');
  }
  return ['shell', ...(workdir === undefined ? [] : [`--workdir=${workdir}`]), instance, '--', ...argv];
}

export async function runLimaGuestCommand({ executor, instance, store, argv, input, workdir, interactive = false }) {
  return runLimaCommand({ executor, store, instance, args: limaGuestShellArgs({ instance, argv, workdir }), input, interactive });
}

async function assertLimaGuestRunning({ executor, instance, store }) {
  const current = await getLimaStatus({ executor, instance, store });
  if (!current.exists || current.status.toLowerCase() !== 'running') {
    throw limaError('LIMA_GUEST_UNAVAILABLE', 'native guest execution requires the retained running instance');
  }
}

export async function execLimaGuest({ executor, instance: rawInstance, store, argv, input }) {
  const instance = validateLimaInstanceName(rawInstance);
  await assertLimaGuestRunning({ executor, instance, store });
  return runLimaGuestCommand({ executor, instance, store, argv, input, workdir: '/' });
}

/** The provisioner `stream` role: one long-lived interactive guest shell process (no PTY). */
export async function openLimaGuestChannel({ executor, instance: rawInstance, store, argv }) {
  const instance = validateLimaInstanceName(rawInstance);
  if (typeof executor.channel !== 'function') throw limaError('LIMA_CHANNEL_UNSUPPORTED', 'this Lima executor carries no live channel');
  await assertLimaGuestRunning({ executor, instance, store });
  return executor.channel('limactl', limaGuestShellArgs({ instance, argv, workdir: '/' }), limaStoreOptions(store));
}

export async function putLimaGuestFile({ executor, instance, store, guestPath, bytes, mode = '0600' }) {
  if (typeof guestPath !== 'string' || !guestPath.startsWith('/') || /[\0\r\n]/.test(guestPath)
      || path.posix.normalize(guestPath) !== guestPath || !/^0[0-7]{3}$/.test(mode)) {
    throw limaError('LIMA_INVALID_PATH', 'guest file requires an exact absolute path and octal mode');
  }
  // Private bytes travel only on stdin, never argv, mounts, native configuration or logs.
  const result = await execLimaGuest({ executor, instance, store,
    argv: ['sh', '-c', 'umask 077; cat > "$1" && chmod "$2" "$1"', 'happier-put-file', guestPath, mode], input: bytes });
  return result.exitCode === 0 ? { kind: 'written' } : { kind: 'unknown' };
}
