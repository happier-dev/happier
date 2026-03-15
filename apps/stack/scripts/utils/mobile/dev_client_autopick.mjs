import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { runCapture } from '../proc/proc.mjs';

function resolveCommandPathFromEnv(cmd, env) {
  const c = String(cmd ?? '').trim();
  if (!c) return '';
  if (c.includes('/') || c.includes('\\')) {
    return existsSync(c) ? c : '';
  }

  const e = env && typeof env === 'object' ? env : process.env;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const pathEntries = String(e.PATH ?? '')
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.platform === 'win32') {
    const pathextRaw = String(e.PATHEXT ?? '.EXE;.CMD;.BAT;.COM');
    const pathext = pathextRaw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const dir of pathEntries) {
      // If cmd already has an extension, try it first.
      const direct = join(dir, c);
      if (existsSync(direct)) return direct;
      for (const ext of pathext) {
        const candidate = join(dir, `${c}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
    return '';
  }

  for (const dir of pathEntries) {
    const candidate = join(dir, c);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

async function runCaptureIfCommandExists(cmd, args, { env, cwd, timeoutMs } = {}) {
  const resolved = resolveCommandPathFromEnv(cmd, env);
  if (!resolved) return '';
  try {
    return await runCapture(resolved, args, { env, cwd, timeoutMs });
  } catch {
    return '';
  }
}

function parseFirstAdbConnectedSerial(raw) {
  const text = String(raw ?? '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^List of devices attached/i.test(trimmed)) continue;
    const m = trimmed.match(/^(\S+)\s+device\b/);
    if (m?.[1]) return m[1];
  }
  return '';
}

function parseXcdeviceList(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('[');
  const jsonText = start >= 0 ? text.slice(start) : text;
  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findFirstConnectedUsbIosDeviceIdentifier(list) {
  const arr = Array.isArray(list) ? list : [];
  const firstConnected = arr.find(
    (d) =>
      d &&
      d.platform === 'com.apple.platform.iphoneos' &&
      d.interface === 'usb' &&
      (d.available === true || d.available === 'YES') &&
      d.simulator === false &&
      typeof d.identifier === 'string' &&
      d.identifier.length > 0
  );
  return firstConnected?.identifier || '';
}

async function resolveConnectedAndroidSerial({ env, cwd } = {}) {
  const out = await runCaptureIfCommandExists('adb', ['devices'], { env, cwd, timeoutMs: 10_000 });
  return parseFirstAdbConnectedSerial(out);
}

async function resolveConnectedUsbIosIdentifier({ env, cwd } = {}) {
  if (process.platform !== 'darwin') return '';
  const out = await runCaptureIfCommandExists('xcrun', ['xcdevice', 'list'], { env, cwd, timeoutMs: 10_000 });
  if (!out) return '';
  const list = parseXcdeviceList(out);
  return findFirstConnectedUsbIosDeviceIdentifier(list);
}

async function isExplicitDeviceAndroid({ device, env, cwd } = {}) {
  const d = String(device ?? '').trim();
  if (!d) return false;
  const out = await runCaptureIfCommandExists('adb', ['devices'], { env, cwd, timeoutMs: 10_000 });
  if (!out) return false;
  const re = new RegExp(`^${d.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+device\\b`, 'm');
  return re.test(out);
}

async function isExplicitDeviceIos({ device, env, cwd } = {}) {
  const d = String(device ?? '').trim();
  if (!d) return false;
  if (process.platform !== 'darwin') return false;
  const out = await runCaptureIfCommandExists('xcrun', ['xcdevice', 'list'], { env, cwd, timeoutMs: 10_000 });
  if (!out) return false;
  const list = parseXcdeviceList(out);
  return Boolean(
    Array.isArray(list) &&
      list.some((x) => x && (x.identifier === d || x.name === d) && x.platform === 'com.apple.platform.iphoneos')
  );
}

/**
 * @param {string} raw
 * @returns {'ios'|'android'|''}
 */
function normalizePlatform(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'android') return 'android';
  if (v === 'ios') return 'ios';
  return '';
}

/**
 * Autodetect `--platform` (and optionally `--device`) for `mobile-dev-client`.
 *
 * Rules:
 * - If `--platform` is explicitly set, honor it.
 * - If `--device` is set but platform is not, infer platform by matching connected devices.
 * - Else: pick android if there's a connected adb device; pick ios if there's a connected USB iPhone.
 * - If both iOS+Android are connected and nothing disambiguates, return ambiguous.
 *
 * @param {{ platformArg?: string; deviceArg?: string; env?: Record<string, string | undefined>; cwd?: string }} [opts]
 * @returns {Promise<
 *   | { kind: 'explicit'; platform: 'ios'|'android'; device: string }
 *   | { kind: 'autopicked'; platform: 'ios'|'android'; device: string }
 *   | { kind: 'ambiguous'; androidSerial: string; iosIdentifier: string }
 * >}
 */
export async function resolveDevClientPlatformAndDevice(opts = {}) {
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd.trim() : undefined;
  const explicitPlatform = normalizePlatform(opts.platformArg);
  const explicitDevice = String(opts.deviceArg ?? '').trim();

  if (explicitPlatform) {
    if (explicitDevice) {
      return { kind: 'explicit', platform: explicitPlatform, device: explicitDevice };
    }
    if (explicitPlatform === 'android') {
      const androidSerial = await resolveConnectedAndroidSerial({ env, cwd });
      return { kind: 'explicit', platform: 'android', device: androidSerial };
    }
    return { kind: 'explicit', platform: explicitPlatform, device: '' };
  }

  if (explicitDevice) {
    if (await isExplicitDeviceAndroid({ device: explicitDevice, env, cwd })) {
      return { kind: 'explicit', platform: 'android', device: explicitDevice };
    }
    if (await isExplicitDeviceIos({ device: explicitDevice, env, cwd })) {
      return { kind: 'explicit', platform: 'ios', device: explicitDevice };
    }
    // If a device is explicitly provided but can't be matched, preserve legacy default (ios) and pass the device through.
    return { kind: 'explicit', platform: 'ios', device: explicitDevice };
  }

  const [androidSerial, iosIdentifier] = await Promise.all([
    resolveConnectedAndroidSerial({ env, cwd }),
    resolveConnectedUsbIosIdentifier({ env, cwd }),
  ]);

  if (androidSerial && iosIdentifier) {
    return { kind: 'ambiguous', androidSerial, iosIdentifier };
  }
  if (androidSerial) {
    return { kind: 'autopicked', platform: 'android', device: androidSerial };
  }
  if (iosIdentifier) {
    return { kind: 'autopicked', platform: 'ios', device: '' };
  }

  return { kind: 'autopicked', platform: 'ios', device: '' };
}
