import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertHostedArtifactNativeChildProofComplete,
  assertHostedArtifactRuntimeIdentity,
  buildHostedArtifactCapabilityProbeScript,
  buildHostedArtifactIdentityProbeScript,
  buildHostedArtifactRouteProbeScript,
  unwrapTauriMcpValue,
} from './tauriHostedArtifactPluginUiMcpQa.mjs';

test('capability probe uses the incumbent fail-closed Tauri command', () => {
  const script = buildHostedArtifactCapabilityProbeScript();
  assert.match(script, /desktop_hosted_artifact_get_frame_capability/u);
  assert.doesNotMatch(script, /open_view|proved_for|override/u);
});

test('identity probe reads the incumbent mounted interaction boundary', () => {
  const script = buildHostedArtifactIdentityProbeScript({ surfaceId: 'review-dashboard' });
  assert.match(script, /plugin-surface-interaction-boundary:review-dashboard/u);
  assert.match(script, /data-plugin-artifact-digest/u);
  assert.match(script, /data-plugin-generation/u);
});

test('route probe reads the final router-owned location', () => {
  assert.match(buildHostedArtifactRouteProbeScript(), /window\.location\.pathname/u);
});

test('MCP envelopes unwrap to the returned Tauri value', () => {
  assert.deepEqual(unwrapTauriMcpValue({
    content: [{ text: JSON.stringify({ kind: 'unavailable', code: 'desktop_hosted_artifact_platform_frame_unproved' }) }],
  }), {
    kind: 'unavailable',
    code: 'desktop_hosted_artifact_platform_frame_unproved',
  });
});

test('runtime identity requires exact source generation, artifact, machine, and server', () => {
  const expected = {
    pluginId: 'examples.production-hosted-reference',
    generation: 'generation-7',
    artifactDigest: 'sha256:abc',
    machineId: 'machine-a',
    serverId: 'server-a',
  };
  assert.deepEqual(assertHostedArtifactRuntimeIdentity({
    kind: 'present',
    interactionState: 'enabled',
    ...expected,
  }, expected), {
    kind: 'present',
    interactionState: 'enabled',
    ...expected,
  });
  assert.throws(() => assertHostedArtifactRuntimeIdentity({
    kind: 'present',
    interactionState: 'enabled',
    ...expected,
    generation: 'stale-generation',
  }, expected), /surface_identity_mismatch:generation/u);
});

test('capture-preparation recordings never satisfy the loaded native-child proof gate', () => {
  const artifactRoot = '/tmp/hosted-artifact-capture';
  // Discriminating: the identical recorded state with nativeChildProofComplete
  // flipped to true must pass, so this test fails any gate that ignores the
  // recorded state instead of reading it.
  assert.deepEqual(
    assertHostedArtifactNativeChildProofComplete({
      artifactRoot,
      proof: { kind: 'native_child_checks_complete', hostBoundaryOnly: false, nativeChildProofComplete: true },
    }),
    { kind: 'native_child_checks_complete', hostBoundaryOnly: false, nativeChildProofComplete: true },
  );
  assert.throws(
    () => assertHostedArtifactNativeChildProofComplete({
      artifactRoot,
      proof: { kind: 'capture_ready_for_native_child_checks', hostBoundaryOnly: true, nativeChildProofComplete: false },
    }),
    (error) => {
      assert.match(error.message, /desktop_hosted_artifact_native_child_proof_blocked/u);
      assert.match(error.message, /capture_ready_for_native_child_checks/u);
      assert.ok(error.message.includes(artifactRoot));
      return true;
    },
  );
});

test('missing or malformed recorded proof state fails closed', () => {
  assert.throws(
    () => assertHostedArtifactNativeChildProofComplete({ artifactRoot: '/tmp/capture', proof: undefined }),
    /desktop_hosted_artifact_native_child_proof_blocked:proof_state_missing/u,
  );
  assert.throws(
    () => assertHostedArtifactNativeChildProofComplete({ artifactRoot: '/tmp/capture', proof: { nativeChildProofComplete: 'yes' } }),
    /desktop_hosted_artifact_native_child_proof_blocked/u,
  );
});

test('runtime identity refuses a non-interactive retained host boundary', () => {
  const expected = {
    pluginId: 'examples.production-hosted-reference',
    generation: 'generation-7',
    artifactDigest: 'sha256:abc',
    machineId: 'machine-a',
    serverId: 'server-a',
  };
  assert.throws(() => assertHostedArtifactRuntimeIdentity({
    kind: 'present',
    interactionState: 'offline-snapshot',
    ...expected,
  }, expected), /surface_not_interactive/u);
});
