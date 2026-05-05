import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TARGET_NAME = 'ExpoWidgetsTarget';
const DEFAULT_REQUIRED_WIDGET_NAMES = [
  'HappierFocusWidget',
  'HappierSessionsWidget',
  'HappierFocusLiveActivity',
];

export function stripAnsiSequences(raw) {
  return String(raw ?? '').replace(/\u001B\[[0-9;]*m/g, '');
}

export function assertExpoWidgetsIntrospectionOutput(
  rawOutput,
  {
    targetName = DEFAULT_TARGET_NAME,
    requiredWidgetNames = DEFAULT_REQUIRED_WIDGET_NAMES,
  } = {},
) {
  const output = stripAnsiSequences(rawOutput);

  const targetPattern = new RegExp(`targetName:\\s*['"]${targetName}['"]`);
  if (!targetPattern.test(output)) {
    throw new Error(`Expo widgets introspection did not include targetName '${targetName}'.`);
  }

  const bundleIdentifierMatch = output.match(/bundleIdentifier:\s*['"]([^'"\n]+)['"]/);
  if (!bundleIdentifierMatch) {
    throw new Error('Expo widgets introspection did not include a widget target bundleIdentifier.');
  }

  const pushNotificationsPattern = /['"]?(?:enablePushNotifications|ExpoWidgets_EnablePushNotifications)['"]?\s*:\s*true\b/;
  if (!pushNotificationsPattern.test(output)) {
    throw new Error('Expo widgets introspection did not enable ActivityKit push notifications.');
  }

  for (const widgetName of requiredWidgetNames) {
    const widgetPattern = new RegExp(`name:\\s*['"]${widgetName}['"]`);
    if (!widgetPattern.test(output)) {
      throw new Error(`Expo widgets introspection did not include required widget '${widgetName}'.`);
    }
  }

  return {
    targetName,
    bundleIdentifier: bundleIdentifierMatch[1],
    enablePushNotifications: true,
    widgetNames: [...requiredWidgetNames],
  };
}

export function validateExpoWidgetsNativeSync({
  cwd,
  env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = cwd ?? dirname(scriptsDir);
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const nextEnv = {
    ...process.env,
    ...env,
    EXPO_UNSTABLE_WEB_MODAL: env?.EXPO_UNSTABLE_WEB_MODAL ?? process.env.EXPO_UNSTABLE_WEB_MODAL ?? '1',
  };

  const result = spawnSyncImpl(
    command,
    ['expo', 'config', '--type', 'introspect'],
    {
      cwd: packageRoot,
      env: nextEnv,
      encoding: 'utf8',
    },
  );

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(
      `Expo widgets native sync validation failed with exit code ${result.status}.\n${stripAnsiSequences(output)}`.trim(),
    );
  }

  return assertExpoWidgetsIntrospectionOutput(output);
}

function runCli() {
  try {
    const summary = validateExpoWidgetsNativeSync();
    console.log(
      [
        'Expo widgets native sync validated via non-destructive introspection.',
        `target=${summary.targetName}`,
        `bundleIdentifier=${summary.bundleIdentifier}`,
        `pushNotifications=${summary.enablePushNotifications ? 'enabled' : 'disabled'}`,
        `widgets=${summary.widgetNames.join(',')}`,
      ].join(' '),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
