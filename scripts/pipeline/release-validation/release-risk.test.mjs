import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyReleaseValidationRisks } from './release-risk.mjs';

test('release risk classification selects only the heavy evidence required by changed seams', () => {
  assert.deepEqual(classifyReleaseValidationRisks([
    'apps/ui/sources/components/SessionCard.tsx',
    'apps/ui/CHANGELOG.md',
  ]), {
    compatibilityAnalysisRequired: false,
    cliUpgrade: false,
    sessionContinuity: false,
    relayUpgrade: false,
    mysqlContract: false,
    platformServices: false,
    trustRoots: false,
    pluginSdkPackageChanged: false,
    pluginRuntimeCompatibilityRisk: false,
    reasons: {},
  });

  const migration = classifyReleaseValidationRisks([
    'apps/server/prisma/migrations/20260811_add_account_state/migration.sql',
  ]);
  assert.equal(migration.compatibilityAnalysisRequired, true);
  assert.equal(migration.relayUpgrade, true);
  assert.equal(migration.mysqlContract, true);
  assert.equal(migration.sessionContinuity, false);

  const daemon = classifyReleaseValidationRisks([
    'apps/cli/src/daemon/plannedRunnerRestart/restartRunner.ts',
    'packages/cli-common/src/service/manager.ts',
  ]);
  assert.equal(daemon.compatibilityAnalysisRequired, true);
  assert.equal(daemon.cliUpgrade, true);
  assert.equal(daemon.sessionContinuity, true);
  assert.equal(daemon.relayUpgrade, false);
  assert.equal(daemon.platformServices, true);

  const unrelatedDaemonFeature = classifyReleaseValidationRisks([
    'apps/cli/src/daemon/voiceInference/streaming/decoder.ts',
  ]);
  assert.equal(unrelatedDaemonFeature.cliUpgrade, false, 'a daemon-local feature change must not automatically pay the daemon replacement upgrade cost');

  const trustRoot = classifyReleaseValidationRisks([
    'apps/ui/src-tauri/tauri.conf.json',
    'scripts/pipeline/tauri/sign-updater-artifacts.mjs',
  ]);
  assert.equal(trustRoot.trustRoots, true);
  assert.equal(trustRoot.platformServices, true);
});

test('release risk classification treats shared wire and encryption contracts as compatibility seams', () => {
  const risks = classifyReleaseValidationRisks([
    'packages/protocol/src/capabilities/capabilities.ts',
    'packages/protocol/src/encryption/envelope.ts',
  ]);

  assert.equal(risks.compatibilityAnalysisRequired, true);
  assert.equal(risks.sessionContinuity, true);
  assert.equal(risks.relayUpgrade, true);
  assert.deepEqual(Object.keys(risks.reasons).sort(), ['compatibilityAnalysis', 'relayUpgrade', 'sessionContinuity']);
});

test('release risk classification requests semantic compatibility review without inventing a heavy scenario', () => {
  const risks = classifyReleaseValidationRisks([
    'packages/protocol/src/sessions/messages/sessionInputAdmission.ts',
    'apps/server/sources/app/api/routes/version/versionRoutes.ts',
  ]);

  assert.equal(risks.compatibilityAnalysisRequired, true);
  assert.equal(risks.cliUpgrade, false);
  assert.equal(risks.sessionContinuity, true, 'session wire changes require the existing continuity evidence');
  assert.equal(risks.relayUpgrade, false, 'a compatible API route change does not imply a Docker upgrade');
  assert.ok(risks.reasons.compatibilityAnalysis.includes('apps/server/sources/app/api/routes/version/versionRoutes.ts'));
});

test('release risk classification separates public plugin package changes from host-plugin runtime compatibility', () => {
  const packageOnly = classifyReleaseValidationRisks([
    'packages/plugin-ui/api-declarations.md',
    'scripts/api-governance/apiGovernance.mjs',
  ]);
  assert.equal(packageOnly.pluginSdkPackageChanged, true);
  assert.equal(packageOnly.pluginRuntimeCompatibilityRisk, false);

  const runtimeSeam = classifyReleaseValidationRisks([
    'apps/cli/src/plugins/runtime/loadPluginRuntime.ts',
    'packages/plugin-sdk/src/registration/registration.ts',
  ]);
  assert.equal(runtimeSeam.pluginSdkPackageChanged, true);
  assert.equal(runtimeSeam.pluginRuntimeCompatibilityRisk, true);
  assert.deepEqual(runtimeSeam.reasons.pluginRuntimeCompatibilityRisk, [
    'apps/cli/src/plugins/runtime/loadPluginRuntime.ts',
    'packages/plugin-sdk/src/registration/registration.ts',
  ]);
});
