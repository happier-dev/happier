import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import test from 'node:test';

import * as tar from 'tar';
import { renderPackedExternalAgentExecutable } from './packed-external-agent-executable.mjs';
import * as packedAuthorHarness from './run-packed-author-ui-compat.mjs';

import {
  assertCleanupFailureDidNotBlockLaterMutation,
  assertContinuousHealthEvidence,
  assertDaemonAgentCarrierFailClosed,
  assertDiscardedDisableCurrentness,
  assertExplicitHealthHistoryClear,
  assertPackedBundledClaudeMaterialization,
  assertPackedAuthorCandidateInstallerArtifacts,
  assertPackedConnectedAccountDormancy,
  assertPackedConnectedAccountWatchRematerialization,
  assertPackedAuthorCredentialSentinelsAbsent,
  assertNoEligibleLkgDisabled,
  assertPostRestartHealthyPeerIsolation,
  assertQuarantinedExplicitRollback,
  assertExactMarketplaceInstallationState,
  assertRejectedCandidateNotAttributedToCurrentHealth,
  assertReviewedCandidatePreservedCurrentness,
  assertTryOnceReinstallQuarantine,
  assertUniqueSupervisedAttemptProgress,
  waitForSupervisedAttemptProgress,
  assertVerticalAStageCoverage,
  assertPluginCommandAbsentFromRootHelp,
  assertRestartPreservedDesiredGeneration,
  assertVerticalANotificationLifecycleEvidence,
  assertVerticalAScmInstalledProbe,
  assertVerticalAScmUninstalledProbe,
  assertPackedCliEntrypoint,
  assertPackedDaemonRuntimeIdentity,
  assertPackedNovelConnectedAccountQaCandidate,
  assertPackedPackageIdentity,
  buildVerticalAEvidenceLayerResult,
  buildVerticalAResult,
  buildVerticalADaemonRestartArgs,
  classifySyntheticNpmRegistryRequest,
  cleanupPrivateRegistryFixture,
  cleanupPackedNovelConnectedAccountQaHandoff,
  createExtraCaBundleRefresher,
  createPackedNovelConnectedAccountQaHandoff,
  configureDescriptorOnlyManifest,
  configureVerticalAPlugin,
  configureVerticalAManifest,
  inspectGeneratedScaffoldPackage,
  materializePackedCli,
  loadPackedAuthorCandidateManifest,
  loadPackedAuthorNaturalArtifacts,
  loadPackedNovelConnectedAccountQaHandoff,
  parseSuccessfulCommandEnvelope,
  parseCandidateManifest,
  parseRunnerArgs,
  prepareVerticalAChildEnvironment,
  runVerticalA,
  runPackedReviewedPluginInstall,
  resolvePackedCliEntrypoint,
  resolvePackedScmRepositoryAuth,
  sha512Sri,
  startCandidateRegistry,
  startPackedNovelConnectedAccountAuthorizationServer,
  startPrivatePluginRegistry,
  summarizeBundledClaudeCleanupFailure,
  VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS,
  VERTICAL_A_REQUIRED_STAGE_IDS,
} from './run-packed-author-ui-compat.mjs';

const packedScmIds = {
  backendId: 'acme.vertical-a/stacked',
  hostingProviderId: 'acme.vertical-a/forge',
};

function candidateInstallerRecords(root = '/tmp/installers') {
  return {
    releaseChannel: 'dev',
    shell: {
      kind: 'shell',
      fileName: 'install-dev.sh',
      sizeBytes: 17,
      sha256: '1'.repeat(64),
      filePath: join(root, 'install-dev.sh'),
    },
    powershell: {
      kind: 'powershell',
      fileName: 'install-dev.ps1',
      sizeBytes: 19,
      sha256: '2'.repeat(64),
      filePath: join(root, 'install-dev.ps1'),
    },
    publicKey: {
      kind: 'minisign-public-key',
      fileName: 'happier-release.pub',
      sizeBytes: 21,
      sha256: '3'.repeat(64),
      filePath: join(root, 'happier-release.pub'),
    },
  };
}

test('qualified Connected Account HTTP failure diagnostics omit query identity and credential bytes', () => {
  const diagnostic =
    packedAuthorHarness.formatPackedQualifiedConnectedAccountHttpFailure({
      method: 'DELETE',
      path:
        '/v4/connect/qualified/credential'
        + '?ref=account-reference-sentinel'
        + '&expectedCredentialRevision=revision-sentinel',
      status: 400,
    });

  assert.equal(
    diagnostic,
    'Packed Qualified Connected Account DELETE /v4/connect/qualified/credential failed (400)',
  );
  for (const forbidden of [
    'account-reference-sentinel',
    'revision-sentinel',
    '?ref=',
  ]) {
    assert.equal(diagnostic.includes(forbidden), false);
  }
});

test('bundled Claude cleanup failure summary excludes credential and account material', () => {
  const expectedCredentialRevision = 'revision-sentinel';
  const summary = summarizeBundledClaudeCleanupFailure({
    expectedCredentialRevision,
    cleanup: {
      account: {
        service: {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
        accountId: 'account-reference-sentinel',
      },
      credentialBeforeRevoke: {
        credentialRevision: expectedCredentialRevision,
        content: { t: 'encrypted', c: 'sealed-envelope-sentinel' },
        token: 'plain-token-sentinel',
        credentialSecretRef: 'secret-ref-sentinel',
      },
      revoked: {
        status: 'unavailable',
        code: 'ERR_BAD_REQUEST',
      },
      credentialAfterRevoke: {
        credentialRevision: expectedCredentialRevision,
        content: { t: 'encrypted', c: 'sealed-envelope-sentinel' },
      },
      accountAfterRevoke: {
        ref: {
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
          accountId: 'account-reference-sentinel',
        },
        status: 'connected',
      },
    },
  });

  assert.deepEqual(summary, {
    credentialBeforeRevokePresent: true,
    credentialRevisionMatched: true,
    revoke: {
      status: 'unavailable',
      code: 'ERR_BAD_REQUEST',
      remoteStatus: null,
    },
    durableCredentialPresent: true,
    durableAccountPresent: true,
  });
  const serialized = JSON.stringify(summary);
  for (const forbidden of [
    'sealed-envelope-sentinel',
    'plain-token-sentinel',
    'secret-ref-sentinel',
    'account-reference-sentinel',
    'revision-sentinel',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('packed Connected Account watch assertion requires public selection denial and level-triggered rematerialization', () => {
  const selectionEnvelope = {
    ok: true,
    data: {
      result: {
        status: 'unavailable',
        code: 'plugin_ui_unavailable',
      },
    },
  };
  const watchEnvelope = {
    ok: true,
    data: {
      result: {
        resyncCount: 2,
        observations: [{
          purpose: 'packed-novel-account',
          targetKind: 'group',
          accountId: 'account-b',
          materializationKind: 'environment',
        }, {
          purpose: 'packed-novel-account',
          targetKind: 'group',
          accountId: 'account-a',
          materializationKind: 'environment',
        }],
      },
    },
  };
  const mutation = {
    group: {
      ref: {
        service: {
          pluginId: 'acme.vertical-a',
          localId: 'novel-cloud',
        },
        groupId: 'packed-fallback',
      },
      activeConnectedAccountId: 'account-a',
    },
  };

  assert.deepEqual(assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope,
    mutation,
  }), {
    selection: 'plugin_ui_unavailable',
    resyncCount: 2,
    rematerializedAccountIds: ['account-b', 'account-a'],
  });
  assert.deepEqual(assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope: {
      ...watchEnvelope,
      data: {
        result: {
          resyncCount: 3,
          observations: [
            watchEnvelope.data.result.observations[0],
            watchEnvelope.data.result.observations[0],
            watchEnvelope.data.result.observations[1],
          ],
        },
      },
    },
    mutation,
  }), {
    selection: 'plugin_ui_unavailable',
    resyncCount: 3,
    rematerializedAccountIds: ['account-b', 'account-b', 'account-a'],
  });

  assert.throws(() => assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope: {
      ...watchEnvelope,
      data: {
        result: {
          ...watchEnvelope.data.result,
          resyncCount: 1,
          observations: watchEnvelope.data.result.observations.slice(0, 1),
        },
      },
    },
    mutation,
  }), /level-triggered rematerialization/u);
});

test('packed Connected Account dormancy assertion preserves durable state and requires fresh authorized materialization', () => {
  const durable = {
    binding: {
      purpose: 'packed-novel-account',
      target: {
        kind: 'group',
        service: {
          pluginId: 'acme.vertical-a',
          localId: 'novel-cloud',
        },
        groupId: 'packed-fallback',
      },
    },
    group: {
      ref: {
        service: {
          pluginId: 'acme.vertical-a',
          localId: 'novel-cloud',
        },
        groupId: 'packed-fallback',
      },
      activeConnectedAccountId: 'device-account',
      members: [{
        connectedAccountId: 'device-account',
        priority: 30,
      }],
      generation: 9,
      runtimeStateRevision: 4,
    },
    account: {
      accountId: 'device-account',
      status: 'connected',
      credentialPresent: true,
      configurationPresent: true,
    },
  };
  const dormant = {
    ...structuredClone(durable),
    runtime: {
      status: 'unavailable',
      code: 'connected_account_daemon_runtime_unavailable',
    },
  };
  const reenabled = structuredClone(durable);
  const materializationEnvelope = {
    ok: true,
    data: {
      result: {
        binding: {
          purpose: 'packed-novel-account',
          service: {
            pluginId: 'acme.vertical-a',
            localId: 'novel-cloud',
          },
          target: {
            kind: 'group',
            displayName: 'Packed fallback accounts',
          },
        },
        materializationKind: 'environment',
        accountId: 'device-account',
        credentialVerified: true,
      },
    },
  };

  assert.deepEqual(assertPackedConnectedAccountDormancy({
    baseline: durable,
    dormant,
    reenabled,
    materializationEnvelope,
  }), {
    dormantRuntime: 'connected_account_daemon_runtime_unavailable',
    preservedAccountId: 'device-account',
    preservedGroupId: 'packed-fallback',
    rematerializedAccountId: 'device-account',
  });

  assert.throws(() => assertPackedConnectedAccountDormancy({
    baseline: durable,
    dormant: {
      ...dormant,
      group: {
        ...dormant.group,
        members: [],
      },
    },
    reenabled,
    materializationEnvelope,
  }), /durable Connected Account state/u);
});

test('whole-run packed evidence rejects every synthetic credential sentinel from output, logs, and result', () => {
  const sentinels = [
    'synthetic-private-token-v1',
    'token-a-reconnected',
    'packed-oauth-client-secret',
  ];
  assert.doesNotThrow(() => assertPackedAuthorCredentialSentinelsAbsent({
    commandOutputs: [{ stdout: '{"ok":true}', stderr: '' }],
    logs: ['server ready'],
    markerLog: 'registered:1.0.0:00000000-0000-0000-0000-000000000000:123\n',
    result: { ok: true, credentialState: 'redacted' },
    sentinels,
  }));
  for (const [surface, value] of [
    ['command stdout', {
      commandOutputs: [{ stdout: `leak:${sentinels[0]}`, stderr: '' }],
      markerLog: '',
      result: {},
    }],
    ['command stderr', {
      commandOutputs: [{ stdout: '', stderr: `leak:${sentinels[1]}` }],
      markerLog: '',
      result: {},
    }],
    ['marker log', {
      commandOutputs: [],
      markerLog: `leak:${sentinels[2]}`,
      result: {},
    }],
    ['log', {
      commandOutputs: [],
      logs: [`leak:${sentinels[1]}`],
      markerLog: '',
      result: {},
    }],
    ['result', {
      commandOutputs: [],
      markerLog: '',
      result: { leaked: sentinels[0] },
    }],
  ]) {
    assert.throws(
      () => assertPackedAuthorCredentialSentinelsAbsent({
        ...value,
        sentinels,
      }),
      new RegExp(`credential sentinel.*${surface}`, 'u'),
    );
  }
});

test('vertical-a accepts the public identity-minimized Connected Account binding after verified materialization', () => {
  const envelope = {
    v: 1,
    ok: true,
    kind: 'plugin_command',
    data: {
      result: {
        binding: {
          purpose: 'packed-claude-account',
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
          target: {
            kind: 'account',
            displayName: 'Claude setup token',
          },
        },
        materializationKind: 'environment',
        credentialVerified: true,
      },
    },
  };

  assert.doesNotThrow(() => assertPackedBundledClaudeMaterialization({
    envelope,
  }));
  for (const result of [
    {
      ...envelope.data.result,
      binding: {
        ...envelope.data.result.binding,
        purpose: 'other-purpose',
      },
    },
    {
      ...envelope.data.result,
      binding: {
        ...envelope.data.result.binding,
        service: {
          ...envelope.data.result.binding.service,
          localId: 'other-service',
        },
      },
    },
    {
      ...envelope.data.result,
      binding: {
        ...envelope.data.result.binding,
        target: {
          ...envelope.data.result.binding.target,
          kind: 'group',
        },
      },
    },
    {
      ...envelope.data.result,
      binding: {
        ...envelope.data.result.binding,
        target: {
          ...envelope.data.result.binding.target,
          displayName: '',
        },
      },
    },
    {
      ...envelope.data.result,
      credentialVerified: false,
    },
  ]) {
    assert.throws(
      () => assertPackedBundledClaudeMaterialization({
        envelope: {
          ...envelope,
          data: { result },
        },
      }),
      /did not reach the public host service/u,
    );
  }
});

test('vertical-a SCM fixture materializes concrete auth for every publish-target success', () => {
  const providedAuth = {
    state: 'authenticated',
    profileKind: 'connected_account',
    profileKey: 'packed-account',
  };

  assert.equal(resolvePackedScmRepositoryAuth(providedAuth), providedAuth);
  assert.deepEqual(resolvePackedScmRepositoryAuth(undefined), {
    state: 'unknown',
    profileKind: 'unknown',
  });
});

function packedScmProjection(entries = {}) {
  return {
    protocolVersion: 1,
    projection: {
      v: 2,
      generation: 17,
      familiesById: {
        scmBackends: {
          family: 'scmBackends',
          entriesById: entries.backends ?? {},
        },
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: entries.providers ?? {},
        },
        pluginBrowser: {
          family: 'pluginBrowser',
          entriesById: entries.browser ?? {},
        },
      },
    },
  };
}

test('vertical-a SCM probe requires qualified projection, preferred runtime, repository, and auth evidence', () => {
  const probe = {
    projection: packedScmProjection({
      backends: {
        [packedScmIds.backendId]: {
          id: packedScmIds.backendId,
          localId: 'stacked',
          pluginId: 'acme.vertical-a',
        },
      },
      providers: {
        [packedScmIds.hostingProviderId]: {
          id: packedScmIds.hostingProviderId,
          localId: 'forge',
          pluginId: 'acme.vertical-a',
          authService: { pluginId: 'acme.vertical-a', localId: 'novel-cloud' },
        },
      },
      browser: {
        'browserTarget:acme.vertical-a:preview': {
          id: 'browserTarget:acme.vertical-a:preview',
          pluginId: 'acme.vertical-a',
          contributionKind: 'browserTarget',
          currentUrl: 'https://preview.example.test/',
          launchMode: 'currentView',
        },
        'browserAction:acme.vertical-a:preview-roundtrip': {
          id: 'browserAction:acme.vertical-a:preview-roundtrip',
          pluginId: 'acme.vertical-a',
          contributionKind: 'browserAction',
          qualifiedActionId: 'acme.vertical-a/roundtrip',
          targetId: 'browserTarget:acme.vertical-a:preview',
          placement: 'toolbar',
        },
        'browserAction:acme.vertical-a:preview-details': {
          id: 'browserAction:acme.vertical-a:preview-details',
          pluginId: 'acme.vertical-a',
          contributionKind: 'browserAction',
          qualifiedActionId: 'acme.vertical-a/roundtrip',
          targetId: 'browserTarget:acme.vertical-a:preview',
          placement: 'detailsPanel',
        },
        'browserAction:acme.vertical-a:preview-context': {
          id: 'browserAction:acme.vertical-a:preview-context',
          pluginId: 'acme.vertical-a',
          contributionKind: 'browserAction',
          qualifiedActionId: 'acme.vertical-a/roundtrip',
          targetId: 'browserTarget:acme.vertical-a:preview',
          placement: 'contextMenu',
        },
      },
    }),
    status: {
      success: false,
      errorCode: 'COMMAND_FAILED',
      error: `Packed SCM status reached ${packedScmIds.hostingProviderId}`,
    },
    repository: {
      success: true,
      defaultRepositoryName: 'packed-repository',
      auth: {
        state: 'authenticated',
        profileKind: 'connected_account',
      },
      targets: [{
        provider: { id: packedScmIds.hostingProviderId },
        owner: 'packed-owner',
      }],
    },
  };

  assert.deepEqual(assertVerticalAScmInstalledProbe({ probe, ...packedScmIds }), {
    generation: 17,
    ...packedScmIds,
    authService: { pluginId: 'acme.vertical-a', localId: 'novel-cloud' },
    clientPreference: { kind: 'prefer', backendId: packedScmIds.backendId },
    statusErrorCode: 'COMMAND_FAILED',
    repositoryAuth: probe.repository.auth,
    browserTargetId: 'browserTarget:acme.vertical-a:preview',
    browserActionIds: [
      'browserAction:acme.vertical-a:preview-roundtrip',
      'browserAction:acme.vertical-a:preview-details',
      'browserAction:acme.vertical-a:preview-context',
    ],
  });
  assert.throws(
    () => assertVerticalAScmInstalledProbe({
      probe: { ...probe, status: { success: true } },
      ...packedScmIds,
    }),
    /did not reach the external runtime/u,
  );
});

test('vertical-a SCM uninstall requires authoritative empty families without stale qualified entries', () => {
  assert.doesNotThrow(() => assertVerticalAScmUninstalledProbe({
    probe: { projection: packedScmProjection() },
    ...packedScmIds,
  }));
  assert.throws(() => assertVerticalAScmUninstalledProbe({
    probe: {
      projection: packedScmProjection({
        backends: { [packedScmIds.backendId]: { id: packedScmIds.backendId } },
      }),
    },
    ...packedScmIds,
  }), /left a stale SCM\/browser projection/u);
  assert.throws(() => assertVerticalAScmUninstalledProbe({
    probe: {
      projection: packedScmProjection({
        browser: {
          'browserTarget:acme.vertical-a:preview': {
            id: 'browserTarget:acme.vertical-a:preview',
            pluginId: 'acme.vertical-a',
          },
        },
      }),
    },
    ...packedScmIds,
  }), /left a stale SCM\/browser projection/u);
});

test('vertical-a proves an uninstalled plugin command through the non-executing root-help projection', () => {
  assert.doesNotThrow(() => assertPluginCommandAbsentFromRootHelp({
    stdout: 'Usage:\n  happier plugins\n  happier status\n',
    commandRoot: 'vertical-a',
  }));
  assert.throws(() => assertPluginCommandAbsentFromRootHelp({
    stdout: 'Usage:\n  happier vertical-a  Vertical A roundtrip\n',
    commandRoot: 'vertical-a',
  }), /remained visible/u);
});

const generationReference = (immutableGenerationId, digestSuffix = 'a') => ({
  immutableGenerationId,
  generationRecordDigest: `sha256:${digestSuffix.repeat(64)}`,
  installedArtifactRecord: {
    relativePath: `${immutableGenerationId}.json`,
    digest: `sha256:${digestSuffix.repeat(64)}`,
  },
});

test('vertical-a restart permits health bookkeeping revisions while preserving exact desired bytes', () => {
  const initialGeneration = generationReference('generation-v1');
  assert.doesNotThrow(() => assertRestartPreservedDesiredGeneration({
    initialCommit: { revision: 7, pluginGenerations: { 'acme.vertical-a': initialGeneration } },
    restartCommit: { revision: 8, pluginGenerations: { 'acme.vertical-a': { ...initialGeneration } } },
    pluginId: 'acme.vertical-a',
    desiredGeneration: 'generation-v1',
  }));

  assert.throws(() => assertRestartPreservedDesiredGeneration({
    initialCommit: { revision: 7, pluginGenerations: { 'acme.vertical-a': initialGeneration } },
    restartCommit: {
      revision: 8,
      pluginGenerations: { 'acme.vertical-a': generationReference('generation-v2', 'b') },
    },
    pluginId: 'acme.vertical-a',
    desiredGeneration: 'generation-v1',
  }), /changed durable desired generation/u);

  assert.throws(() => assertRestartPreservedDesiredGeneration({
    initialCommit: { revision: 7, pluginGenerations: { 'acme.vertical-a': initialGeneration } },
    restartCommit: { revision: 6, pluginGenerations: { 'acme.vertical-a': initialGeneration } },
    pluginId: 'acme.vertical-a',
    desiredGeneration: 'generation-v1',
  }), /changed durable desired generation/u);
});

test('reviewed candidate permits health bookkeeping while preserving exact installed currentness', () => {
  const initialGeneration = generationReference('generation-v1');
  const installedPlugin = {
    pluginId: 'acme.vertical-a',
    enabled: true,
    desiredGeneration: 'generation-v1',
    appliedGeneration: 'generation-v1',
  };

  assert.doesNotThrow(() => assertReviewedCandidatePreservedCurrentness({
    initialCommit: {
      revision: 7,
      pluginGenerations: { 'acme.vertical-a': initialGeneration },
    },
    currentCommit: {
      revision: 8,
      transactionId: 'health-only',
      pluginGenerations: { 'acme.vertical-a': { ...initialGeneration } },
    },
    pluginId: 'acme.vertical-a',
    desiredGeneration: 'generation-v1',
    installedPlugin,
  }));

  assert.throws(() => assertReviewedCandidatePreservedCurrentness({
    initialCommit: {
      revision: 7,
      pluginGenerations: { 'acme.vertical-a': initialGeneration },
    },
    currentCommit: {
      revision: 8,
      pluginGenerations: {
        'acme.vertical-a': generationReference('generation-v2', 'b'),
      },
    },
    pluginId: 'acme.vertical-a',
    desiredGeneration: 'generation-v1',
    installedPlugin,
  }), /changed canonical currentness/u);

  assert.throws(() => assertReviewedCandidatePreservedCurrentness({
    initialCommit: {
      revision: 7,
      pluginGenerations: { 'acme.vertical-a': initialGeneration },
    },
    currentCommit: {
      revision: 8,
      pluginGenerations: { 'acme.vertical-a': initialGeneration },
    },
    pluginId: 'acme.vertical-a',
    desiredGeneration: 'generation-v1',
    installedPlugin: { ...installedPlugin, enabled: false },
  }), /changed canonical currentness/u);
});

test('vertical-a preserves the scaffold development entry while selecting its built daemon entry', () => {
  const configured = configureVerticalAManifest({
    manifest: {
      id: 'acme.vertical-a',
      entrypoints: { daemon: './old-build.js', development: './src/index.ts' },
      contributes: {
        ui: {
          views: [{
            id: 'main',
            placement: 'app.sidePanel',
            renderer: 'main-web',
            title: 'Vertical A',
          }],
          renderers: [{
            id: 'main-web',
            kind: 'hostedWeb',
            source: { kind: 'artifact', artifact: 'main-web' },
            requiredHostMethods: ['context'],
          }],
          translations: [],
        },
      },
    },
    version: '1.0.0',
    pluginId: 'acme.vertical-a',
    fetchOrigin: 'http://127.0.0.1:43123',
    connectedAccountOrigin: 'https://127.0.0.1:43124',
  });

  assert.deepEqual(configured.entrypoints, {
    daemon: './dist/index.js',
    development: './src/index.ts',
  });
  assert.deepEqual(configured.runtime, { apiVersion: 1 });
  assert.deepEqual(configured.contributes.actions[0].surfaces, ['agent', 'mcp', 'cli', 'ui']);
  assert.deepEqual(configured.contributes.actions[0].hostAccess, [
    'packed-notification-token',
    'packed-fetch',
    'packed-interceptor-fetch-target',
    'packed-novel-account',
    'packed-claude-account',
  ]);
  assert.deepEqual(configured.contributes.tools, [{
    id: 'roundtrip-tool',
    name: 'vertical_a_roundtrip',
    title: 'Vertical A roundtrip tool',
    description: 'Invoke the packed Vertical A roundtrip action.',
    safety: 'safe',
    surfaces: ['agent', 'mcp', 'cli'],
    inputSchema: {
      type: 'object',
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
    },
    inputHints: {
      description: 'Input forwarded to the one declared roundtrip action.',
      fields: [{
        path: 'operation',
        title: 'Operation',
        widget: 'text',
      }],
    },
    examples: {
      mcp: { argsExample: '{"operation":"packed-tool-dispatch"}' },
    },
    promptSnippet: 'Use vertical_a_roundtrip for the packed Vertical A action.',
    promptGuidelines: ['Invoke the declared action through this presentation.'],
    action: 'roundtrip',
  }]);
  assert.deepEqual(configured.contributes.structuredMessages, [{
    id: 'roundtrip-result',
    title: 'Vertical A roundtrip result',
    kind: 'acme.vertical-a/roundtrip-result.v1',
    payloadSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
    renderer: 'roundtrip-card',
    actions: ['roundtrip'],
    fallback: { kind: 'summary', template: 'Vertical A: {message}' },
  }]);
  assert.deepEqual(configured.contributes.sessionHeaderActions, [{
    id: 'roundtrip-header',
    title: 'Run Vertical A roundtrip',
    action: 'roundtrip',
    order: 10,
  }]);
  assert.deepEqual(
    configured.contributes.ui.views.map(({ id, renderer }) => ({ id, renderer })),
    [{ id: 'main', renderer: 'main-web' }],
  );
  assert.deepEqual(
    configured.contributes.ui.renderers.map(({ id, kind }) => ({ id, kind })),
    [
      { id: 'main-web', kind: 'hostedWeb' },
      { id: 'roundtrip-card', kind: 'declarative' },
    ],
  );
  const reconfigured = configureVerticalAManifest({
    manifest: configured,
    version: '1.1.0',
    pluginId: 'acme.vertical-a',
    fetchOrigin: 'http://127.0.0.1:43123',
    connectedAccountOrigin: 'https://127.0.0.1:43124',
  });
  assert.deepEqual(
    reconfigured.contributes.ui.renderers.map(({ id, kind }) => ({ id, kind })),
    [
      { id: 'main-web', kind: 'hostedWeb' },
      { id: 'roundtrip-card', kind: 'declarative' },
    ],
  );
  assert.deepEqual(
    configured.contributes.ui.renderers[0].requiredHostMethods,
    ['context', 'executeAction'],
  );
  assert.deepEqual(configured.contributes.events, [{
    id: 'notification-ready',
    kind: 'event',
    title: 'Packed notification ready',
    payloadSchema: {
      type: 'object',
      properties: { clientRequestId: { type: 'string' } },
      required: ['clientRequestId'],
      additionalProperties: false,
    },
  }, {
    id: 'observe-notification-ready',
    kind: 'subscription',
    event: 'notification-ready',
  }]);
  assert.deepEqual(configured.hostAccess.required, [{
    id: 'packed-notification-token',
    capability: 'secrets',
    reason: 'Authenticate the packed notification channel',
    scope: { secretIds: ['webhook.token'], access: ['read'] },
  }, {
    id: 'packed-fetch',
    capability: 'network',
    reason: 'Exercise the packed external fetch and Connected Account producer service',
    scope: {
      targets: [
        { kind: 'connectedAccountOrigin', service: 'novel-cloud' },
      ],
      methods: ['GET', 'POST'],
      privateNetwork: true,
    },
  }, {
    id: 'packed-interceptor-fetch-target',
    capability: 'network',
    reason: 'Fetch the packed interceptor target through the host service',
    scope: {
      targets: [
        { kind: 'fixedOrigin', origin: 'http://127.0.0.1:43123' },
      ],
      methods: ['GET'],
      privateNetwork: true,
    },
  }, {
    id: 'packed-novel-account',
    capability: 'connectedAccounts',
    reason: 'Materialize the selected packed Novel Cloud account',
    scope: {
      serviceRefs: ['novel-cloud'],
      operations: ['use', 'select'],
      materializationKinds: ['environment'],
    },
  }, {
    id: 'packed-claude-account',
    capability: 'connectedAccounts',
    reason: 'Materialize the selected bundled Claude setup-token account',
    scope: {
      serviceRefs: [{
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }],
      operations: ['use'],
      materializationKinds: ['environment'],
    },
  }, {
    id: 'packed-fetch-interceptor',
    capability: 'network.intercept',
    reason: 'Exercise the packed external request interceptor',
    scope: { origins: ['http://127.0.0.1:43123'] },
  }]);
  assert.deepEqual(configured.contributes.requestInterceptors, [{
    id: 'observe-api',
    origins: ['http://127.0.0.1:43123'],
    methods: ['GET'],
  }]);
  assert.deepEqual(configured.contributes.agents, [{
    id: 'packed-external-agent',
    title: 'Packed external sessions Agent',
    cli: {
      displayName: 'Packed external sessions Agent CLI',
      executable: {
        binaryName: 'packed-external-agent',
        sourcePreference: 'system-first',
      },
      install: {
        managed: null,
        manual: { kind: 'none' },
      },
      auth: {
        support: 'unsupported',
        probe: {
          parser: 'none',
          backgroundChecks: 'safe',
          statusArgs: null,
        },
        loginLaunches: [],
      },
    },
    capabilities: { surfaces: ['externalSessions'] },
    surfaces: {
      externalSession: {
        sources: [{
          sourceKind: 'packedExternal',
          schema: {
            passthrough: false,
            fields: [
              { name: 'kind', kind: 'literal', value: 'packedExternal' },
              { name: 'scope', kind: 'literal', value: 'default' },
            ],
          },
          key: {
            segments: [
              { kind: 'literal', value: 'packedExternal' },
              { kind: 'field', field: 'scope' },
            ],
          },
          instances: [{ kind: 'default', constants: { scope: 'default' } }],
        }],
      },
    },
  }]);
  const siblingFixture = configureVerticalAManifest({
    manifest: {
      id: 'acme.private-registry',
      entrypoints: { daemon: './old-build.js', development: './src/index.ts' },
    },
    version: '1.0.0',
    pluginId: 'acme.private-registry',
    fetchOrigin: 'http://127.0.0.1:43123',
  });
  assert.deepEqual(siblingFixture.hostAccess.required, [configured.hostAccess.required[0]]);
  assert.equal(siblingFixture.contributes.requestInterceptors, undefined);
  assert.deepEqual(configured.contributes.notifications, [{
    id: 'packed-ready',
    kind: 'activity',
    title: 'Packed notification ready',
    eventIds: ['notification-ready'],
    defaultChannels: ['webhook'],
  }]);
  assert.deepEqual(
    configured.contributes.notificationChannels[0].settings.map(({ id, secret }) => ({ id, secret: secret === true })),
    [
      { id: 'endpoint', secret: false },
      { id: 'token', secret: true },
    ],
  );
  assert.deepEqual(configured.contributes.scmBackends, [{
    id: 'stacked',
    title: 'Packed Stacked SCM',
    description: 'Packed external SCM backend used by Vertical-A.',
    kind: 'packed-stacked',
    capabilities: ['detect', 'status'],
  }]);
  assert.deepEqual(configured.contributes.scmHostingProviders, [{
    id: 'forge',
    title: 'Packed Forge',
    description: 'Packed external SCM hosting provider used by Vertical-A.',
    kind: 'packed-forge',
    capabilities: ['detect', 'clone'],
    authService: 'novel-cloud',
  }]);
  assert.deepEqual(
    configured.contributes.connectedAccountDescriptors.map(({ id }) => id),
    ['github', 'novel-cloud'],
  );
  const novelConnectedAccount = configured.contributes.connectedAccountDescriptors[1];
  assert.deepEqual(
    novelConnectedAccount.authentication.modes.map(({ id, kind, configuration }) => ({
      id,
      kind,
      configurationScope: configuration?.scope ?? null,
      configurationChangeBehavior: configuration?.changeBehavior ?? null,
    })),
    [{
      id: 'manual',
      kind: 'manual',
      configurationScope: 'service',
      configurationChangeBehavior: 'reconnect',
    }, {
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      configurationScope: 'service',
      configurationChangeBehavior: 'reconnect',
    }, {
      id: 'device',
      kind: 'oauthDeviceCode',
      configurationScope: 'account',
      configurationChangeBehavior: 'refresh',
    }],
  );
  assert.deepEqual(
    novelConnectedAccount.authentication.modes[0].configuration.fields,
    [{
      id: 'api-origin',
      title: 'API origin',
      semantic: 'connectedAccountOrigin',
      schema: { type: 'string', minLength: 1 },
      presentation: {
        control: 'text',
        placeholder: 'https://api.example.com',
      },
      required: true,
    }],
  );
  assert.equal(
    novelConnectedAccount.authentication.modes[1].configuration.fields
      .find(({ id }) => id === 'client-secret')?.secret,
    true,
  );
  assert.equal(
    novelConnectedAccount.authentication.modes[2].configuration.fields
      .find(({ id }) => id === 'account-secret')?.secret,
    true,
  );
  assert.deepEqual(
    configured.contributes.resources.map(({ id, kind, path, contentType }) => ({ id, kind, path, contentType })),
    [
      { id: 'prompt', kind: 'prompt', path: 'resources/prompt.md', contentType: 'text/markdown' },
      { id: 'skill', kind: 'skill', path: 'resources/skill.md', contentType: 'text/markdown' },
      { id: 'template', kind: 'template', path: 'resources/template.txt', contentType: 'text/plain' },
      { id: 'asset', kind: 'asset', path: 'resources/asset.json', contentType: 'application/json' },
      { id: 'config', kind: 'config', path: 'resources/config.json', contentType: 'application/json' },
    ],
  );
  assert.deepEqual(configured.contributes.browserTargets, [{
    id: 'preview',
    title: 'Packed preview',
    url: 'https://preview.example.test/',
    launch: 'currentView',
    profile: 'user',
  }]);
  assert.deepEqual(configured.contributes.browserActions, [{
    id: 'preview-roundtrip',
    title: 'Run packed roundtrip',
    action: 'roundtrip',
    target: 'preview',
    placement: 'toolbar',
    icon: 'play-outline',
  }, {
    id: 'preview-details',
    title: 'Inspect packed preview',
    action: 'roundtrip',
    target: 'preview',
    placement: 'detailsPanel',
    icon: 'search-outline',
  }, {
    id: 'preview-context',
    title: 'Copy packed preview URL',
    action: 'roundtrip',
    target: 'preview',
    placement: 'contextMenu',
    icon: 'copy-outline',
  }]);
  assert.throws(() => configureVerticalAManifest({
    manifest: { id: 'acme.vertical-a', entrypoints: { daemon: './dist/index.js' } },
    version: '1.0.0',
    pluginId: 'acme.vertical-a',
  }), /missing entrypoints\.development/u);
});

test('descriptor-only vertical fixture removes executable ownership while retaining static contributions', () => {
  const configured = configureDescriptorOnlyManifest({
    manifest: {
      id: 'acme.descriptor-only',
      entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
      activation: { events: [{ kind: 'startup' }] },
    },
    version: '1.0.0',
  });

  assert.equal(configured.entrypoints, undefined);
  assert.equal(configured.activation, undefined);
  assert.deepEqual(configured.runtime, { apiVersion: 1 });
  assert.deepEqual(configured.hostAccess, { required: [], optional: [] });
  assert.deepEqual(
    configured.contributes.settings.map((setting) => setting.id),
    ['preferences'],
  );
  assert.deepEqual(
    configured.contributes.ui.renderers.map(({ id, kind }) => ({ id, kind })),
    [{ id: 'settings-form', kind: 'declarative' }],
  );
});

test('vertical-a notification evidence requires configuration, provider failure replay, policy suppression, and retirement', () => {
  const pluginId = 'acme.vertical-a';
  const channelId = `${pluginId}/webhook`;
  const actionResult = (notification) => ({ data: { result: { notification } } });
  const delivery = (status, extra = {}) => ({
    deliveryId: 'notification-delivery-1',
    channelId,
    status,
    ...extra,
  });
  const input = {
    pluginId,
    configuration: {
      storageScope: 'synced',
      values: { 'webhook.endpoint': 'https://notifications.example.test/deliver' },
      redactedKeys: ['webhook.token'],
    },
    success: actionResult({
      replayed: false,
      deliveries: [delivery('accepted', { evidence: 'provider' })],
    }),
    failure: actionResult({
      replayed: false,
      deliveries: [delivery('failed', { code: 'credential_invalid', retryable: false })],
    }),
    replay: actionResult({
      replayed: true,
      deliveries: [delivery('failed', { code: 'credential_invalid', retryable: false })],
    }),
    recovery: actionResult({
      replayed: false,
      deliveries: [delivery('accepted', { evidence: 'provider' })],
    }),
    suppressedPreferences: actionResult({
      categoryId: 'packed-ready',
      enabled: false,
      channelIds: [],
      revision: 'disabled',
    }),
    suppressed: actionResult({
      replayed: false,
      deliveries: [delivery('suppressed', { code: 'plugin_notification_channel_disabled' })],
    }),
    restoredPreferences: actionResult({
      categoryId: 'packed-ready',
      enabled: true,
      channelIds: [channelId],
      revision: 'enabled',
    }),
    eventSubscriptionDeliveries: 5,
    retiredInvocation: { code: 1, signal: null },
  };

  assert.deepEqual(assertVerticalANotificationLifecycleEvidence(input), {
    pluginId,
    channelId,
    configuredEndpoint: 'https://notifications.example.test/deliver',
    secretState: 'redacted-reference',
    acceptedDeliveryId: 'notification-delivery-1',
    replayedFailureDeliveryId: 'notification-delivery-1',
    providerFailure: 'credential_invalid',
    replayedFailure: true,
    policySuppression: 'plugin_notification_channel_disabled',
    eventSubscriptionDeliveries: 5,
    retirement: 'invocation-rejected',
    credentialMaterialExposed: false,
  });
  assert.throws(
    () => assertVerticalANotificationLifecycleEvidence({
      ...input,
      configuration: {
        ...input.configuration,
        values: {
          ...input.configuration.values,
          'webhook.token': 'configured-notification-token',
        },
      },
    }),
    /exposed credential material/u,
  );
  assert.throws(
    () => assertVerticalANotificationLifecycleEvidence({
      ...input,
      replay: input.failure,
    }),
    /failed-result replay returned unexpected delivery evidence/u,
  );
  assert.throws(
    () => assertVerticalANotificationLifecycleEvidence({
      ...input,
      eventSubscriptionDeliveries: 0,
    }),
    /event subscription did not receive/u,
  );
  assert.throws(
    () => assertVerticalANotificationLifecycleEvidence({
      ...input,
      retiredInvocation: { code: 0, signal: null },
    }),
    /unexpectedly remained executable/u,
  );
});

test('vertical-a delegates isolated home authentication without allowing boundary overrides', async () => {
  const calls = [];
  const env = await prepareVerticalAChildEnvironment({
    happyHomeDir: '/tmp/happier-packed-home',
    markerPath: '/tmp/happier-packed-marker',
    baseEnv: { INHERITED: 'yes', PATH: '/usr/bin' },
    prepareHome: async ({ happyHomeDir }) => {
      calls.push(happyHomeDir);
      return {
        HAPPIER_HOME_DIR: '/wrong/home',
        HAPPIER_VERTICAL_A_MARKER: '/wrong/marker',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:9999',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'packed-author-test-scope',
      };
    },
  });

  assert.deepEqual(calls, ['/tmp/happier-packed-home']);
  assert.equal(env.INHERITED, 'yes');
  assert.equal(env.HAPPIER_SERVER_URL, 'http://127.0.0.1:9999');
  assert.equal(env.HAPPIER_HOME_DIR, '/tmp/happier-packed-home');
  assert.equal(env.HAPPIER_VERTICAL_A_MARKER, '/tmp/happier-packed-marker');
  assert.equal(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID, 'packed-author-test-scope');
  assert.equal(env.PATH, '');
});

test('vertical-a admits only its isolated-home executable directory into PATH', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-packed-path-'));
  const ownedBinDir = join(happyHomeDir, 'packed-agent-bin');
  try {
    const env = await prepareVerticalAChildEnvironment({
      happyHomeDir,
      markerPath: join(happyHomeDir, 'marker.log'),
      baseEnv: { PATH: '/usr/bin:/bin' },
      prepareHome: async () => {
        await mkdir(ownedBinDir, { recursive: true });
        return {
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'packed-author-owned-path',
          PATH: ownedBinDir,
        };
      },
    });

    assert.equal(env.PATH, await realpath(ownedBinDir));
    await assert.rejects(
      prepareVerticalAChildEnvironment({
        happyHomeDir,
        markerPath: join(happyHomeDir, 'marker.log'),
        baseEnv: {},
        prepareHome: async () => ({
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'packed-author-foreign-path',
          PATH: '/usr/bin',
        }),
      }),
      /PATH entries must remain inside the isolated home/u,
    );
  } finally {
    await rm(happyHomeDir, { recursive: true, force: true });
  }
});

test('packed external Agent executable resolves its version without ambient PATH commands', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-packed-agent-executable-'));
  try {
    const ownedBinDir = join(happyHomeDir, 'packed-agent-bin');
    await mkdir(ownedBinDir, { recursive: true });
    const fixture = renderPackedExternalAgentExecutable(
      process.platform === 'win32' ? 'win32' : 'darwin',
    );
    const executable = join(ownedBinDir, fixture.fileName);
    await writeFile(executable, fixture.contents, 'utf8');
    if (process.platform !== 'win32') await chmod(executable, 0o755);

    const result = spawnSync(executable, ['--version'], {
      env: { PATH: ownedBinDir },
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /\b1\.0\.0\b/u);
  } finally {
    await rm(happyHomeDir, { recursive: true, force: true });
  }
});

test('vertical-a strips ambient source injection from npm and installed children while preserving runtime inputs', async () => {
  const ambient = {
    HOME: '/home/packed',
    TMPDIR: '/tmp/packed',
    HTTP_PROXY: 'http://proxy.example',
    NODE_EXTRA_CA_CERTS: '/tmp/test-ca.pem',
    HAPPIER_SERVER_URL: 'http://127.0.0.1:9999',
    AUTH_TOKEN: 'test-token',
    NODE_OPTIONS: '--import /workspace/inject.mjs',
    node_path: '/workspace/node_modules',
    DYLD_INSERT_LIBRARIES: '/workspace/inject.dylib',
    ld_preload: '/workspace/inject.so',
    OPENSSL_CONF: '/workspace/openssl.cnf',
    openssl_modules: '/workspace/providers',
    BUN_OPTIONS: '--preload /workspace/inject.mjs',
    bun_be_bun: '1',
    YARN_RC_FILENAME: '/workspace/hostile.yarnrc',
    COREPACK_HOME: '/workspace/corepack',
    npm_config_userconfig: '/workspace/hostile.npmrc',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '/workspace/apps/cli/src/index.ts',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
    HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
    HAPPIER_DAEMON_SERVICE_NODE_PATH: '/workspace/node',
    HAPPIER_JS_RUNTIME_PATH: '/workspace/node',
    HAPPIER_MANAGED_NODE_BIN: '/workspace/node',
    HAPPIER_NODE_PATH: '/workspace/node',
    HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: '{"codex":"/workspace/source"}',
    TSX_TSCONFIG_PATH: '/workspace/tsconfig.json',
  };

  const childEnv = await prepareVerticalAChildEnvironment({
    happyHomeDir: '/tmp/happier-packed-home',
    markerPath: '/tmp/happier-packed-marker',
    baseEnv: ambient,
    prepareHome: async () => ({
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'packed-author-test-scope',
      NODE_OPTIONS: '--require /workspace/reintroduced.cjs',
      HAPPIER_CLI_SUBPROCESS_RUNTIME: '/workspace/node',
    }),
  });
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.HAPPIER_CLI_SUBPROCESS_RUNTIME, undefined);
  assert.equal(childEnv.HOME, '/home/packed');
  assert.equal(childEnv.HTTP_PROXY, 'http://proxy.example');
  assert.equal(childEnv.TMPDIR, '/tmp/packed');
  assert.equal(childEnv.NODE_EXTRA_CA_CERTS, '/tmp/test-ca.pem');
  assert.equal(childEnv.HAPPIER_SERVER_URL, 'http://127.0.0.1:9999');
  assert.equal(childEnv.AUTH_TOKEN, 'test-token');
  for (const key of Object.keys(ambient).filter((key) => ![
    'HOME',
    'TMPDIR',
    'HTTP_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'HAPPIER_SERVER_URL',
    'AUTH_TOKEN',
  ].includes(key))) {
    assert.equal(childEnv[key], undefined, `${key} must not cross the packed artifact boundary`);
  }
});

test('vertical-a rejects an unauthenticated isolated home before running the packed boundary', async () => {
  await assert.rejects(
    prepareVerticalAChildEnvironment({
      happyHomeDir: '/tmp/happier-packed-home',
      markerPath: '/tmp/happier-packed-marker',
      baseEnv: {},
    }),
    /authenticated isolated-home preparation.*test:plugin-platform:packed-author/iu,
  );
});

test('vertical-a refuses a composed daemon without a canonical isolated lifecycle scope', async () => {
  await assert.rejects(
    prepareVerticalAChildEnvironment({
      happyHomeDir: '/tmp/happier-packed-home',
      markerPath: '/tmp/happier-packed-marker',
      baseEnv: {},
      prepareHome: async () => ({
        HAPPIER_SERVER_URL: 'http://127.0.0.1:9999',
      }),
    }),
    /isolated daemon lifecycle scope/iu,
  );
});

test('vertical-a rejects inherited daemon authority that bypassed canonical environment sanitization', async () => {
  await assert.rejects(
    prepareVerticalAChildEnvironment({
      happyHomeDir: '/tmp/happier-packed-home',
      markerPath: '/tmp/happier-packed-marker',
      baseEnv: {
        HAPPIER_STACK_ID: 'inherited-stack',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'inherited-service',
        TMUX: 'inherited-tmux',
      },
      prepareHome: async () => ({
        HAPPIER_SERVER_URL: 'http://127.0.0.1:9999',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'packed-author-test-scope',
      }),
    }),
    /canonical daemon environment sanitization/iu,
  );
});

test('vertical-a restarts only its isolated daemon scope without takeover authority', () => {
  assert.deepEqual(buildVerticalADaemonRestartArgs(), ['daemon', 'restart', '--json']);
});

test('vertical-a treats a discarded disable response as resolved when current state is disabled and not applied', () => {
  const input = {
    discardedDisableResponse: { responseBodyDiscarded: true },
    installedPlugin: {
      enabled: false,
      desiredGeneration: 'generation-1',
      appliedGeneration: null,
    },
    installation: { enabled: false },
    runtimeCatalog: { state: { enabled: false } },
    expectedGeneration: 'generation-1',
  };

  assert.doesNotThrow(() => assertDiscardedDisableCurrentness(input));
  assert.throws(
    () => assertDiscardedDisableCurrentness({
      ...input,
      installedPlugin: {
        ...input.installedPlugin,
        appliedGeneration: 'generation-1',
      },
    }),
    /discarded disable response/u,
  );
});

test('vertical-a retires the private-registry fixture before resetting shared activation evidence', async () => {
  const calls = [];
  const result = await cleanupPrivateRegistryFixture({
    pluginId: 'acme.private-registry',
    markerPath: '/tmp/vertical-a-activation.log',
    activationInstances: [
      { version: '10.0.0', activationInstanceId: 'private-v1' },
      { version: '11.0.0', activationInstanceId: 'private-v2' },
    ],
    uninstallPlugin: async () => {
      calls.push('uninstall');
      return {
        data: {
          desiredGeneration: null,
          appliedGeneration: null,
        },
      };
    },
    waitForCleanup: async ({ version, activationInstanceId }) => {
      calls.push(`cleanup:${version}:${activationInstanceId}`);
    },
    clearMarker: async (markerPath) => {
      calls.push(`clear:${markerPath}`);
    },
  });

  assert.deepEqual(result, { desiredGeneration: null, appliedGeneration: null });
  assert.equal(calls[0], 'uninstall');
  assert.equal(calls.at(-1), 'clear:/tmp/vertical-a-activation.log');
  assert.deepEqual(new Set(calls.slice(1, -1)), new Set([
    'cleanup:10.0.0:private-v1',
    'cleanup:11.0.0:private-v2',
  ]));
});

test('vertical-a reinstalls the retired private-registry fixture before using it as a healthy control', async () => {
  const calls = [];
  const result = await packedAuthorHarness.installVerticalAHealthyControlFixture({
    plugin: {
      pluginId: 'acme.private-registry',
      root: '/tmp/private-registry-plugin',
    },
    sdkRegistryOrigin: 'https://registry.example.test',
    installPlugin: async (args) => {
      calls.push(args);
      return {
        change: {
          kind: 'committed',
          pluginId: 'acme.private-registry',
          desiredGeneration: 'healthy-generation',
          appliedGeneration: 'healthy-generation',
        },
      };
    },
  });

  assert.deepEqual(calls, [[
    'plugins', 'install', '/tmp/private-registry-plugin',
    '--dev',
    '--sdk-registry', 'https://registry.example.test',
    '--json',
  ]]);
  assert.deepEqual(result, {
    pluginId: 'acme.private-registry',
    desiredGeneration: 'healthy-generation',
    appliedGeneration: 'healthy-generation',
  });
  await assert.rejects(
    packedAuthorHarness.installVerticalAHealthyControlFixture({
      plugin: {
        pluginId: 'acme.private-registry',
        root: '/tmp/private-registry-plugin',
      },
      sdkRegistryOrigin: 'https://registry.example.test',
      installPlugin: async () => ({
        change: {
          kind: 'committed',
          pluginId: 'acme.private-registry',
          desiredGeneration: 'healthy-generation',
          appliedGeneration: null,
        },
      }),
    }),
    /Healthy control plugin did not commit its exact generation/u,
  );
});

test('vertical-a accepts exact marketplace identity from the canonical installation revision and runtime catalog', () => {
  const artifactIntegrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  const admittedPackageDigest = `sha256:${'a'.repeat(64)}`;
  const manifestDigest = `sha256:${'b'.repeat(64)}`;
  const distribution = {
    kind: 'npm',
    registryOrigin: 'https://registry.example.test',
    packageName: 'acme-public-registry-plugin',
  };

  const input = {
    generation: {
      pluginId: 'acme.public-registry',
      packageDigest: admittedPackageDigest,
      manifestDigest,
      installedArtifactRecord: { digest: manifestDigest },
    },
    installation: {
      enabled: true,
      trust: { pluginId: 'acme.public-registry', distribution, state: 'trusted', approvedAtMs: 1 },
      source: { distribution, admittedIntegrity: admittedPackageDigest },
      updatePolicy: 'automatic',
      optionalAccess: [],
    },
    runtimeCatalog: {
      state: { enabled: true },
      source: { resolvedVersion: '1.0.0', resolvedDigest: manifestDigest },
      install: {
        manifestDigest,
        updatePolicy: 'automatic',
        trust: { distribution },
      },
    },
    expected: {
      pluginId: 'acme.public-registry',
      version: '1.0.0',
      marketplaceIntegrity: artifactIntegrity,
      manifestDigest,
      distribution,
      updatePolicy: 'automatic',
    },
  };

  assert.doesNotThrow(() => assertExactMarketplaceInstallationState(input));
  assert.throws(
    () => assertExactMarketplaceInstallationState({
      ...input,
      runtimeCatalog: {
        ...input.runtimeCatalog,
        source: {
          ...input.runtimeCatalog.source,
          resolvedDigest: `sha256:${'c'.repeat(64)}`,
        },
      },
    }),
    /did not persist exact artifact and durable distribution identity/u,
  );
  assert.throws(
    () => assertExactMarketplaceInstallationState({
      ...input,
      generation: {
        ...input.generation,
        packageDigest: `sha256:${'d'.repeat(64)}`,
      },
    }),
    /did not persist exact artifact and durable distribution identity/u,
  );
});

test('vertical-a cannot report success without every composed lifecycle stage', () => {
  const lifecycleStageIds = [
    'public-registry-profile-lifecycle',
    'marketplace-exact-daemon-lifecycle',
    'packed-connected-account-producer',
    'packed-builtin-multimode-connected-account',
    'packed-scm-runtime-auth-projection',
    'packed-external-sessions-lifecycle',
    'packed-notification-delivery-lifecycle',
    'takeover-stale-incarnation-fenced',
    'response-loss-currentness-query',
    'trusted-development-response-loss-currentness',
    'restart-applied-generation',
    'packed-connected-account-restart-durability',
    'packed-connected-account-established-operations',
    'descriptor-only-static-lifecycle',
    'ordinary-disable-enable',
    'failed-update-preservation',
    'successful-update-replacement',
    'packed-connected-account-generation-lifecycle',
    'explicit-rollback',
    'uninstall-action-currentness-absence',
    'continuous-health-role-transition',
    'automatic-lkg-recovery',
    'quarantined-explicit-rollback',
    'no-eligible-lkg-disable',
    'cleanup-failure-later-mutation',
    'packed-scm-uninstall-stale-absence',
  ];
  for (const stageId of lifecycleStageIds) {
    assert.ok(
      VERTICAL_A_REQUIRED_STAGE_IDS.includes(stageId),
      `required lifecycle stage is missing: ${stageId}`,
    );
  }
  assert.doesNotThrow(() => assertVerticalAStageCoverage(
    VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({ id, ok: true })),
  ));
  assert.throws(
    () => assertVerticalAStageCoverage([
      ...VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({ id, ok: true })),
      { id: VERTICAL_A_REQUIRED_STAGE_IDS[0], ok: true },
    ]),
    /duplicate stage ids: artifact-integrity/u,
  );
  assert.throws(
    () => assertVerticalAStageCoverage([
      ...VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({ id, ok: true })),
      { id: 'unexpected-stage', ok: true },
    ]),
    /unexpected stage ids: unexpected-stage/u,
  );
  assert.throws(
    () => assertVerticalAStageCoverage(VERTICAL_A_REQUIRED_STAGE_IDS.slice(0, -1).map((id) => ({ id, ok: true }))),
    /missing required stages: cleanup/u,
  );
  assert.throws(
    () => assertVerticalAStageCoverage(VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({ id, ok: id !== 'prepared-activation-registration' }))),
    /prepared-activation-registration/u,
  );
  for (const stageId of lifecycleStageIds) {
    assert.throws(
      () => assertVerticalAStageCoverage(
        VERTICAL_A_REQUIRED_STAGE_IDS
          .filter((id) => id !== stageId)
          .map((id) => ({ id, ok: true })),
      ),
      new RegExp(stageId, 'u'),
    );
  }

  const result = buildVerticalAResult({
    candidate: {
      runId: 'run-17',
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.1.0-vertical-a.run-17',
        integrity: 'sha512-YWJj',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10-vertical-a.run-17',
        integrity: 'sha512-ZGVm',
      },
    },
    stages: VERTICAL_A_REQUIRED_STAGE_IDS
      .filter((id) => id !== 'cleanup')
      .map((id) => ({ id, ok: true })),
    loadedIdentities: {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.error?.missingStageIds, ['cleanup']);
  const completeStages = VERTICAL_A_REQUIRED_STAGE_IDS
    .map((id) => ({ id, ok: true }));
  const duplicateStageResult = buildVerticalAResult({
    candidate: result.candidate,
    stages: [
      ...completeStages,
      { id: VERTICAL_A_REQUIRED_STAGE_IDS[0], ok: true },
    ],
    loadedIdentities: {},
  });
  assert.equal(duplicateStageResult.ok, false);
  assert.deepEqual(
    duplicateStageResult.error?.duplicateStageIds,
    ['artifact-integrity'],
  );
  const unexpectedStageResult = buildVerticalAResult({
    candidate: result.candidate,
    stages: [
      ...completeStages,
      { id: 'unexpected-stage', ok: true },
    ],
    loadedIdentities: {},
  });
  assert.equal(unexpectedStageResult.ok, false);
  assert.deepEqual(
    unexpectedStageResult.error?.unexpectedStageIds,
    ['unexpected-stage'],
  );
});

test('vertical-a reports A-11 owner/fault, packed black-box, and authenticated daemon evidence independently', () => {
  assert.deepEqual(
    Object.keys(VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS),
    ['ownerFault', 'packedExternalBlackBox', 'authenticatedDaemon'],
  );
  const mappedStageIds = new Set(
    Object.values(VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS).flat(),
  );
  assert.equal(
    Object.values(VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS).flat().length,
    VERTICAL_A_REQUIRED_STAGE_IDS.length,
  );
  assert.deepEqual(
    [...mappedStageIds].sort(),
    [...VERTICAL_A_REQUIRED_STAGE_IDS].sort(),
  );
  for (const [layerId, requiredStageIds] of Object.entries(
    VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS,
  )) {
    const layerResult = buildVerticalAEvidenceLayerResult(
      layerId,
      requiredStageIds.map((id) => ({ id, ok: true })),
    );
    assert.equal(layerResult.ok, true, `${layerId} should report independently`);
    assert.deepEqual(
      layerResult.stages.map(({ id }) => id),
      requiredStageIds,
    );
  }

  const completeStages = VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({
    id,
    ok: true,
  }));
  const failedOwnerStageId =
    VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS.ownerFault[0];
  const ownerFailure = buildVerticalAResult({
    candidate: {
      runId: 'run-layer-owner-failure',
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.1.0-run-layer-owner-failure',
        integrity: 'sha512-YWJj',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10-run-layer-owner-failure',
        integrity: 'sha512-ZGVm',
      },
    },
    stages: completeStages.map((stage) => ({
      ...stage,
      ok: stage.id !== failedOwnerStageId,
    })),
    loadedIdentities: {},
  });
  assert.equal(ownerFailure.ok, false);
  assert.equal(ownerFailure.evidenceLayers.ownerFault.ok, false);
  assert.deepEqual(
    ownerFailure.evidenceLayers.ownerFault.error?.failedStageIds,
    [failedOwnerStageId],
  );
  assert.equal(
    ownerFailure.evidenceLayers.packedExternalBlackBox.ok,
    true,
  );
  assert.equal(ownerFailure.evidenceLayers.authenticatedDaemon.ok, true);

  const missingPackedStageId =
    VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS.packedExternalBlackBox[0];
  const packedFailure = buildVerticalAResult({
    candidate: ownerFailure.candidate,
    stages: completeStages.filter(({ id }) => id !== missingPackedStageId),
    loadedIdentities: {},
  });
  assert.equal(packedFailure.ok, false);
  assert.equal(packedFailure.evidenceLayers.ownerFault.ok, true);
  assert.equal(
    packedFailure.evidenceLayers.packedExternalBlackBox.ok,
    false,
  );
  assert.deepEqual(
    packedFailure.evidenceLayers.packedExternalBlackBox.error?.missingStageIds,
    [missingPackedStageId],
  );
  assert.equal(packedFailure.evidenceLayers.authenticatedDaemon.ok, true);

  const executionFailure = buildVerticalAResult({
    candidate: ownerFailure.candidate,
    stages: VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS.packedExternalBlackBox.map(
      (id) => ({ id, ok: true }),
    ),
    loadedIdentities: {},
    executionFailure: {
      code: 'packed_author_stage_failed',
      message: 'authenticated daemon stage failed',
    },
  });
  assert.equal(executionFailure.ok, false);
  assert.equal(
    executionFailure.evidenceLayers.packedExternalBlackBox.ok,
    true,
  );
  assert.equal(executionFailure.evidenceLayers.ownerFault.ok, false);
  assert.equal(executionFailure.evidenceLayers.authenticatedDaemon.ok, false);
  assert.deepEqual(executionFailure.error?.executionFailure, {
    code: 'packed_author_stage_failed',
    message: 'authenticated daemon stage failed',
  });
});

test('vertical-a reloads an already-running daemon after its extra CA bundle changes', async () => {
  const harness = await import('./run-packed-author-ui-compat.mjs');
  const env = {
    HAPPIER_HOME_DIR: '/isolated-home',
    NODE_EXTRA_CA_CERTS: '/isolated-home/packed-author-extra-ca.pem',
  };
  let invocation = null;

  await harness.restartPackedDaemonForUpdatedTrustStore({
    cliEntrypoint: '/packed-cli/happier.mjs',
    cwd: '/fixture',
    env,
    runCli: async (received) => {
      invocation = received;
      return {
        code: 0,
        signal: null,
        stdout: '{"v":1,"ok":true,"kind":"daemon_restart"}\n',
        stderr: '',
      };
    },
  });

  assert.deepEqual(invocation, {
    cliEntrypoint: '/packed-cli/happier.mjs',
    cwd: '/fixture',
    env,
    args: buildVerticalADaemonRestartArgs(),
  });
});

test('vertical-a requires daemon-started native Agents without a carrier to fail before leaf activation', () => {
  assert.deepEqual(assertDaemonAgentCarrierFailClosed({
    code: 1,
    signal: null,
    stdout: '',
    stderr: "Daemon-spawned native Agent backend 'auggie' is missing its runtime carrier\n",
  }), {
    backendId: 'auggie',
    errorCode: 'DAEMON_AGENT_RUNTIME_CARRIER_MISSING',
    processExitCode: 1,
  });

  assert.throws(() => assertDaemonAgentCarrierFailClosed({
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'auggie executable was not found\n',
  }), /did not fail closed at the daemon carrier owner/iu);
});

test('vertical-a keeps a healthy peer on one activation across a post-restart sibling update', () => {
  assert.deepEqual(assertPostRestartHealthyPeerIsolation({
    pluginId: 'acme.healthy-peer',
    before: {
      pluginId: 'acme.healthy-peer',
      version: '11.0.0',
      pid: 77,
      activationInstanceId: 'healthy-peer-after-restart',
    },
    after: {
      pluginId: 'acme.healthy-peer',
      version: '11.0.0',
      pid: 77,
      activationInstanceId: 'healthy-peer-after-restart',
    },
    registrationCountBefore: 2,
    registrationCountAfter: 2,
  }), {
    pluginId: 'acme.healthy-peer',
    version: '11.0.0',
    daemonPid: 77,
    activationInstanceId: 'healthy-peer-after-restart',
    registrationCount: 2,
  });

  assert.throws(() => assertPostRestartHealthyPeerIsolation({
    pluginId: 'acme.healthy-peer',
    before: {
      pluginId: 'acme.healthy-peer',
      version: '11.0.0',
      pid: 77,
      activationInstanceId: 'healthy-peer-after-restart',
    },
    after: {
      pluginId: 'acme.healthy-peer',
      version: '11.0.0',
      pid: 77,
      activationInstanceId: 'healthy-peer-reactivated',
    },
    registrationCountBefore: 2,
    registrationCountAfter: 3,
  }), /reactivated or retired/u);
});

test('vertical-a requires no-LKG recovery to quarantine and disable only the current plugin while retaining explicit rollback', () => {
  const pluginId = 'acme.vertical-a';
  const failedGenerationId = 'generation-v3';
  const explicitRollbackGenerationId = 'generation-v4';
  const evidence = assertNoEligibleLkgDisabled({
    state: {
      commit: {
        pluginGenerations: {
          [pluginId]: { immutableGenerationId: failedGenerationId },
        },
      },
      revision: {
        plugins: { [pluginId]: { enabled: false } },
        runtimeCatalog: { plugins: { [pluginId]: { state: { enabled: false } } } },
        health: {
          [failedGenerationId]: {
            state: 'quarantined',
            fingerprint: 'fingerprint-v3',
            consumedAttemptIds: ['fatal-a', 'fatal-b', 'fatal-c'],
          },
          [explicitRollbackGenerationId]: {
            state: 'quarantined',
            tryOnce: 'available',
          },
        },
        healthTombstones: [{
          pluginId,
          fingerprint: 'fingerprint-v3',
          state: 'quarantined',
        }],
        rollbackRetention: [{
          pluginId,
          immutableGenerationId: explicitRollbackGenerationId,
          role: 'quarantined',
          automaticRecoveryEligible: false,
          byteAvailability: 'available',
        }],
      },
    },
    pluginId,
    failedGenerationId,
    explicitRollbackGenerationId,
    healthyPluginInvocation: {
      pluginId: 'acme.private-registry',
      version: '11.0.0',
      pid: 77,
      activationInstanceId: 'healthy-control',
    },
  });
  assert.deepEqual(evidence, {
    failedFingerprint: 'fingerprint-v3',
    distinctFatalAttempts: 3,
    explicitRollbackRole: 'quarantined',
    healthyPluginId: 'acme.private-registry',
    healthyPluginVersion: '11.0.0',
  });

  assert.throws(() => assertNoEligibleLkgDisabled({
    state: {
      commit: { pluginGenerations: { [pluginId]: { immutableGenerationId: failedGenerationId } } },
      revision: {
        plugins: { [pluginId]: { enabled: false } },
        runtimeCatalog: { plugins: { [pluginId]: { state: { enabled: false } } } },
        health: {
          [failedGenerationId]: {
            state: 'quarantined',
            fingerprint: 'fingerprint-v3',
            consumedAttemptIds: ['fatal-a', 'fatal-b', 'fatal-c'],
          },
          [explicitRollbackGenerationId]: { state: 'quarantined', tryOnce: 'available' },
        },
        healthTombstones: [{ pluginId, fingerprint: 'fingerprint-v3', state: 'quarantined' }],
        rollbackRetention: [{
          pluginId,
          immutableGenerationId: explicitRollbackGenerationId,
          role: 'lastKnownGood',
          automaticRecoveryEligible: true,
          byteAvailability: 'available',
        }],
      },
    },
    pluginId,
    failedGenerationId,
    explicitRollbackGenerationId,
    healthyPluginInvocation: null,
  }), /left automatic recovery eligible/u);
  assert.throws(() => assertNoEligibleLkgDisabled({
    state: {
      commit: { pluginGenerations: { [pluginId]: { immutableGenerationId: failedGenerationId } } },
      revision: {
        plugins: { [pluginId]: { enabled: false } },
        runtimeCatalog: { plugins: { [pluginId]: { state: { enabled: false } } } },
        health: {
          [failedGenerationId]: {
            state: 'quarantined',
            fingerprint: 'fingerprint-v3',
            consumedAttemptIds: ['fatal-a', 'fatal-b', 'fatal-c'],
          },
          [explicitRollbackGenerationId]: { state: 'quarantined', tryOnce: 'available' },
        },
        healthTombstones: [{ pluginId, fingerprint: 'fingerprint-v3', state: 'quarantined' }],
        rollbackRetention: [{
          pluginId,
          immutableGenerationId: explicitRollbackGenerationId,
          role: 'quarantined',
          automaticRecoveryEligible: false,
          byteAvailability: 'available',
        }],
      },
    },
    pluginId,
    failedGenerationId,
    explicitRollbackGenerationId,
    healthyPluginInvocation: null,
  }), /healthy control plugin.*callable/iu);
});

test('vertical-a requires Try once to remain consumed when the exact quarantined bytes are reinstalled after restart', () => {
  const pluginId = 'acme.vertical-a';
  const originalGenerationId = 'generation-v3';
  const reinstalledGenerationId = 'generation-v3-reinstalled';
  const evidence = assertTryOnceReinstallQuarantine({
    state: {
      commit: {
        pluginGenerations: {
          [pluginId]: { immutableGenerationId: reinstalledGenerationId },
        },
      },
      revision: {
        plugins: { [pluginId]: { enabled: false } },
        runtimeCatalog: { plugins: { [pluginId]: { state: { enabled: false } } } },
        health: {
          [originalGenerationId]: {
            state: 'quarantined',
            tryOnce: 'consumed',
            fingerprint: 'fingerprint-v3',
          },
          [reinstalledGenerationId]: {
            state: 'quarantined',
            tryOnce: 'consumed',
            fingerprint: 'fingerprint-v3',
          },
        },
        healthTombstones: [{
          pluginId,
          fingerprint: 'fingerprint-v3',
          state: 'consumed',
        }],
      },
    },
    pluginId,
    originalGenerationId,
    reinstalledGenerationId,
    fingerprint: 'fingerprint-v3',
    rejectedSecondEnable: {
      ok: false,
      kind: 'plugins_enable',
      error: {
        code: 'failed',
        causeMessage: 'Generation Try once is unavailable or already consumed',
      },
    },
    registrationCountBeforeRestart: 4,
    registrationCountAfterReinstall: 4,
  });
  assert.deepEqual(evidence, {
    originalGeneration: originalGenerationId,
    reinstalledGeneration: reinstalledGenerationId,
    fingerprint: 'fingerprint-v3',
    tryOnce: 'consumed',
    registrationCount: 4,
  });

  assert.throws(() => assertTryOnceReinstallQuarantine({
    state: {
      commit: {
        pluginGenerations: {
          [pluginId]: { immutableGenerationId: reinstalledGenerationId },
        },
      },
      revision: {
        plugins: { [pluginId]: { enabled: false } },
        runtimeCatalog: { plugins: { [pluginId]: { state: { enabled: false } } } },
        health: {
          [originalGenerationId]: {
            state: 'quarantined',
            tryOnce: 'consumed',
            fingerprint: 'fingerprint-v3',
          },
          [reinstalledGenerationId]: {
            state: 'quarantined',
            tryOnce: 'available',
            fingerprint: 'fingerprint-v3',
          },
        },
        healthTombstones: [{
          pluginId,
          fingerprint: 'fingerprint-v3',
          state: 'quarantined',
        }],
      },
    },
    pluginId,
    originalGenerationId,
    reinstalledGenerationId,
    fingerprint: 'fingerprint-v3',
    rejectedSecondEnable: {
      ok: false,
      kind: 'plugins_enable',
      error: {
        code: 'failed',
        causeMessage: 'Generation Try once is unavailable or already consumed',
      },
    },
    registrationCountBeforeRestart: 4,
    registrationCountAfterReinstall: 4,
  }), /rearmed quarantined bytes/u);
});

test('vertical-a does not attribute a rejected pre-commit candidate failure to current health', () => {
  const pluginId = 'acme.vertical-a';
  const currentGenerationId = 'generation-v1';
  const currentHealth = {
    state: 'pending',
    tryOnce: 'unavailable',
    fingerprint: 'fingerprint-v1',
    consumedAttemptIds: ['serving-bootstrap'],
  };
  assert.deepEqual(assertRejectedCandidateNotAttributedToCurrentHealth({
    before: {
      commit: { pluginGenerations: { [pluginId]: { immutableGenerationId: currentGenerationId } } },
      revision: { health: { [currentGenerationId]: currentHealth } },
    },
    after: {
      commit: { pluginGenerations: { [pluginId]: { immutableGenerationId: currentGenerationId } } },
      revision: { health: { [currentGenerationId]: { ...currentHealth } } },
    },
    pluginId,
    currentGenerationId,
  }), {
    currentGeneration: currentGenerationId,
    consumedAttemptIds: ['serving-bootstrap'],
  });

  assert.throws(() => assertRejectedCandidateNotAttributedToCurrentHealth({
    before: {
      commit: { pluginGenerations: { [pluginId]: { immutableGenerationId: currentGenerationId } } },
      revision: { health: { [currentGenerationId]: currentHealth } },
    },
    after: {
      commit: { pluginGenerations: { [pluginId]: { immutableGenerationId: currentGenerationId } } },
      revision: {
        health: {
          [currentGenerationId]: {
            ...currentHealth,
            consumedAttemptIds: ['serving-bootstrap', 'rejected-candidate-failure'],
          },
        },
      },
    },
    pluginId,
    currentGenerationId,
  }), /attributed a rejected candidate failure/u);
});

test('vertical-a records measured continuous-health evidence from one activation instance', () => {
  assert.deepEqual(assertContinuousHealthEvidence({
    startedAtMs: 1_000,
    completedAtMs: 601_000,
    requiredWindowMs: 600_000,
    initialRegistration: { pid: 41, activationInstanceId: 'activation-v3' },
    healthyInvocation: { pid: 41, activationInstanceId: 'activation-v3' },
    candidateHealth: { state: 'healthy' },
    priorRetention: {
      role: 'userRollback',
      automaticRecoveryEligible: false,
      byteAvailability: 'available',
    },
    initialDistribution: {
      kind: 'localPath',
      canonicalPath: '/tmp/acme.vertical-a',
    },
    candidateDistribution: {
      kind: 'localPath',
      canonicalPath: '/tmp/acme.vertical-a',
    },
  }), {
    measuredWallDurationMs: 600_000,
    daemonPid: 41,
    activationInstanceId: 'activation-v3',
    candidateHealthState: 'healthy',
    priorRole: 'userRollback',
    priorAutomaticRecoveryEligible: false,
    distributionKind: 'localPath',
    distributionIdentity: '/tmp/acme.vertical-a',
  });

  assert.throws(() => assertContinuousHealthEvidence({
    startedAtMs: 1_000,
    completedAtMs: 600_999,
    requiredWindowMs: 600_000,
    initialRegistration: { pid: 41, activationInstanceId: 'activation-v3' },
    healthyInvocation: { pid: 41, activationInstanceId: 'activation-v3' },
  }), /shorter than the required window/u);
  assert.throws(() => assertContinuousHealthEvidence({
    startedAtMs: 1_000,
    completedAtMs: 601_000,
    requiredWindowMs: 600_000,
    initialRegistration: { pid: 41, activationInstanceId: 'activation-v3' },
    healthyInvocation: { pid: 42, activationInstanceId: 'activation-v3-restarted' },
    candidateHealth: { state: 'healthy' },
    priorRetention: {
      role: 'userRollback',
      automaticRecoveryEligible: false,
      byteAvailability: 'available',
    },
  }), /daemon activation changed/u);
  assert.throws(() => assertContinuousHealthEvidence({
    startedAtMs: 1_000,
    completedAtMs: 601_000,
    requiredWindowMs: 600_000,
    initialRegistration: { pid: 41, activationInstanceId: 'activation-v3' },
    healthyInvocation: { pid: 41, activationInstanceId: 'activation-v3' },
    candidateHealth: { state: 'healthy' },
    priorRetention: {
      role: 'lastKnownGood',
      automaticRecoveryEligible: true,
      byteAvailability: 'available',
    },
  }), /prior generation.*explicit rollback only/iu);
  assert.throws(() => assertContinuousHealthEvidence({
    startedAtMs: 1_000,
    completedAtMs: 601_000,
    requiredWindowMs: 600_000,
    initialRegistration: { pid: 41, activationInstanceId: 'activation-v3' },
    healthyInvocation: { pid: 41, activationInstanceId: 'activation-v3' },
    candidateHealth: { state: 'healthy' },
    priorRetention: {
      role: 'userRollback',
      automaticRecoveryEligible: false,
      byteAvailability: 'available',
    },
    initialDistribution: {
      kind: 'localPath',
      canonicalPath: '/tmp/acme.vertical-a',
    },
    candidateDistribution: {
      kind: 'localPath',
      canonicalPath: '/tmp/acme.other',
    },
  }), /same local-path distribution/iu);
});

test('vertical-a consumes quarantined Try once only through explicit rollback and serves those exact bytes', () => {
  assert.deepEqual(assertQuarantinedExplicitRollback({
    pluginId: 'acme.vertical-a',
    healthyGenerationId: 'generation-v4-reinstalled',
    quarantinedGenerationId: 'generation-v5',
    before: {
      commit: {
        pluginGenerations: {
          'acme.vertical-a': { immutableGenerationId: 'generation-v4-reinstalled' },
        },
      },
      revision: {
        plugins: { 'acme.vertical-a': { enabled: false } },
        health: {
          'generation-v5': {
            state: 'quarantined',
            tryOnce: 'available',
            fingerprint: 'fingerprint-v5',
          },
        },
        healthTombstones: [{
          pluginId: 'acme.vertical-a',
          fingerprint: 'fingerprint-v5',
          state: 'quarantined',
        }],
      },
    },
    rollbackEnvelope: {
      data: {
        pluginId: 'acme.vertical-a',
        desiredGeneration: 'generation-v5',
        appliedGeneration: 'generation-v5',
        pendingSurfaces: [],
      },
    },
    after: {
      commit: {
        pluginGenerations: {
          'acme.vertical-a': { immutableGenerationId: 'generation-v5' },
        },
      },
      revision: {
        plugins: { 'acme.vertical-a': { enabled: true } },
        runtimeCatalog: { plugins: { 'acme.vertical-a': { state: { enabled: true } } } },
        health: {
          'generation-v5': {
            state: 'trial',
            tryOnce: 'consumed',
            fingerprint: 'fingerprint-v5',
          },
        },
        healthTombstones: [{
          pluginId: 'acme.vertical-a',
          fingerprint: 'fingerprint-v5',
          state: 'consumed',
        }],
      },
    },
    invocation: {
      pluginId: 'acme.vertical-a',
      version: '5.0.0',
      pid: 77,
      activationInstanceId: 'activation-v5',
    },
  }), {
    fromGeneration: 'generation-v4-reinstalled',
    toGeneration: 'generation-v5',
    fingerprint: 'fingerprint-v5',
    tryOnce: 'consumed',
    servingVersion: '5.0.0',
    activationInstanceId: 'activation-v5',
  });
});

test('vertical-a proves a rejected activation cleanup cannot strand later same-plugin mutation', () => {
  assert.deepEqual(assertCleanupFailureDidNotBlockLaterMutation({
    pluginId: 'acme.vertical-a',
    retiredGenerationId: 'generation-v5',
    cleanupFailure: {
      kind: 'cleanup-failure',
      version: '5.0.0',
      activationInstanceId: 'activation-v5',
      pid: 77,
    },
    uninstallEnvelope: {
      data: {
        pluginId: 'acme.vertical-a',
        desiredGeneration: null,
        appliedGeneration: null,
        pendingSurfaces: [],
      },
    },
    laterMutationEnvelope: {
      change: {
        kind: 'committed',
        pluginId: 'acme.vertical-a',
        desiredGeneration: 'generation-v6',
        appliedGeneration: 'generation-v6',
        pendingSurfaces: [],
      },
    },
    laterInvocation: {
      pluginId: 'acme.vertical-a',
      version: '6.0.0',
      pid: 77,
      activationInstanceId: 'activation-v6',
    },
  }), {
    retiredGeneration: 'generation-v5',
    cleanupFailureVersion: '5.0.0',
    cleanupFailureActivationInstanceId: 'activation-v5',
    laterGeneration: 'generation-v6',
    laterServingVersion: '6.0.0',
  });
});

test('vertical-a requires each fatal restart to add exactly one unique supervised attempt id', () => {
  assert.deepEqual(assertUniqueSupervisedAttemptProgress({
    initialConsumedAttemptIds: [],
    attempts: [
      { attemptNumber: 1, consumedAttemptIds: ['attempt-a'] },
      { attemptNumber: 2, consumedAttemptIds: ['attempt-a', 'attempt-b'] },
      { attemptNumber: 3, consumedAttemptIds: ['attempt-a', 'attempt-b', 'attempt-c'] },
    ],
  }), ['attempt-a', 'attempt-b', 'attempt-c']);

  assert.throws(() => assertUniqueSupervisedAttemptProgress({
    initialConsumedAttemptIds: [],
    attempts: [
      { attemptNumber: 1, consumedAttemptIds: ['attempt-a'] },
      { attemptNumber: 2, consumedAttemptIds: ['attempt-a'] },
      { attemptNumber: 3, consumedAttemptIds: ['attempt-a', 'attempt-c'] },
    ],
  }), /exactly one new supervised attempt/u);
});

test('vertical-a waits for each supervised fatal attempt to reach durable health state', async () => {
  const observedAttemptIds = [
    [],
    [],
    ['attempt-a'],
  ];
  let readCount = 0;
  let clockMs = 0;
  const progress = await waitForSupervisedAttemptProgress({
    generationId: 'generation-v4',
    priorConsumedAttemptIds: [],
    timeoutMs: 1_000,
    pollIntervalMs: 25,
    readState: async () => ({
      revision: {
        health: {
          'generation-v4': {
            consumedAttemptIds: observedAttemptIds[Math.min(readCount++, observedAttemptIds.length - 1)],
          },
        },
      },
    }),
    nowMs: () => clockMs,
    sleep: async (delayMs) => { clockMs += delayMs; },
  });

  assert.equal(readCount, 3);
  assert.deepEqual(progress.consumedAttemptIds, ['attempt-a']);
  assert.doesNotThrow(() => assertUniqueSupervisedAttemptProgress({
    initialConsumedAttemptIds: [],
    attempts: [{ attemptNumber: 1, consumedAttemptIds: progress.consumedAttemptIds }],
  }));
});

test('vertical-a requires ordinary uninstall to preserve health history until explicit destructive clear', () => {
  assert.deepEqual(assertExplicitHealthHistoryClear({
    pluginId: 'acme.vertical-a',
    fingerprint: 'fingerprint-v3',
    afterDefaultUninstall: {
      revision: {
        healthTombstones: [{
          pluginId: 'acme.vertical-a',
          fingerprint: 'fingerprint-v3',
          state: 'quarantined',
        }],
      },
    },
    clearEnvelope: {
      data: {
        pluginId: 'acme.vertical-a',
        alreadyUninstalled: true,
      },
    },
    afterExplicitClear: {
      revision: {
        healthTombstones: [],
      },
    },
  }), {
    preservedFingerprint: 'fingerprint-v3',
    explicitClear: true,
  });
});

test('runner requires the canonical vertical-a scenario and direct natural artifacts', () => {
  assert.deepEqual(
    parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
    ]),
    {
      scenario: 'vertical-a',
      sdkTarballPath: '/tmp/sdk.tgz',
      cliTarballPath: '/tmp/cli.tgz',
    },
  );
  assert.deepEqual(
    parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
      '--packed-novel-qa-handoff-root',
      '/tmp/packed-novel-handoff',
    ]),
    {
      scenario: 'vertical-a',
      sdkTarballPath: '/tmp/sdk.tgz',
      cliTarballPath: '/tmp/cli.tgz',
      packedNovelQaHandoffRoot: '/tmp/packed-novel-handoff',
    },
  );
  assert.throws(
    () => parseRunnerArgs([
      '--scenario',
      'vertical-b',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
    ]),
    /vertical-a/u,
  );
  assert.throws(
    () => parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--candidate',
      '/tmp/candidate.json',
    ]),
    /--sdk-tarball/u,
  );
  assert.throws(
    () => parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
      '--candidate',
      '/tmp/candidate.json',
    ]),
    /does not accept --candidate/u,
  );
});

test('ordinary packed admission accepts direct natural artifacts without candidate custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-natural-packed-admission-'));
  try {
    const sdkSourceRoot = join(root, 'sdk-source');
    const cliSourceRoot = join(root, 'cli-source');
    const sdkTarballPath = join(root, 'sdk.tgz');
    const cliTarballPath = join(root, 'cli.tgz');
    await Promise.all([
      mkdir(join(sdkSourceRoot, 'package'), { recursive: true }),
      mkdir(join(cliSourceRoot, 'package', 'bin'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(sdkSourceRoot, 'package', 'package.json'),
        `${JSON.stringify({
          name: '@happier-dev/plugin-sdk',
          version: '0.0.0',
        })}\n`,
        'utf8',
      ),
      writeFile(
        join(cliSourceRoot, 'package', 'package.json'),
        `${JSON.stringify({
          name: '@happier-dev/cli',
          version: '0.2.10',
          bin: { happier: './bin/happier.mjs' },
        })}\n`,
        'utf8',
      ),
      writeFile(
        join(cliSourceRoot, 'package', 'bin', 'happier.mjs'),
        '#!/usr/bin/env node\n',
        'utf8',
      ),
    ]);
    await Promise.all([
      tar.c({ cwd: sdkSourceRoot, file: sdkTarballPath, gzip: true }, ['package']),
      tar.c({ cwd: cliSourceRoot, file: cliTarballPath, gzip: true }, ['package']),
    ]);

    const argv = [
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      sdkTarballPath,
      '--cli-tarball',
      cliTarballPath,
    ];
    const candidate = await loadPackedAuthorNaturalArtifacts(argv, {
      cwd: root,
      createRunId: () => 'natural-run-1',
    });
    assert.equal(candidate.runId, 'natural-run-1');
    assert.equal(candidate.sdk.packageName, '@happier-dev/plugin-sdk');
    assert.equal(candidate.sdk.version, '0.0.0');
    assert.equal(candidate.cli.packageName, '@happier-dev/cli');
    assert.equal(candidate.cli.version, '0.2.10');
    assert.equal(candidate.cli.entrypoint, 'package/bin/happier.mjs');
    assert.equal(candidate.sdk.tarballPath, sdkTarballPath);
    assert.equal(candidate.cli.tarballPath, cliTarballPath);
    assert.equal(
      candidate.sdk.integrity,
      sha512Sri(await readFile(sdkTarballPath)),
    );
    assert.equal(
      candidate.cli.integrity,
      sha512Sri(await readFile(cliTarballPath)),
    );
    assert.equal(candidate.sourceBasis, undefined);
    assert.equal(candidate.installers, undefined);
    await assert.rejects(
      readFile(join(root, 'candidate.json'), 'utf8'),
      /ENOENT/u,
    );

    const directRunner = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL(
          './run-packed-author-ui-compat.mjs',
          import.meta.url,
        )),
        ...argv,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(directRunner.error, undefined);
    assert.equal(directRunner.status, 1);
    const directRunnerEnvelope = JSON.parse(directRunner.stdout.trim());
    assert.equal(directRunnerEnvelope.candidate.sdk.tarballPath, sdkTarballPath);
    assert.equal(directRunnerEnvelope.candidate.cli.tarballPath, cliTarballPath);
    assert.match(
      directRunnerEnvelope.error.message,
      /requires authenticated isolated-home preparation/u,
    );

    await assert.rejects(
      loadPackedAuthorNaturalArtifacts([
        '--scenario',
        'vertical-a',
        '--sdk-tarball',
        cliTarballPath,
        '--cli-tarball',
        sdkTarballPath,
      ], {
        cwd: root,
        createRunId: () => 'natural-run-swapped',
      }),
      /SDK identity mismatch/u,
    );

    const candidateCreator = await import('./create-packed-author-candidate.mjs');
    await assert.rejects(
      loadPackedAuthorNaturalArtifacts(argv, {
        cwd: root,
        createRunId: () => 'natural-run-tampered',
        createPackedAuthorCandidateImpl: async (params) => {
          const admitted = await candidateCreator.createPackedAuthorCandidate(
            params,
          );
          const bytes = Buffer.from(await readFile(cliTarballPath));
          bytes[0] ^= 0xff;
          await writeFile(cliTarballPath, bytes);
          return admitted;
        },
      }),
      /CLI tarball changed during admission/u,
    );

    const runnerSource = await readFile(
      new URL('./run-packed-author-ui-compat.mjs', import.meta.url),
      'utf8',
    );
    const composedRunnerSource = await readFile(
      new URL('../../src/plugin-platform/runPackedAuthorVerticalA.ts', import.meta.url),
      'utf8',
    );
    const testsPackageManifest = JSON.parse(await readFile(
      new URL('../../package.json', import.meta.url),
      'utf8',
    ));
    assert.equal(
      testsPackageManifest.scripts['test:plugin-platform:packed-author'],
      'node scripts/runTsxEntrypoint.mjs src/plugin-platform/runPackedAuthorVerticalA.ts --scenario vertical-a',
    );
    assert.doesNotMatch(
      `${runnerSource}\n${composedRunnerSource}`,
      /build-packed-author-candidate|withCliDistBuildLock/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate manifest accepts exact packed package semvers without manufacturing candidate versions', () => {
  const parsed = parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    sourceBasis: {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
    },
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json');
  assert.equal(parsed.sdk.version, '0.0.0');
  assert.equal(parsed.cli.version, '0.2.10');
  assert.equal(parsed.sdk.tarballPath, '/tmp/sdk.tgz');
  assert.deepEqual(parsed.sourceBasis, {
    algorithm: 'sha256',
    digest: 'a'.repeat(64),
  });
  assert.deepEqual(parsed.installers, candidateInstallerRecords());
  assert.throws(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-18',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json'), /CLI packageName/u);
  assert.throws(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@scope/lookalike-cli',
      version: '0.2.10-vertical-a.run-17',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json'), /CLI packageName/u);
  assert.throws(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10-vertical-a.run-17',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package\\..\\outside.mjs',
    },
  }), '/tmp/candidate.json'), /entrypoint/u);
  assert.doesNotThrow(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    sourceBasis: {
      algorithm: 'sha256',
      digest: 'b'.repeat(64),
    },
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.extra.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10-vertical-a.run-17',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json'));
  assert.doesNotThrow(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    sourceBasis: {
      algorithm: 'sha256',
      digest: 'c'.repeat(64),
    },
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10-vertical-a.run-16',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json'));
  assert.throws(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: 'release-vertical-a.run-17',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json'), /valid package semver/u);
});

test('candidate manifest admission rejects missing or malformed source-basis identity', () => {
  const candidate = {
    schemaVersion: 1,
    runId: 'run-source-basis',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  };
  assert.throws(
    () => parseCandidateManifest(JSON.stringify(candidate), '/tmp/candidate.json'),
    /sourceBasis/u,
  );
  assert.throws(
    () => parseCandidateManifest(JSON.stringify({
      ...candidate,
      sourceBasis: {
        algorithm: 'sha256',
        digest: '../not-a-digest',
      },
    }), '/tmp/candidate.json'),
    /sourceBasis/u,
  );
});

test('candidate manifest requires exact non-swappable installer custody records', () => {
  const candidate = {
    schemaVersion: 1,
    runId: 'run-installer-custody',
    sourceBasis: {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
    },
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  };
  assert.throws(
    () => parseCandidateManifest(
      JSON.stringify({ ...candidate, installers: undefined }),
      '/tmp/candidate.json',
    ),
    /installers/u,
  );
  assert.throws(
    () => parseCandidateManifest(JSON.stringify({
      ...candidate,
      installers: {
        ...candidate.installers,
        shell: candidate.installers.powershell,
        powershell: candidate.installers.shell,
      },
    }), '/tmp/candidate.json'),
    /exact bound install-dev\.sh/u,
  );
  assert.throws(
    () => parseCandidateManifest(JSON.stringify({
      ...candidate,
      installers: {
        ...candidate.installers,
        shell: {
          ...candidate.installers.shell,
          filePath: '/tmp/../outside/install-dev.sh',
        },
      },
    }), '/tmp/candidate.json'),
    /manifest run root/u,
  );
});

test('candidate installer custody verification rejects exact-size byte tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-installer-custody-'));
  try {
    const definitions = [
      ['shell', 'shell', 'install-dev.sh', 'shell-original'],
      ['powershell', 'powershell', 'install-dev.ps1', 'powershell-original'],
      ['publicKey', 'minisign-public-key', 'happier-release.pub', 'public-key-original'],
    ];
    const installers = {
      releaseChannel: 'dev',
    };
    for (const [field, kind, fileName, contents] of definitions) {
      const bytes = Buffer.from(contents);
      const filePath = join(root, fileName);
      await writeFile(filePath, bytes);
      installers[field] = {
        kind,
        fileName,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        filePath,
      };
    }
    const candidate = parseCandidateManifest(JSON.stringify({
      schemaVersion: 1,
      runId: 'run-installer-tamper',
      sourceBasis: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
      },
      installers,
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        integrity: 'sha512-YWJj',
        tarballPath: './sdk.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-ZGVm',
        tarballPath: './cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
    }), join(root, 'candidate.json'));

    await assert.doesNotReject(assertPackedAuthorCandidateInstallerArtifacts(
      candidate,
      { manifestPath: join(root, 'candidate.json') },
    ));
    await writeFile(
      candidate.installers.powershell.filePath,
      'powershell-tampered',
    );
    await assert.rejects(
      assertPackedAuthorCandidateInstallerArtifacts(
        candidate,
        { manifestPath: join(root, 'candidate.json') },
      ),
      /integrity mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold inspection rejects repository links, bare tools, and TypeScript 5', () => {
  assert.deepEqual(inspectGeneratedScaffoldPackage({
    scripts: {
      build: 'happier plugins author build .',
      typecheck: 'happier plugins author typecheck .',
      test: 'happier plugins test .',
      'pack:plugin': 'happier plugins pack .',
    },
    dependencies: { '@happier-dev/plugin-sdk': '0.1.0-vertical-a.run-17' },
    devDependencies: { '@typescript/native': 'npm:typescript@7.0.2' },
  }, '0.1.0-vertical-a.run-17'), []);
  const failures = inspectGeneratedScaffoldPackage({
    scripts: { build: 'tsc -p tsconfig.json', test: 'true' },
    dependencies: {
      '@happier-dev/plugin-sdk': 'file:/repo/packages/plugin-sdk',
      '@happier-dev/protocol': 'workspace:*',
    },
    devDependencies: { typescript: '^5.9.3' },
  }, '0.1.0-vertical-a.run-17');
  assert.ok(failures.some((message) => message.includes('ordinary semver')));
  assert.ok(failures.some((message) => message.includes('forbidden bare tool')));
  assert.ok(failures.some((message) => message.includes('exact repository-selected')));
  assert.ok(failures.some((message) => message.includes('TypeScript 5')));
  assert.ok(failures.some((message) => message.includes('author script typecheck')));
  assert.ok(failures.some((message) => message.includes('@happier-dev/protocol')));
  const compilerDriftFailures = inspectGeneratedScaffoldPackage({
    scripts: {
      build: 'happier plugins author build .',
      typecheck: 'happier plugins author typecheck .',
      test: 'happier plugins test .',
      'pack:plugin': 'happier plugins pack .',
    },
    dependencies: { '@happier-dev/plugin-sdk': '0.1.0-vertical-a.run-17' },
    devDependencies: { '@typescript/native': 'npm:typescript@7.x' },
  }, '0.1.0-vertical-a.run-17');
  assert.ok(compilerDriftFailures.some((message) => message.includes('exact repository-selected')));
});

test('vertical-a fixture configuration keeps its author test aligned with the roundtrip registration', async () => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-vertical-a-configure-'));
  try {
    await Promise.all([
      mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true }),
      mkdir(join(pluginRoot, 'src'), { recursive: true }),
      mkdir(join(pluginRoot, 'src', 'ui'), { recursive: true }),
      mkdir(join(pluginRoot, 'test'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        id: 'acme.vertical-a',
        version: '0.0.0',
        entrypoints: { development: './src/index.ts' },
        contributes: {
          actions: [],
          ui: {
            views: [{ id: 'main', placement: 'app.sidePanel', renderer: 'main-web' }],
            renderers: [{
              id: 'main-web',
              kind: 'hostedWeb',
              source: { kind: 'artifact', artifact: 'main-web' },
              requiredHostMethods: ['context'],
            }],
            translations: [],
          },
        },
      }), 'utf8'),
      writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'vertical-a-plugin',
        version: '0.0.0',
      }), 'utf8'),
      writeFile(join(pluginRoot, 'src', 'index.ts'), 'export {};\n', 'utf8'),
      writeFile(join(pluginRoot, 'test', 'index.test.mjs'), "invokeAction('save-note');\n", 'utf8'),
    ]);

    await configureVerticalAPlugin({
      pluginRoot,
      pluginId: 'acme.vertical-a',
      version: '1.0.0',
      fetchOrigin: 'http://127.0.0.1:43123',
      connectedAccountOrigin: 'https://127.0.0.1:43124',
    });

    const configuredTest = await readFile(join(pluginRoot, 'test', 'index.test.mjs'), 'utf8');
    const configuredSource = await readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8');
    const configuredPackage = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
    const configuredUiBuild = await readFile(join(pluginRoot, 'pluginUiBuild.mjs'), 'utf8');
    const configuredVite = await readFile(join(pluginRoot, 'vite.config.mjs'), 'utf8');
    const configuredHostedWeb = await readFile(join(pluginRoot, 'src', 'ui', 'index.html'), 'utf8');
    assert.match(configuredTest, /registrations\(\)/u);
    assert.match(configuredTest, /localId === 'roundtrip'/u);
    assert.match(configuredTest, /family === 'requestInterceptors'/u);
    assert.match(configuredTest, /localId === 'observe-api'/u);
    assert.match(configuredTest, /family === 'agents'/u);
    assert.match(configuredTest, /localId === 'packed-external-agent'/u);
    assert.match(configuredTest, /family === 'connectedAccountDescriptors'/u);
    assert.match(configuredTest, /localId === 'novel-cloud'/u);
    assert.match(configuredSource, /api\.interceptors\.register\('observe-api'/u);
    assert.match(configuredSource, /api\.agents\.registerExternalSessions\('packed-external-agent'/u);
    assert.match(configuredSource, /api\.agents\.registerExternalSessionObservation\('packed-external-agent'/u);
    assert.match(configuredSource, /api\.connectedAccounts\.register\('novel-cloud', packedNovelCloudConnectedAccountRuntime\)/u);
    assert.match(configuredSource, /context\.services\.connectedAccounts\.requestSelection\(/u);
    assert.match(configuredSource, /context\.services\.connectedAccounts\.watch\('packed-novel-account'/u);
    assert.match(configuredSource, /appendMarker\('connected-account-watch-ready'\)/u);
    assert.match(configuredSource, /resolveScmHostingProviderRegistry/u);
    assert.match(configuredSource, /registry\?\.getAdapter\("acme\.vertical-a\/forge"\)/u);
    assert.doesNotMatch(configuredSource, /packedForgeAdapter\.describePublishTargets/u);
    for (const marker of [
      'connected-account-refresh',
      'connected-account-revoke',
      'connected-account-status',
      'connected-account-quota',
    ]) {
      assert.ok(configuredSource.includes(`appendMarker('${marker}')`));
    }
    assert.doesNotMatch(configuredSource, /tokenMaterializer|basicAuthMaterializer/u);
    assert.match(configuredSource, /appendMarker\('scm-auth-account-b'\)/u);
    assert.match(configuredSource, /appendMarker\('scm-auth-wrong-account'\)/u);
    assert.match(configuredSource, /authentication:\s*\{\s*modes:\s*\{/u);
    assert.match(configuredSource, /manual:\s*\{\s*kind: 'manual'/u);
    assert.match(configuredSource, /oauth:\s*\{\s*kind: 'oauthAuthorizationCode'/u);
    assert.match(configuredSource, /device:\s*\{\s*kind: 'oauthDeviceCode'/u);
    assert.equal(configuredPackage.scripts['build:ui'], 'happier-plugin-build-ui --project-root .');
    assert.equal(configuredPackage.dependencies.react, '19.2.0');
    assert.equal(configuredPackage.devDependencies.vite, '^7.0.0');
    assert.match(configuredUiBuild, /rendererId: 'main-web'/u);
    assert.match(configuredUiBuild, /kind: 'hostedWeb'/u);
    assert.match(configuredVite, /dist\/ui\/hosted-web\/main-web/u);
    assert.match(configuredHostedWeb, /Vertical A packed hosted web surface/u);
    assert.match(configuredSource, /\.cleanup-fatal/u);
    assert.match(configuredSource, /appendMarker\('cleanup-failure'\)/u);
    for (const marker of [
      'external-resolve-source',
      'external-list',
      'external-link',
      'external-resolve-linked',
      'external-page',
      'external-read-after',
    ]) {
      assert.ok(configuredSource.includes(`appendMarker('${marker}')`));
    }
    assert.match(configuredSource, /outcome: 'advanced' as const/u);
    assert.match(configuredSource, /boundary: `packed-tail-next-\$\{pluginVersion\}`/u);
    assert.match(
      configuredSource,
      /const groupPackedExternalSessionResource = .* => \(\{\s*resourceKey: `packed-resource-\$\{request\.source\.scope\}`,\s*linkKey: request\.remoteSessionId,\s*\}\);/u,
    );
    assert.match(
      configuredSource,
      /const describePackedExternalSessionResource = .* => \(\{\s*\.\.\.groupPackedExternalSessionResource\(request\),\s*changeObservation: 'reconcile_only' as const,\s*\}\);/u,
    );
    assert.match(
      configuredSource,
      /describeResource: groupPackedExternalSessionResource/u,
    );
    assert.ok(configuredSource.includes('http://127.0.0.1:43123'));
    assert.ok(!configuredSource.includes('https://127.0.0.1:43124'));
    assert.match(
      configuredSource,
      /const configuredOrigin = context\.configuration\.values\['api-origin'\]/u,
    );
    assert.match(
      configuredSource,
      /context\.configuration\.values\['authorization-origin'\]/u,
    );
    assert.match(
      configuredSource,
      /authorizationUrl\.searchParams\.set\('redirect_uri', input\.callbackUrl\)/u,
    );
    assert.match(
      configuredSource,
      /url: `\$\{configuredOrigin\}\/@happier-dev%2fplugin-sdk`/u,
    );
    assert.match(
      configuredSource,
      /context\.configuration\.getSecret\('account-secret'\)/u,
    );
    const packedRunnerSource = await readFile(
      new URL('../../src/plugin-platform/runPackedAuthorVerticalA.ts', import.meta.url),
      'utf8',
    );
    const packedHarnessSource = await readFile(
      new URL('./run-packed-author-ui-compat.mjs', import.meta.url),
      'utf8',
    );
    assert.match(
      packedRunnerSource,
      /RPC_METHODS\.DAEMON_EXTERNAL_SESSION_STATUS_GET/u,
    );
    assert.match(
      packedRunnerSource,
      /hookStatus\(\{\s*intent: 'install_preview',?\s*\}\)/u,
    );
    assert.match(
      packedRunnerSource,
      /hookStatus\(\{\s*intent: 'passive_inventory',\s*limit: 50,\s*\}\)/u,
    );
    assert.match(
      packedRunnerSource,
      /localId: 'forge',\s*\},\s*purpose: 'authentication',\s*\},\s*target: \{\s*kind: 'group',\s*service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,\s*groupId: 'packed-fallback'/u,
    );
    const firstQualifiedMemberWriteStart = packedRunnerSource.indexOf(
      'const qualifiedGroupWithAccountA = await mutateQualifiedGroup(',
    );
    const secondQualifiedMemberWriteStart = packedRunnerSource.indexOf(
      'const qualifiedGroupWithAccountB = await mutateQualifiedGroup(',
    );
    assert.ok(
      firstQualifiedMemberWriteStart >= 0
        && secondQualifiedMemberWriteStart > firstQualifiedMemberWriteStart,
    );
    assert.doesNotMatch(
      packedRunnerSource.slice(
        firstQualifiedMemberWriteStart,
        secondQualifiedMemberWriteStart,
      ),
      /expectedRuntimeStateRevision/u,
    );
    assert.match(
      packedRunnerSource,
      /expectedRuntimeStateRevision:\s*qualifiedGroupWithAccountA\.runtimeStateRevision/u,
    );
    assert.match(
      packedRunnerSource,
      /expectedGeneration:\s*qualifiedGroupWithAccountB\.generation/u,
    );
    assert.match(
      packedRunnerSource,
      /expectedRuntimeStateRevision:\s*qualifiedGroupWithAccountB\.runtimeStateRevision/u,
    );
    assert.match(
      packedRunnerSource,
      /HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS:\s*'5000'/u,
    );
    assert.match(
      packedRunnerSource,
      /HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED:\s*'true'/u,
    );
    assert.match(
      packedRunnerSource,
      /HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS:\s*'5000'/u,
    );
    assert.match(
      packedRunnerSource,
      /phase === 'establishedOperations'/u,
    );
    assert.match(
      packedRunnerSource,
      /operation:\s*'replaceConfiguration'/u,
    );
    assert.match(
      packedRunnerSource,
      /operation:\s*'revokeAccount'/u,
    );
    assert.match(
      packedRunnerSource,
      /\/v4\/connect\/qualified\/quotas\/refresh/u,
    );
    assert.match(
      packedRunnerSource,
      /QualifiedConnectedAccountCredentialHealthPatchV4Schema\.parse\(\{/u,
    );
    assert.match(
      packedRunnerSource,
      /body:\s*JSON\.stringify\(healthPatch\)/u,
    );
    assert.match(
      packedRunnerSource,
      /QualifiedConnectedAccountQuotaQueryV4Schema\.parse\(\{\s*ref:\s*accountB,\s*\}\)/u,
    );
    assert.match(
      packedRunnerSource,
      /body:\s*JSON\.stringify\(quotaRefreshQuery\)/u,
    );
    assert.match(
      packedRunnerSource,
      /cleanupGroupReferences:\s*true/u,
    );
    assert.match(
      packedRunnerSource,
      /operation:\s*'describeService',\s*service:\s*PACKED_GITHUB_CONNECTED_ACCOUNT_SERVICE/u,
    );
    assert.match(
      packedRunnerSource,
      /operation:\s*'describeService',\s*service:\s*PACKED_BITBUCKET_CONNECTED_ACCOUNT_SERVICE/u,
    );
    assert.match(
      packedRunnerSource,
      /const providerCancellationStart = await command\(\{[\s\S]*?modeId:\s*'oauth'[\s\S]*?const beginProviderCancellation =[\s\S]*?waitForAttemptStatus\([\s\S]*?'awaitingOAuth'[\s\S]*?const providerCancellation = beginProviderCancellation\.attemptId[\s\S]*?operation:\s*'cancel'/u,
    );
    assert.match(
      packedRunnerSource,
      /const reconcileOAuth = completeOAuth\.attemptId[\s\S]*?operation:\s*'reconcile'/u,
    );
    assert.match(
      packedRunnerSource,
      /ConnectedAccountDaemonControlResponseSchema/u,
    );
    assert.match(
      packedRunnerSource,
      /CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD/u,
    );
    assert.match(
      packedRunnerSource,
      /ConnectedAccountAttemptResponseSchema/u,
    );
    assert.match(
      packedRunnerSource,
      /CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD/u,
    );
    assert.doesNotMatch(
      packedRunnerSource,
      /method:\s*['"]daemon\.connectedAccounts\.(?:authentication|control)\.command['"]/u,
    );
    for (const durableEvidenceName of [
      'accountACredentialAfterScheduledStatus',
      'deviceConfigurationAfter',
      'initialQuotaUsage',
      'accountAProfileAfterRevoke',
      'accountBProfileAfterDelete',
    ]) {
      assert.ok(
        packedRunnerSource.includes(durableEvidenceName),
        `packed established operations must return ${durableEvidenceName}`,
      );
    }
    assert.match(
      packedHarnessSource,
      /evidencePairs:\s*\{/u,
    );
    const statusTickSynchronizationIndex = packedHarnessSource.indexOf(
      'const statusTickSynchronizationStartedAt = Date.now();',
    );
    const establishedOperationsProbeIndex = packedHarnessSource.indexOf(
      "phase: 'establishedOperations'",
    );
    assert.ok(
      statusTickSynchronizationIndex >= 0
        && establishedOperationsProbeIndex > statusTickSynchronizationIndex,
      'packed established status mutation must start just after a completed scheduler tick',
    );
    for (const markerKind of [
      'connected-account-status',
      'connected-account-refresh',
      'connected-account-quota',
      'connected-account-revoke',
    ]) {
      assert.ok(
        packedHarnessSource.includes(
          `establishedMarkerDeltas['${markerKind}']`,
        ),
        `packed established operation must pair ${markerKind} with durable evidence`,
      );
    }
    assert.match(
      packedHarnessSource,
      /githubDescription\.descriptor\.authentication\.defaultModeId\s*!==\s*'fine-grained-pat'/u,
    );
    assert.match(
      packedHarnessSource,
      /bitbucketDescription\.descriptor\.authentication\.defaultModeId\s*!==\s*'manual'/u,
    );
    assert.match(
      packedHarnessSource,
      /initialQuotaUsage\?\.providerId\s*!==\s*'acme\.vertical-a\/novel-cloud'/u,
    );
    assert.match(
      packedHarnessSource,
      /accountAProfileAfterRevoke\s*!==\s*null/u,
    );
    assert.match(
      packedHarnessSource,
      /accountBProfileAfterDelete\s*!==\s*null/u,
    );
    assert.match(
      packedHarnessSource,
      /\[\s*'install',\s*'plugin',\s*'update',\s*plugin\.pluginId,\s*'--json',?\s*\]/u,
    );
    assert.doesNotMatch(
      packedHarnessSource,
      /event\.version === plugin\.version/u,
    );
    assert.match(
      packedHarnessSource,
      /event\.version === '1\.0\.0'/u,
    );
    const purposeBindingWriteIndex = packedRunnerSource.indexOf(
      'await upsertEncryptedAccountSettingsV2({',
    );
    assert.ok(
      purposeBindingWriteIndex
        > packedRunnerSource.indexOf('probeConnectedAccounts: async'),
      'packed purpose bindings must be written only after the plugin consumer is installed',
    );
    assert.doesNotMatch(configuredTest, /save-note/u);
  } finally {
    await rm(pluginRoot, { recursive: true, force: true });
  }
});

test('packed identity and command envelopes cannot be supplied only by the candidate manifest', () => {
  assert.doesNotThrow(() => assertPackedPackageIdentity(
    { name: '@happier-dev/cli', version: '0.2.10' },
    { packageName: '@happier-dev/cli', version: '0.2.10' },
    'Packed CLI',
  ));
  assert.throws(() => assertPackedPackageIdentity(
    { name: '@scope/lookalike-cli', version: '0.2.10' },
    { packageName: '@happier-dev/cli', version: '0.2.10' },
    'Packed CLI',
  ), /identity mismatch/u);
  assert.doesNotThrow(() => assertPackedCliEntrypoint(
    { bin: { happier: './bin/happier.mjs' } },
    { entrypoint: 'package/bin/happier.mjs' },
  ));
  assert.throws(() => assertPackedCliEntrypoint(
    { bin: { happier: './bin/happier.mjs' } },
    { entrypoint: 'package/bin/lookalike.mjs' },
  ), /published happier bin/u);

  assert.deepEqual(
    parseSuccessfulCommandEnvelope('{"ok":true,"kind":"plugins_author_build","data":{"operation":"build","projectRoot":"/tmp/plugin"}}\n', 'plugins_author_build'),
    { ok: true, kind: 'plugins_author_build', data: { operation: 'build', projectRoot: '/tmp/plugin' } },
  );
  assert.throws(
    () => parseSuccessfulCommandEnvelope('{"ok":false,"kind":"plugins_author_build"}\n', 'plugins_author_build'),
    /reported failure/u,
  );
});

test('packed command envelope parsing accepts an interactive trust prompt before the JSON result', () => {
  assert.deepEqual(
    parseSuccessfulCommandEnvelope(
      'Install & Trust Vertical A Plugin 2.0.0 from /tmp/plugin.tgz? [y/N] '
        + '{"v":1,"ok":true,"kind":"plugins_install","data":{"pluginId":"acme.vertical-a"}}\n',
      'plugins_install',
    ),
    {
      v: 1,
      ok: true,
      kind: 'plugins_install',
      data: { pluginId: 'acme.vertical-a' },
    },
  );
});

test('packed reviewed install carries exact daemon review through the authenticated private decision boundary', async () => {
  const review = {
    pluginId: 'acme.vertical-a',
    displayName: 'Vertical A',
    version: '1.0.0',
    packageIdentity: { name: null, version: '1.0.0' },
    publisherIdentity: { status: 'unavailable' },
    source: {
      kind: 'archive',
      locator: '/candidate/vertical-a.tgz',
      integrity: 'sha256:candidate',
    },
    updateChannel: {
      kind: 'archive',
      locator: '/candidate/vertical-a.tgz',
    },
    integrity: {
      packageDigest: `sha256:${'a'.repeat(64)}`,
      manifestDigest: `sha256:${'b'.repeat(64)}`,
      uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
    },
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [{ family: 'actions', count: 1 }],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [{
      id: 'packed-notification-token',
      capability: 'secrets',
      reason: 'Authenticate the packed notification channel',
      authorizationClass: 'hostResourceSelection',
      normalizedScope: {
        secretIds: ['packed-notification-token'],
        access: ['read'],
      },
    }],
    optionalHostAccess: [],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'manual',
  };
  const calls = [];
  const change = {
    kind: 'committed',
    pluginId: review.pluginId,
    desiredGeneration: 'generation-1',
    appliedGeneration: 'generation-1',
    pendingSurfaces: [],
  };

  const result = await runPackedReviewedPluginInstall({
    cliEntrypoint: '/candidate/bin/happier.mjs',
    cwd: '/candidate/workspace',
    env: { HAPPIER_HOME_DIR: '/candidate/home' },
    args: ['plugins', 'install', review.source.locator, '--json'],
    runCli: async (input) => {
      calls.push({ kind: 'cli', input });
      return {
        code: 1,
        signal: null,
        stdout: `${JSON.stringify({
          v: 1,
          ok: false,
          kind: 'plugins_install',
          error: {
            code: 'review_required',
            message: 'Install and trust review is required.',
            pendingChangeId: 'pending-vertical-a',
            review,
          },
        })}\n`,
        stderr: '',
      };
    },
    decideInstallReview: async (input) => {
      calls.push({ kind: 'decision', input });
      return change;
    },
  });

  assert.deepEqual(result, {
    pendingChangeId: 'pending-vertical-a',
    review,
    change,
  });
  assert.deepEqual(calls, [
    {
      kind: 'cli',
      input: {
        cliEntrypoint: '/candidate/bin/happier.mjs',
        cwd: '/candidate/workspace',
        env: { HAPPIER_HOME_DIR: '/candidate/home' },
        args: ['plugins', 'install', review.source.locator, '--json'],
      },
    },
    {
      kind: 'decision',
      input: {
        happyHomeDir: '/candidate/home',
        pendingChangeId: 'pending-vertical-a',
        review,
      },
    },
  ]);
});

test('packed reviewed install reports the post-timeout daemon catalog state without retrying the decision', async () => {
  const review = {
    pluginId: 'acme.timeout-diagnostic',
    displayName: 'Timeout diagnostic',
    version: '1.0.0',
    packageIdentity: { name: null, version: '1.0.0' },
    publisherIdentity: { status: 'unavailable' },
    source: {
      kind: 'archive',
      locator: '/candidate/timeout-diagnostic.tgz',
      integrity: 'sha256:candidate',
    },
    updateChannel: {
      kind: 'archive',
      locator: '/candidate/timeout-diagnostic.tgz',
    },
    integrity: {
      packageDigest: `sha256:${'a'.repeat(64)}`,
      manifestDigest: `sha256:${'b'.repeat(64)}`,
      uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
    },
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [{ family: 'actions', count: 1 }],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'manual',
  };
  const calls = [];
  const timeout = Object.assign(
    new Error('Authenticated plugin install review decision timed out'),
    {
      code: 'authenticated_plugin_install_review_timeout',
      diagnostic: {
        rpcStartedAtMs: 100,
        rpcTimedOutAtMs: 200,
        connectedBefore: true,
        connectedAfter: true,
        transitionsDuringRpc: [],
      },
    },
  );

  await assert.rejects(
    runPackedReviewedPluginInstall({
      cliEntrypoint: '/candidate/bin/happier.mjs',
      cwd: '/candidate/workspace',
      env: { HAPPIER_HOME_DIR: '/candidate/home' },
      args: ['plugins', 'install', review.source.locator, '--json'],
      runCli: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            code: 1,
            signal: null,
            stdout: `${JSON.stringify({
              v: 1,
              ok: false,
              kind: 'plugins_install',
              error: {
                code: 'review_required',
                message: 'Install and trust review is required.',
                pendingChangeId: 'pending-timeout',
                review,
              },
            })}\n`,
            stderr: '',
          };
        }
        return {
          code: 0,
          signal: null,
          stdout: `${JSON.stringify({
            v: 1,
            ok: true,
            kind: 'plugins_list',
            data: {
              plugins: [{
                pluginId: review.pluginId,
                version: review.version,
                enabled: true,
                desiredGeneration: 'generation-timeout',
                appliedGeneration: 'generation-timeout',
              }],
            },
          })}\n`,
          stderr: '',
        };
      },
      decideInstallReview: async () => {
        throw timeout;
      },
    }),
    (error) => {
      assert.match(error.message, /Authenticated plugin install review decision timed out/u);
      assert.deepEqual(error.postTimeoutPluginCatalog, {
        classification: 'committed_applied',
        command: { code: 0, signal: null },
        plugin: {
          pluginId: review.pluginId,
          version: review.version,
          enabled: true,
          desiredGeneration: 'generation-timeout',
          appliedGeneration: 'generation-timeout',
        },
      });
      return true;
    },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    cliEntrypoint: '/candidate/bin/happier.mjs',
    cwd: '/candidate/workspace',
    env: { HAPPIER_HOME_DIR: '/candidate/home' },
    args: ['plugins', 'list', '--json'],
  });

  const notCommittedCalls = [];
  await assert.rejects(
    runPackedReviewedPluginInstall({
      cliEntrypoint: '/candidate/bin/happier.mjs',
      cwd: '/candidate/workspace',
      env: { HAPPIER_HOME_DIR: '/candidate/home' },
      args: ['plugins', 'install', review.source.locator, '--json'],
      runCli: async (input) => {
        notCommittedCalls.push(input);
        return notCommittedCalls.length === 1
          ? {
              code: 1,
              signal: null,
              stdout: `${JSON.stringify({
                v: 1,
                ok: false,
                kind: 'plugins_install',
                error: {
                  code: 'review_required',
                  message: 'Install and trust review is required.',
                  pendingChangeId: 'pending-timeout',
                  review,
                },
              })}\n`,
              stderr: '',
            }
          : {
              code: 0,
              signal: null,
              stdout: `${JSON.stringify({
                v: 1,
                ok: true,
                kind: 'plugins_list',
                data: { plugins: [] },
              })}\n`,
              stderr: '',
            };
      },
      decideInstallReview: async () => {
        throw timeout;
      },
    }),
    (error) => {
      assert.deepEqual(error.postTimeoutPluginCatalog, {
        classification: 'not_committed',
        command: { code: 0, signal: null },
        plugin: null,
      });
      return true;
    },
  );
  assert.equal(notCommittedCalls.length, 2);
});

test('packed reviewed install rejects incomplete review disclosure before the trust decision', async () => {
  let decisionCalled = false;
  await assert.rejects(
    runPackedReviewedPluginInstall({
      cliEntrypoint: '/candidate/bin/happier.mjs',
      cwd: '/candidate/workspace',
      env: { HAPPIER_HOME_DIR: '/candidate/home' },
      args: ['plugins', 'install', '/candidate/plugin.tgz', '--json'],
      runCli: async () => ({
        code: 1,
        signal: null,
        stdout: `${JSON.stringify({
          ok: false,
          kind: 'plugins_install',
          error: {
            code: 'review_required',
            pendingChangeId: 'pending-incomplete',
            review: {
              pluginId: 'acme.incomplete',
              displayName: 'Incomplete',
              version: '1.0.0',
              source: { kind: 'archive', locator: '/candidate/plugin.tgz' },
              executableRealms: ['daemon'],
              optionalHostAccess: [],
            },
          },
        })}\n`,
        stderr: '',
      }),
      decideInstallReview: async () => {
        decisionCalled = true;
        return { kind: 'committed' };
      },
    }),
    /complete closed review facts/u,
  );
  assert.equal(decisionCalled, false);
});

test('packed reviewed install rejects the retired headless approval flag', async () => {
  await assert.rejects(
    runPackedReviewedPluginInstall({
      cliEntrypoint: '/candidate/bin/happier.mjs',
      cwd: '/candidate/workspace',
      env: { HAPPIER_HOME_DIR: '/candidate/home' },
      args: ['plugins', 'install', '/candidate/plugin.tgz', '--install-and-trust', '--json'],
      runCli: async () => {
        throw new Error('retired approval must fail before process execution');
      },
      decideInstallReview: async () => {
        throw new Error('retired approval must fail before decision');
      },
    }),
    /retired headless plugin approval/u,
  );
});

test('candidate registry serves only exact SDK metadata and verified tarball bytes', async () => {
  const sdkBytes = Buffer.from('candidate-sdk');
  const sdk = {
    packageName: '@happier-dev/plugin-sdk',
    version: '0.1.0-vertical-a.run-17',
    integrity: sha512Sri(sdkBytes),
  };
  const registry = await startCandidateRegistry({
    sdk,
    sdkBytes,
    packageManifest: {
      dependencies: { '@types/node': '>=20' },
      bundledDependencies: ['@happier-dev/agents', '@happier-dev/protocol'],
    },
  });
  try {
    const metadataResponse = await fetch(`${registry.origin}/@happier-dev%2fplugin-sdk`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.versions[sdk.version].dist.integrity, sdk.integrity);
    assert.deepEqual(metadata.versions[sdk.version].dependencies, { '@types/node': '>=20' });
    assert.deepEqual(metadata.versions[sdk.version].bundledDependencies, ['@happier-dev/agents', '@happier-dev/protocol']);
    const tarballResponse = await fetch(metadata.versions[sdk.version].dist.tarball);
    assert.equal(tarballResponse.status, 200);
    assert.equal(sha512Sri(Buffer.from(await tarballResponse.arrayBuffer())), sdk.integrity);
    assert.equal((await fetch(`${registry.origin}/typescript`)).status, 404);
  } finally {
    await registry.close();
  }
});

test('private plugin registry requires the current bearer token for ping, metadata, and exact tarball bytes', async () => {
  const packageName = '@acme/private-plugin';
  const version = '1.0.0';
  const tarballBytes = Buffer.from('private-plugin-tarball');
  const registry = await startPrivatePluginRegistry({
    packageName,
    artifacts: [{ version, bytes: tarballBytes }],
    acceptedToken: 'synthetic-token-v1',
  });
  const caCertificatePath = registry.caCertificatePath;
  const ca = await readFile(registry.caCertificatePath);
  const request = async (path, token) => await new Promise((resolveRequest, rejectRequest) => {
    const outbound = httpsRequest(`${registry.origin}${path}`, {
      ca,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolveRequest({
        status: response.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    outbound.once('error', rejectRequest);
    outbound.end();
  });
  try {
    assert.equal((await request('/-/ping')).status, 401);
    assert.equal((await request('/-/ping', 'synthetic-token-v1')).status, 200);
    const metadataResponse = await request(`/${encodeURIComponent(packageName)}`, 'synthetic-token-v1');
    assert.equal(metadataResponse.status, 200);
    const metadata = JSON.parse(metadataResponse.body.toString('utf8'));
    assert.equal(metadata.versions[version].dist.integrity, sha512Sri(tarballBytes));
    const tarballUrl = new URL(metadata.versions[version].dist.tarball);
    const tarballResponse = await request(tarballUrl.pathname, 'synthetic-token-v1');
    assert.equal(tarballResponse.status, 200);
    assert.deepEqual(tarballResponse.body, tarballBytes);

    registry.setAcceptedToken('synthetic-token-v2');
    assert.equal((await request('/-/ping', 'synthetic-token-v1')).status, 401);
    assert.equal((await request('/-/ping', 'synthetic-token-v2')).status, 200);
  } finally {
    await registry.close();
  }
  await assert.rejects(
    access(caCertificatePath),
    (error) => error?.code === 'ENOENT',
  );
});

test('private plugin registry retries fixture cleanup after a transient removal failure', {
  skip: process.platform === 'win32',
}, async () => {
  const registry = await startPrivatePluginRegistry({
    packageName: '@acme/private-plugin',
    artifacts: [{ version: '1.0.0', bytes: Buffer.from('private-plugin-tarball') }],
    acceptedToken: 'synthetic-token',
  });
  const fixtureDirectoryPath = dirname(registry.caCertificatePath);
  await chmod(fixtureDirectoryPath, 0o000);

  try {
    await assert.rejects(
      registry.close(),
      (error) => error?.code === 'EACCES',
    );
    await chmod(fixtureDirectoryPath, 0o700);
    await registry.close();
    await assert.rejects(
      access(fixtureDirectoryPath),
      (error) => error?.code === 'ENOENT',
    );
  } finally {
    await chmod(fixtureDirectoryPath, 0o700).catch(() => undefined);
    await rm(fixtureDirectoryPath, { recursive: true, force: true });
  }
});

test('private plugin registry distinguishes ambient root probes from protected or unexpected access', () => {
  const classify = (request) => classifySyntheticNpmRegistryRequest({
    ...request,
    packageName: '@acme/private-plugin',
    artifactPathnames: ['/@acme/private-plugin/-/private-plugin-1.0.0.tgz'],
  });

  assert.equal(classify({
    method: 'GET',
    pathname: '/',
    authorization: null,
  }), 'ambient-availability-probe');
  assert.equal(classify({
    method: 'HEAD',
    pathname: '/',
    authorization: null,
    accept: 'text/html,application/xhtml+xml,*/*;q=0.1',
    connection: 'close',
  }), 'ambient-availability-probe');
  assert.equal(classify({
    method: 'HEAD',
    pathname: '/',
    authorization: null,
    accept: '*/*',
    connection: 'close',
  }), 'unexpected-registry-request');
  assert.equal(classify({
    method: 'HEAD',
    pathname: '/',
    authorization: 'Bearer boundary-secret',
    accept: 'text/html,application/xhtml+xml,*/*;q=0.1',
    connection: 'close',
  }), 'unexpected-registry-request');
  assert.equal(classify({
    method: 'HEAD',
    pathname: '/-/ping',
    authorization: null,
    accept: 'text/html,application/xhtml+xml,*/*;q=0.1',
    connection: 'close',
  }), 'unexpected-registry-request');
  assert.equal(classify({
    method: 'HEAD',
    pathname: '/',
    authorization: null,
    accept: 'text/html,application/xhtml+xml,*/*;q=0.1',
    connection: 'keep-alive',
  }), 'unexpected-registry-request');
  assert.equal(classify({
    method: 'GET',
    pathname: '/',
    authorization: 'Bearer boundary-secret',
  }), 'unexpected-registry-request');
  assert.equal(classify({
    method: 'GET',
    pathname: '/-/ping',
    authorization: null,
  }), 'registry-protocol');
  assert.equal(classify({
    method: 'GET',
    pathname: '/%40acme%2Fprivate-plugin',
    authorization: null,
  }), 'registry-protocol');
  assert.equal(classify({
    method: 'GET',
    pathname: '/@acme/private-plugin/-/private-plugin-1.0.0.tgz',
    authorization: null,
  }), 'registry-protocol');
  assert.equal(classify({
    method: 'GET',
    pathname: '/unexpected',
    authorization: null,
  }), 'unexpected-registry-request');
});

test('extra CA bundle refresh retains prior certificate bytes after its fixture closes', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'happier-extra-ca-bundle-'));
  const firstCertificatePath = join(rootPath, 'first-ca.pem');
  const secondCertificatePath = join(rootPath, 'second-ca.pem');
  const bundlePath = join(rootPath, 'combined-ca.pem');
  const refresh = createExtraCaBundleRefresher({ bundlePath });
  try {
    await writeFile(firstCertificatePath, 'FIRST CERTIFICATE\n', 'utf8');
    await refresh(firstCertificatePath);
    await rm(firstCertificatePath);
    await writeFile(secondCertificatePath, 'SECOND CERTIFICATE\n', 'utf8');

    await refresh(secondCertificatePath);

    assert.equal(
      await readFile(bundlePath, 'utf8'),
      'FIRST CERTIFICATE\n\nSECOND CERTIFICATE\n\n',
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('synthetic plugin registry can serve an unauthenticated exact npm artifact', async () => {
  const packageName = 'acme-public-plugin';
  const version = '1.0.0';
  const tarballBytes = Buffer.from('public-plugin-tarball');
  const registry = await startPrivatePluginRegistry({
    packageName,
    artifacts: [{ version, bytes: tarballBytes }],
    acceptedToken: null,
  });
  const ca = await readFile(registry.caCertificatePath);
  const request = async (path) => await new Promise((resolveRequest, rejectRequest) => {
    const outbound = httpsRequest(`${registry.origin}${path}`, { ca }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolveRequest({
        status: response.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    outbound.once('error', rejectRequest);
    outbound.end();
  });
  try {
    assert.equal((await request('/-/ping')).status, 200);
    const metadataResponse = await request(`/${encodeURIComponent(packageName)}`);
    assert.equal(metadataResponse.status, 200);
    const metadata = JSON.parse(metadataResponse.body.toString('utf8'));
    assert.equal(metadata.versions[version].dist.integrity, sha512Sri(tarballBytes));
    const tarballResponse = await request(new URL(metadata.versions[version].dist.tarball).pathname);
    assert.equal(tarballResponse.status, 200);
    assert.deepEqual(tarballResponse.body, tarballBytes);
  } finally {
    await registry.close();
  }
});

test('packed CLI execution rejects a symlink that escapes the extracted package', async () => {
  const extractionRoot = await mkdtemp(join(tmpdir(), 'happier-packed-cli-entrypoint-'));
  const packageRoot = join(extractionRoot, 'package');
  const outsidePath = join(extractionRoot, 'outside.mjs');
  try {
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await writeFile(outsidePath, '', 'utf8');
    await symlink(outsidePath, join(packageRoot, 'bin', 'happier.mjs'));
    await assert.rejects(
      resolvePackedCliEntrypoint(extractionRoot, 'package/bin/happier.mjs'),
      /contained regular file/u,
    );
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
});

test('packed daemon identity is observed from the installed CLI entrypoint and exact build version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-daemon-identity-'));
  const packageRoot = join(root, 'node_modules', '@happier-dev', 'cli');
  const entrypoint = join(packageRoot, 'package-dist', 'index.mjs');
  const outsideEntrypoint = join(root, 'workspace-source.ts');
  try {
    await mkdir(join(packageRoot, 'package-dist'), { recursive: true });
    await writeFile(entrypoint, '', 'utf8');
    await writeFile(outsideEntrypoint, '', 'utf8');

    const identity = await assertPackedDaemonRuntimeIdentity({
      installedCliPackageRoot: packageRoot,
      candidateVersion: '0.2.10',
      daemonState: { pid: 4242, startedWithCliVersion: '0.2.10' },
      expectedDaemonPid: 4242,
      runtime: {
        execPath: process.execPath,
        argv: [process.execPath, entrypoint, 'daemon'],
      },
    });

    assert.equal(identity.entrypoint, await realpath(entrypoint));
    assert.equal(identity.packageRelativeEntrypoint, 'package-dist/index.mjs');
    assert.equal(identity.cliVersion, '0.2.10');
    assert.equal(identity.pid, 4242);
    await assert.rejects(
      assertPackedDaemonRuntimeIdentity({
        installedCliPackageRoot: packageRoot,
        candidateVersion: '0.2.10',
        daemonState: { pid: 4242, startedWithCliVersion: '0.2.10' },
        expectedDaemonPid: 4242,
        runtime: {
          execPath: process.execPath,
          argv: [process.execPath, outsideEntrypoint, 'daemon'],
        },
      }),
      /not the installed CLI runtime/iu,
    );
    await assert.rejects(
      assertPackedDaemonRuntimeIdentity({
        installedCliPackageRoot: packageRoot,
        candidateVersion: '0.2.10',
        daemonState: { pid: 4242, startedWithCliVersion: '0.2.9' },
        expectedDaemonPid: 4242,
        runtime: {
          execPath: process.execPath,
          argv: [process.execPath, entrypoint, 'daemon'],
        },
      }),
      /build identity mismatch/iu,
    );
    await assert.rejects(
      assertPackedDaemonRuntimeIdentity({
        installedCliPackageRoot: packageRoot,
        candidateVersion: '0.2.10',
        daemonState: { pid: 4343, startedWithCliVersion: '0.2.10' },
        expectedDaemonPid: 4242,
        runtime: {
          execPath: process.execPath,
          argv: [process.execPath, entrypoint, 'daemon'],
        },
      }),
      /process identity mismatch/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed CLI is installed from the exact tarball before its entrypoint executes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-cli-install-'));
  const tarballPath = join(root, 'candidate-cli.tgz');
  const installRoot = join(root, 'install');
  const calls = [];
  try {
    await writeFile(tarballPath, 'candidate-cli', 'utf8');
    const entrypoint = await materializePackedCli({
      cliArtifact: {
        packageName: '@happier-dev/cli',
        version: '0.2.10-vertical-a.run-17',
        tarballPath,
        entrypoint: 'package/bin/happier.mjs',
      },
      installRoot,
      env: {
        HOME: '/home/packed',
        NODE_OPTIONS: '--import /workspace/inject.mjs',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '/workspace/apps/cli/src/index.ts',
      },
      runImpl: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        const packageRoot = join(installRoot, 'node_modules', '@happier-dev', 'cli');
        await mkdir(join(packageRoot, 'bin'), { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
          name: '@happier-dev/cli',
          version: '0.2.10-vertical-a.run-17',
          bin: { happier: './bin/happier.mjs' },
        }), 'utf8');
        await writeFile(join(packageRoot, 'bin', 'happier.mjs'), '', 'utf8');
        return { code: 0, signal: null, stdout: '', stderr: '' };
      },
    });

    assert.equal(entrypoint, await realpath(join(
      installRoot,
      'node_modules',
      '@happier-dev',
      'cli',
      'bin',
      'happier.mjs',
    )));
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /^npm(?:\.cmd)?$/u);
    assert.deepEqual(calls[0].args, [
      'install',
      '--no-package-lock',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--userconfig',
      join(installRoot, '.packed-author-user.npmrc'),
      '--globalconfig',
      join(installRoot, '.packed-author-global.npmrc'),
      '--cache',
      join(installRoot, '.npm-cache'),
      tarballPath,
    ]);
    assert.equal(calls[0].cwd, installRoot);
    assert.equal(calls[0].env.HOME, '/home/packed');
    assert.equal(calls[0].env.NODE_OPTIONS, undefined);
    assert.equal(calls[0].env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT, undefined);
    const bootstrap = JSON.parse(await readFile(join(installRoot, 'package.json'), 'utf8'));
    assert.equal(bootstrap.private, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed CLI materialization ignores hostile ambient Node and npm configuration in a real install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-cli-real-install-'));
  const sourceRoot = join(root, 'source');
  const packageRoot = join(sourceRoot, 'package');
  const hostileHome = join(root, 'hostile-home');
  const tarballPath = join(root, 'candidate-cli.tgz');
  const installRoot = join(root, 'install');
  try {
    await Promise.all([
      mkdir(join(packageRoot, 'bin'), { recursive: true }),
      mkdir(join(packageRoot, 'package-dist'), { recursive: true }),
      mkdir(hostileHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.2.10',
        bin: { happier: './bin/happier.mjs' },
        engines: { node: '<1' },
      }), 'utf8'),
      writeFile(join(packageRoot, 'bin', 'happier.mjs'), 'export {};\n', 'utf8'),
      writeFile(join(packageRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8'),
      writeFile(join(hostileHome, '.npmrc'), 'engine-strict=true\n', 'utf8'),
    ]);
    await tar.c({ cwd: sourceRoot, file: tarballPath, gzip: true }, ['package']);

    const entrypoint = await materializePackedCli({
      cliArtifact: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        tarballPath,
        entrypoint: 'package/bin/happier.mjs',
      },
      installRoot,
      env: {
        ...process.env,
        HOME: hostileHome,
        NODE_OPTIONS: '--import /definitely/missing/workspace-inject.mjs',
        NPM_CONFIG_USERCONFIG: join(hostileHome, '.npmrc'),
        npm_config_engine_strict: 'true',
      },
    });

    assert.equal(entrypoint, await realpath(join(
      installRoot,
      'node_modules',
      '@happier-dev',
      'cli',
      'bin',
      'happier.mjs',
    )));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('vertical-a rejects a sensitive verified archive before home preparation or CLI installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-a13-census-'));
  const sdkSourceRoot = join(root, 'sdk-source');
  const cliSourceRoot = join(root, 'cli-source');
  const sdkTarballPath = join(root, 'sdk.tgz');
  const cliTarballPath = join(root, 'cli.tgz');
  let preparedHome = false;
  try {
    await Promise.all([
      mkdir(join(sdkSourceRoot, 'package'), { recursive: true }),
      mkdir(join(cliSourceRoot, 'package', 'bin'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sdkSourceRoot, 'package', 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      }), 'utf8'),
      writeFile(join(sdkSourceRoot, 'package', '.env'), 'SDK_TOKEN=secret\n', 'utf8'),
      writeFile(join(cliSourceRoot, 'package', 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.2.10',
        bin: { happier: './bin/happier.mjs' },
      }), 'utf8'),
      writeFile(join(cliSourceRoot, 'package', 'bin', 'happier.mjs'), 'export {};\n', 'utf8'),
    ]);
    await Promise.all([
      tar.c({ cwd: sdkSourceRoot, file: sdkTarballPath, gzip: true }, ['package']),
      tar.c({ cwd: cliSourceRoot, file: cliTarballPath, gzip: true }, ['package']),
    ]);
    const [sdkBytes, cliBytes] = await Promise.all([
      readFile(sdkTarballPath),
      readFile(cliTarballPath),
    ]);

    await assert.rejects(
      runVerticalA({
        schemaVersion: 1,
        runId: 'unsafe-a13',
        sdk: {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: sha512Sri(sdkBytes),
          tarballPath: sdkTarballPath,
        },
        cli: {
          packageName: '@happier-dev/cli',
          version: '0.2.10',
          integrity: sha512Sri(cliBytes),
          tarballPath: cliTarballPath,
          entrypoint: 'package/bin/happier.mjs',
        },
      }, {
        baseEnv: {},
        prepareHome: async () => {
          preparedHome = true;
          return {};
        },
        probeScm: async () => ({}),
        probeNotifications: async () => ({}),
        probeExternalSessions: async () => ({}),
        probeRetainedCapabilities: async () => ({}),
        probeConnectedAccounts: async () => ({}),
        decideInstallReview: async () => ({}),
      }),
      /sensitive environment file/iu,
    );
    assert.equal(preparedHome, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('captured vertical-a failure retains its temp root only when explicitly requested', async () => {
  assert.equal(
    packedAuthorHarness.shouldRetainPackedAuthorTempRoot({
      succeeded: true,
      retainFailedTempRequested: true,
    }),
    false,
  );
  const runId = `retained-failure-${process.pid}-${Date.now()}`;
  const tempRootPrefix = `happier-packed-author-${runId}-`;
  const originalRetainFailedTemp = process.env.HAPPIER_PACKED_AUTHOR_RETAIN_FAILED_TEMP;
  const candidate = {
    schemaVersion: 1,
    runId,
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      tarballPath: join(tmpdir(), `${runId}-missing-sdk.tgz`),
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      tarballPath: join(tmpdir(), `${runId}-missing-cli.tgz`),
      entrypoint: 'package/bin/happier.mjs',
    },
  };
  const options = {
    captureLayerResultsOnFailure: true,
    baseEnv: {},
    prepareHome: async () => {
      throw new Error('candidate verification must fail before home preparation');
    },
    probeScm: async () => ({}),
    probeNotifications: async () => ({}),
    probeExternalSessions: async () => ({}),
    probeRetainedCapabilities: async () => ({}),
    probeConnectedAccounts: async () => ({}),
    decideInstallReview: async () => ({}),
  };
  const listRetainedRoots = async () => (
    await readdir(tmpdir(), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory() && entry.name.startsWith(tempRootPrefix));

  try {
    process.env.HAPPIER_PACKED_AUTHOR_RETAIN_FAILED_TEMP = '1';
    const retainedFailure = await runVerticalA(candidate, options);
    assert.equal(retainedFailure.ok, false);
    const retainedRoots = await listRetainedRoots();
    assert.equal(retainedRoots.length, 1);
    await rm(join(tmpdir(), retainedRoots[0].name), { recursive: true, force: true });

    delete process.env.HAPPIER_PACKED_AUTHOR_RETAIN_FAILED_TEMP;
    const ordinaryFailure = await runVerticalA(candidate, options);
    assert.equal(ordinaryFailure.ok, false);
    assert.deepEqual(await listRetainedRoots(), []);
  } finally {
    if (originalRetainFailedTemp === undefined) {
      delete process.env.HAPPIER_PACKED_AUTHOR_RETAIN_FAILED_TEMP;
    } else {
      process.env.HAPPIER_PACKED_AUTHOR_RETAIN_FAILED_TEMP = originalRetainFailedTemp;
    }
    for (const entry of await listRetainedRoots()) {
      await rm(join(tmpdir(), entry.name), { recursive: true, force: true });
    }
  }
});

test('packed novel QA handoff retains the exact initial archive with portable isolated browser and device roots', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'packed-novel-handoff-parent-'));
  const outputRoot = join(parent, 'packed-novel-handoff');
  const archiveBytes = Buffer.from('exact packed novel archive bytes');
  const candidate = {
    schemaVersion: 1,
    runId: 'natural-packed-novel-handoff',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.3.1',
      integrity: 'sha512-sdk-candidate',
      tarballPath: '/candidate/sdk.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.9.4',
      integrity: 'sha512-cli-candidate',
      tarballPath: '/candidate/cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  };
  try {
    const created = await createPackedNovelConnectedAccountQaHandoff({
      outputRoot,
      candidate,
      archiveBytes,
      pluginArtifact: {
        label: 'initial-v1',
        pluginId: 'acme.vertical-a',
        version: '1.0.0',
        integrity: sha512Sri(archiveBytes),
        size: archiveBytes.byteLength,
      },
      stages: VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({ id, ok: true })),
    });
    const loaded = await loadPackedNovelConnectedAccountQaHandoff({
      manifestPath: created.manifestPath,
    });

    assert.equal(
      await readFile(loaded.plugin.archivePath, 'utf8'),
      archiveBytes.toString('utf8'),
    );
    assert.deepEqual(loaded.plugin.service, {
      pluginId: 'acme.vertical-a',
      localId: 'novel-cloud',
    });
    assert.deepEqual(loaded.plugin.authenticationModeIds, [
      'manual',
      'oauth',
      'device',
    ]);
    assert.equal(loaded.plugin.archive.packLabel, 'initial-v1');
    assert.equal(loaded.plugin.archive.integrity, sha512Sri(archiveBytes));
    assert.equal(
      loaded.plugin.archive.sha256,
      createHash('sha256').update(archiveBytes).digest('hex'),
    );
    assert.notEqual(
      loaded.consumers.browser.happyHomeDir,
      loaded.consumers.device.happyHomeDir,
    );
    assert.notEqual(
      loaded.consumers.browser.databasePath,
      loaded.consumers.device.databasePath,
    );
    assert.deepEqual(
      Object.keys(loaded.consumers.browser),
      ['root', 'happyHomeDir', 'databasePath'],
    );
    assert.deepEqual(
      Object.keys(loaded.consumers.device),
      ['root', 'happyHomeDir', 'databasePath'],
    );
    await Promise.all([
      assert.rejects(
        access(join(outputRoot, 'consumers', 'browser', 'plugin-work')),
        { code: 'ENOENT' },
      ),
      assert.rejects(
        access(join(outputRoot, 'consumers', 'browser', 'config')),
        { code: 'ENOENT' },
      ),
      assert.rejects(
        access(join(outputRoot, 'consumers', 'device', 'plugin-work')),
        { code: 'ENOENT' },
      ),
      assert.rejects(
        access(join(outputRoot, 'consumers', 'device', 'config')),
        { code: 'ENOENT' },
      ),
    ]);
    assert.equal(
      loaded.oauth.authorizationOriginConfigurationFieldId,
      'authorization-origin',
    );
    assert.equal(
      loaded.oauth.callbackUrl,
      'http://localhost:1455/auth/callback',
    );
    assert.deepEqual(
      loaded.lifecycle.completedStageIds,
      VERTICAL_A_REQUIRED_STAGE_IDS,
    );
    assert.equal(
      assertPackedNovelConnectedAccountQaCandidate({
        handoff: loaded,
        candidate,
      }),
      loaded,
    );
    assert.throws(
      () => assertPackedNovelConnectedAccountQaCandidate({
        handoff: loaded,
        candidate: {
          ...candidate,
          cli: {
            ...candidate.cli,
            integrity: 'sha512-substituted-cli-candidate',
          },
        },
      }),
      /exact SDK\/CLI candidate/u,
    );
    const serialized = JSON.stringify(loaded);
    for (const forbidden of [
      'packed-oauth-client-secret',
      'packed-device-account-secret',
      'controlToken',
      'auth.token',
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const escapedHome = join(parent, 'escaped-browser-home');
    await mkdir(escapedHome);
    await rm(loaded.consumers.browser.happyHomeDir, {
      recursive: true,
      force: true,
    });
    await symlink(
      escapedHome,
      loaded.consumers.browser.happyHomeDir,
      'dir',
    );
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /browser daemon home.*contained directory/u,
    );

    await cleanupPackedNovelConnectedAccountQaHandoff({
      manifestPath: created.manifestPath,
    });
    await assert.rejects(access(outputRoot), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('packed novel QA handoff rejects archive tampering and fixture substitution', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'packed-novel-handoff-tamper-'));
  const outputRoot = join(parent, 'packed-novel-handoff');
  const archiveBytes = Buffer.from('exact packed novel archive bytes');
  try {
    const created = await createPackedNovelConnectedAccountQaHandoff({
      outputRoot,
      candidate: {
        schemaVersion: 1,
        runId: 'natural-packed-novel-tamper',
        sdk: {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.3.1',
          integrity: 'sha512-sdk-candidate',
          tarballPath: '/candidate/sdk.tgz',
        },
        cli: {
          packageName: '@happier-dev/cli',
          version: '0.9.4',
          integrity: 'sha512-cli-candidate',
          tarballPath: '/candidate/cli.tgz',
          entrypoint: 'package/bin/happier.mjs',
        },
      },
      archiveBytes,
      pluginArtifact: {
        label: 'initial-v1',
        pluginId: 'acme.vertical-a',
        version: '1.0.0',
        integrity: sha512Sri(archiveBytes),
        size: archiveBytes.byteLength,
      },
      stages: VERTICAL_A_REQUIRED_STAGE_IDS.map((id) => ({ id, ok: true })),
    });
    const admitted = await loadPackedNovelConnectedAccountQaHandoff({
      manifestPath: created.manifestPath,
    });
    await writeFile(admitted.plugin.archivePath, 'tampered archive bytes');
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /archive (?:integrity|size) mismatch/u,
    );

    const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'));
    manifest.plugin.service.localId = 'substitute-cloud';
    await writeFile(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /exact acme\.vertical-a\/novel-cloud fixture/u,
    );

    manifest.plugin.service.localId = 'novel-cloud';
    manifest.plugin.version = '1.0.1';
    await writeFile(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /plugin version is invalid/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('packed novel OAuth authorization server performs a real HTTPS browser redirect without retaining state', async () => {
  const authorization = await startPackedNovelConnectedAccountAuthorizationServer();
  try {
    const state = 's'.repeat(43);
    const redirectUri = 'http://localhost:1455/auth/callback';
    const authorizationUrl = new URL('/authorize', authorization.origin);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    const ca = await readFile(authorization.caCertificatePath);
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const request = httpsRequest(authorizationUrl, {
        ca,
        method: 'GET',
      }, (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolveResponse(incoming));
      });
      request.once('error', rejectResponse);
      request.end();
    });

    assert.equal(response.statusCode, 302);
    const redirected = new URL(String(response.headers.location));
    assert.equal(redirected.origin + redirected.pathname, redirectUri);
    assert.equal(redirected.searchParams.get('code'), 'oauth-account');
    assert.equal(redirected.searchParams.get('state'), state);
    assert.deepEqual(authorization.getRequestSummary(), {
      authorizationRedirects: 1,
      rejectedRequests: 0,
    });
    assert.equal(
      JSON.stringify(authorization.getRequestSummary()).includes(state),
      false,
    );
  } finally {
    await authorization.close();
  }
});

test('packed CLI materialization reuses only its exact private harness root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-cli-reuse-'));
  const tarballPath = join(root, 'candidate-cli.tgz');
  const installRoot = join(root, 'install');
  const foreignRoot = join(root, 'foreign');
  const calls = [];
  try {
    await writeFile(tarballPath, 'candidate-cli', 'utf8');
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, 'package.json'), JSON.stringify({
      name: 'happier-packed-cli-candidate',
      private: true,
    }), 'utf8');

    const entrypoint = await materializePackedCli({
      cliArtifact: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        tarballPath,
        entrypoint: 'package/bin/happier.mjs',
      },
      installRoot,
      runImpl: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        const packageRoot = join(installRoot, 'node_modules', '@happier-dev', 'cli');
        await mkdir(join(packageRoot, 'bin'), { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
          name: '@happier-dev/cli',
          version: '0.2.10',
          bin: { happier: './bin/happier.mjs' },
        }), 'utf8');
        await writeFile(join(packageRoot, 'bin', 'happier.mjs'), '', 'utf8');
        return { code: 0, signal: null, stdout: '', stderr: '' };
      },
    });

    assert.equal(entrypoint, await realpath(join(
      installRoot,
      'node_modules',
      '@happier-dev',
      'cli',
      'bin',
      'happier.mjs',
    )));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, installRoot);

    await mkdir(foreignRoot, { recursive: true });
    await writeFile(join(foreignRoot, 'package.json'), JSON.stringify({
      name: 'unrelated-project',
      private: true,
    }), 'utf8');
    await assert.rejects(
      materializePackedCli({
        cliArtifact: {
          packageName: '@happier-dev/cli',
          version: '0.2.10',
          tarballPath,
          entrypoint: 'package/bin/happier.mjs',
        },
        installRoot: foreignRoot,
        runImpl: async () => {
          throw new Error('foreign materialization must fail before npm');
        },
      }),
      /materialization root is not the private packed CLI harness/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pre-run argument failures report cleanup as not applicable', () => {
  const runnerPath = fileURLToPath(new URL('./run-packed-author-ui-compat.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath, '--scenario', 'vertical-b'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout.trim());
  assert.deepEqual(envelope.cleanup, { disposition: 'not_applicable' });
});
