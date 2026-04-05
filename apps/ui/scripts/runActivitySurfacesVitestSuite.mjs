import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = dirname(scriptPath);
const packageRoot = dirname(scriptsDir);
const require = createRequire(import.meta.url);

export const ACTIVITY_SURFACES_VITEST_FILES = [
  'sources/activity/actions/parseActivityInteraction.test.ts',
  'sources/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.test.tsx',
  'sources/activity/adapters/desktop/runtime/desktopActivityOverlayBridge.test.ts',
  'sources/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy.test.ts',
  'sources/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext.test.ts',
  'sources/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel.test.ts',
  'sources/activity/adapters/desktop/positioning/resolveDesktopOverlayPlacement.test.ts',
  'sources/activity/adapters/desktop/ui/DesktopActivityOverlayRoute.test.tsx',
  'sources/activity/attention/resolveActivitySurfacePolicy.test.ts',
  'sources/activity/selection/resolveActivitySurfaceSlots.test.ts',
  'sources/activity/presentation/buildActivitySurfaceViewModel.test.ts',
  'sources/activity/widgets/activitySurfaceSnapshot.test.ts',
  'sources/activity/liveActivities/buildLiveActivitySnapshots.test.ts',
  'sources/activity/liveActivities/resolveLiveActivityReconciliationState.test.ts',
  'sources/activity/runtime/ActivitySurfacesRuntime.test.tsx',
  'sources/components/settings/notifications/NotificationsSettingsView.test.tsx',
  'sources/components/settings/desktop/DesktopOverlaySettingsSection.test.tsx',
  'sources/components/settings/desktop/DesktopSettingsSection.test.tsx',
  'sources/sync/domains/settings/localSettings.test.ts',
  'sources/sync/store/domains/settings.analytics.test.ts',
];

export function runActivitySurfacesVitestSuite({
  cwd = packageRoot,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const vitestCli = require.resolve('vitest/vitest.mjs', {
    paths: [cwd],
  });
  const result = spawnSyncImpl(
    process.execPath,
    [vitestCli, 'run', '--maxWorkers', '1', ...ACTIVITY_SURFACES_VITEST_FILES],
    {
      cwd,
      env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Activity-surfaces vitest suite failed with exit code ${result.status}.`);
  }
}

function runCli() {
  try {
    runActivitySurfacesVitestSuite();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === scriptPath) {
  runCli();
}
