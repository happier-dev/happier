import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('apps/ui exposes a rollout-local activity-surfaces typecheck and certification contract', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
  const scripts = packageJson?.scripts ?? {};

  assert.equal(
    scripts['typecheck:activity-surfaces'],
    '../stack/bin/hstack-exec --script=typecheck:activity-surfaces:local',
  );
  assert.equal(
    scripts['typecheck:activity-surfaces:local'],
    'node ../../scripts/workspaces/runTypeScriptCli.mjs -p tsconfig.activity-surfaces-rollout.json --noEmit --pretty false',
  );
  assert.equal(
    scripts['test:activity-surfaces'],
    '../stack/bin/hstack-exec --script=test:activity-surfaces:local',
  );
  assert.equal(
    scripts['test:activity-surfaces:local'],
    'node ./scripts/runActivitySurfacesVitestSuite.mjs',
  );
  assert.equal(
    scripts['certify:activity-surfaces'],
    'node ./scripts/runActivitySurfacesCertification.mjs',
  );
  assert.equal(
    scripts['certify:activity-surfaces:native'],
    'node ./scripts/runActivitySurfacesNativeCertification.mjs',
  );
  assert.equal(
    scripts['certify:activity-surfaces:release'],
    'node ./scripts/runActivitySurfacesReleaseReadiness.mjs',
  );
  assert.equal(
    scripts['test:native-e2e:activity-surfaces'],
    'yarn -s ensure:workspace:built && node ./scripts/tauriMcpQa.mjs --activity-surfaces',
  );

  const focusedSuitePath = join(packageRoot, 'scripts/runActivitySurfacesVitestSuite.mjs');
  const certificationPath = join(packageRoot, 'scripts/runActivitySurfacesCertification.mjs');
  const nativeCertificationPath = join(packageRoot, 'scripts/runActivitySurfacesNativeCertification.mjs');
  const releaseReadinessPath = join(packageRoot, 'scripts/runActivitySurfacesReleaseReadiness.mjs');
  await access(focusedSuitePath, fsConstants.F_OK);
  await access(certificationPath, fsConstants.F_OK);
  await access(nativeCertificationPath, fsConstants.F_OK);
  await access(releaseReadinessPath, fsConstants.F_OK);

  const focusedSuiteModule = await import(pathToFileURL(focusedSuitePath).href);
  const focusedVitestFiles = focusedSuiteModule.ACTIVITY_SURFACES_VITEST_FILES;
  assert.equal(Array.isArray(focusedVitestFiles), true);
  assert.equal(new Set(focusedVitestFiles).size, focusedVitestFiles.length);
  assert.equal(focusedVitestFiles.every((entry) => entry.startsWith('sources/')), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/runtime/ActivitySurfacesRuntime.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/buildLiveActivitySnapshots.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/HappierFocusLiveActivity.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/resolveLiveActivityReconciliationState.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/presentation/activitySurfacePresentation.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/runtime/resolveDesktopOverlaySelectionSpec.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/ui/DesktopActivityOverlayChrome.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/ui/DesktopActivityOverlayMotionFrame.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/ui/DesktopActivityOverlayVisualMode.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/ui/DesktopActivityOverlayCollapsed.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/ui/DesktopActivityOverlayExpanded.previewText.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/actions/resolveActivityInteractionCommand.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/notifications/notificationRouting.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/source/buildActivityOverviewFromSource.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/delivery/resolveActivityAttentionDeliveryPlan.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/motion/desktopOverlayCornerInterpolation.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/motion/desktopOverlaySprings.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/motion/useDesktopOverlayMatchedGeometry.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/ui/cards/resolveDesktopActivityOverlayCardActions.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/backgroundWake/applyLiveActivityBackgroundWakePayload.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/backgroundWake/defineLiveActivityBackgroundWakeTask.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/registerLiveActivityRemoteTarget.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/resolveLiveActivityPushSupport.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/resolveLiveActivityUpdateBudget.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/liveActivities/readLiveActivityAuthorizationDiagnostics.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/widgets/HappierFocusWidget.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/ios/widgets/HappierSessionsWidget.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/positioning/resolveDesktopOverlayPlacement.test.ts'), false);
  assert.equal(focusedVitestFiles.includes('sources/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/activity/presentation/activitySurfaceSnapshot.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/components/settings/desktop/DesktopSettingsSection.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/components/settings/desktop/DesktopOverlaySettingsSection.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/components/settings/desktop/DesktopAppSettingsScreen.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/components/settings/desktop/DesktopSettingsEntry.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/components/settings/desktop/DesktopSettingsEntry.web.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/components/settings/notifications/NotificationsSettingsView.test.tsx'), true);
  assert.equal(focusedVitestFiles.includes('sources/sync/domains/settings/localSettings.test.ts'), true);
  assert.equal(focusedVitestFiles.includes('sources/sync/store/domains/settings.analytics.test.ts'), true);

  const configPath = join(packageRoot, 'tsconfig.activity-surfaces-rollout.json');
  await access(configPath, fsConstants.F_OK);

  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  const include = Array.isArray(config?.include) ? config.include : [];

  assert.equal(config?.extends, './tsconfig.json');
  assert.equal(config?.compilerOptions?.incremental, false);
  assert.equal(include.includes('sources/activity/actions/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/attention/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/selection/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/presentation/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/adapters/ios/widgets/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/adapters/ios/widgets/**/*.tsx'), true);
  assert.equal(include.includes('sources/activity/adapters/ios/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/adapters/ios/**/*.tsx'), true);
  assert.equal(include.includes('sources/activity/adapters/desktop/**/*.ts'), true);
  assert.equal(include.includes('sources/activity/adapters/desktop/**/*.tsx'), true);
  assert.equal(include.includes('sources/components/settings/notifications/ActivitySurfacesSettingsSection.tsx'), true);
  assert.equal(include.includes('sources/components/settings/notifications/NotificationsSettingsView.tsx'), true);
  assert.equal(include.includes('sources/components/settings/desktop/DesktopOverlaySettingsSection.tsx'), true);
  assert.equal(include.includes('sources/components/settings/desktop/DesktopSettingsSection.tsx'), true);
  assert.equal(include.includes('sources/sync/domains/settings/registry/local/localSettingDefinitions.activitySurfaces.ts'), true);
  assert.equal(include.includes('sources/types/**/*.d.ts'), true);
  assert.equal(include.includes('sources/unistyles.ts'), true);
  assert.equal(include.some((entry) => entry.includes('.test.')), false);
});
