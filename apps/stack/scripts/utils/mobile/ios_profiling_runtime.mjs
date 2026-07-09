import { join } from 'node:path';

import { run as defaultRun, runCapture as defaultRunCapture } from '../proc/proc.mjs';

const DEFAULT_WORKSPACE = 'ios/Happierdev.xcworkspace';
const DEFAULT_SCHEME = 'Happierdev';
const DEFAULT_CONFIGURATION = 'Release';

export function parseXcodeBuildSettings(stdout) {
  const settings = {};
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    settings[match[1]] = match[2];
  }
  return settings;
}

function parseSimctlDevices(stdout) {
  const parsed = JSON.parse(String(stdout ?? '{}'));
  const devicesByRuntime = parsed && typeof parsed === 'object' && parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
  const devices = [];
  for (const [runtime, entries] of Object.entries(devicesByRuntime)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.isAvailable === false) continue;
      const udid = String(entry.udid ?? '').trim();
      const name = String(entry.name ?? '').trim();
      if (!udid || !name) continue;
      devices.push({
        udid,
        name,
        runtime,
        state: String(entry.state ?? '').trim(),
      });
    }
  }
  return devices;
}

function formatSimulatorList(devices) {
  return devices.map((device) => `${device.name} (${device.udid}, ${device.state || 'unknown'}, ${device.runtime})`).join('\n');
}

export async function resolveIosSimulatorDevice({
  device = '',
  runCapture = defaultRunCapture,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const raw = await runCapture('xcrun', ['simctl', 'list', 'devices', '--json'], { cwd, env });
  const devices = parseSimctlDevices(raw);
  const selector = String(device ?? '').trim();

  if (!selector) {
    const booted = devices.filter((entry) => entry.state === 'Booted');
    if (booted.length === 1) return booted[0];
    if (booted.length === 0) {
      throw new Error('No booted iOS simulator found for --profiling-runtime. Pass --device=<simulator-udid> after booting one.');
    }
    throw new Error(
      `Multiple booted iOS simulators found for --profiling-runtime. Pass --device=<simulator-udid>.\n${formatSimulatorList(booted)}`,
    );
  }

  const udidMatch = devices.find((entry) => entry.udid === selector);
  if (udidMatch) return udidMatch;

  const nameMatches = devices.filter((entry) => entry.name === selector);
  if (nameMatches.length === 1) return nameMatches[0];
  const bootedNameMatches = nameMatches.filter((entry) => entry.state === 'Booted');
  if (bootedNameMatches.length === 1) return bootedNameMatches[0];
  if (nameMatches.length > 1) {
    throw new Error(`Multiple iOS simulators matched "${selector}". Pass --device=<simulator-udid>.\n${formatSimulatorList(nameMatches)}`);
  }

  throw new Error(`No iOS simulator matched "${selector}". Available simulators:\n${formatSimulatorList(devices)}`);
}

function xcodeBuildBaseArgs({ workspace, scheme, configuration, udid }) {
  return [
    '-workspace',
    workspace,
    '-scheme',
    scheme,
    '-configuration',
    configuration,
    '-destination',
    `id=${udid}`,
    'ENABLE_DEBUG_DYLIB=NO',
    'ONLY_ACTIVE_ARCH=YES',
    'SENTRY_DISABLE_AUTO_UPLOAD=true',
  ];
}

function requireBuildSetting(settings, key) {
  const value = String(settings[key] ?? '').trim();
  if (!value) {
    throw new Error(`xcodebuild -showBuildSettings did not report ${key}.`);
  }
  return value;
}

export async function runIosProfilingRuntime({
  uiDir,
  device = '',
  configuration = DEFAULT_CONFIGURATION,
  workspace = DEFAULT_WORKSPACE,
  scheme = DEFAULT_SCHEME,
  run = defaultRun,
  runCapture = defaultRunCapture,
  env = process.env,
} = {}) {
  const projectDir = String(uiDir ?? '').trim();
  if (!projectDir) {
    throw new Error('runIosProfilingRuntime requires uiDir.');
  }

  const simulator = await resolveIosSimulatorDevice({ device, runCapture, cwd: projectDir, env });
  const normalizedConfiguration = String(configuration ?? '').trim() || DEFAULT_CONFIGURATION;
  const baseArgs = xcodeBuildBaseArgs({
    workspace,
    scheme,
    configuration: normalizedConfiguration,
    udid: simulator.udid,
  });

  const settingsOut = await runCapture('xcodebuild', ['-showBuildSettings', ...baseArgs], { cwd: projectDir, env });
  const settings = parseXcodeBuildSettings(settingsOut);
  const debugDylib = requireBuildSetting(settings, 'ENABLE_DEBUG_DYLIB');
  if (debugDylib !== 'NO') {
    throw new Error(`Expected ENABLE_DEBUG_DYLIB=NO for profiling runtime, got ${debugDylib}.`);
  }

  const targetBuildDir = requireBuildSetting(settings, 'TARGET_BUILD_DIR');
  const productName = requireBuildSetting(settings, 'FULL_PRODUCT_NAME');
  const bundleId = requireBuildSetting(settings, 'PRODUCT_BUNDLE_IDENTIFIER');
  const appPath = join(targetBuildDir, productName);

  await run('xcodebuild', [...baseArgs, 'build'], { cwd: projectDir, env });
  await run('xcrun', ['simctl', 'install', simulator.udid, appPath], { cwd: projectDir, env });
  await run('xcrun', ['simctl', 'launch', '--terminate-running-process', simulator.udid, bundleId], { cwd: projectDir, env });

  return {
    appPath,
    bundleId,
    configuration: normalizedConfiguration,
    debugDylib,
    device: simulator,
  };
}
