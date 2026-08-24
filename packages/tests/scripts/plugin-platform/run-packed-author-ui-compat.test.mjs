import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import test from 'node:test';

import * as tar from 'tar';
import {
  computePluginUiArtifactFileSetSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { resolveManagedChildInvocation } from '../../../../scripts/testing/process/managedChildLifecycle.mjs';
import { renderPackedExternalAgentExecutable } from './packed-external-agent-executable.mjs';
import * as packedAuthorHarness from './run-packed-author-ui-compat.mjs';

import {
  assertCleanupFailureDidNotBlockLaterMutation,
  assertDaemonAgentCarrierFailClosed,
  assertDiscardedDisableCurrentness,
  assertPackedBundledClaudeMaterialization,
  assertPackedAuthorCandidateInstallerArtifacts,
  attestPackedPublicAuthoringHostedWebGraph,
  assertPackedConnectedAccountDormancy,
  assertPackedConnectedAccountWatchRematerialization,
  assertPackedAuthorCredentialSentinelsAbsent,
  assertPostRestartHealthyPeerIsolation,
  assertExactMarketplaceInstallationState,
  assertReviewedCandidatePreservedCurrentness,
  assertVerticalAStageCoverage,
  assertPluginCommandAbsentFromRootHelp,
  assertRestartPreservedDesiredGeneration,
  assertVerticalANotificationLifecycleEvidence,
  assertVerticalAScmInstalledProbe,
  assertVerticalAScmUninstalledProbe,
  assertPackedCliEntrypoint,
  assertPackedDaemonRuntimeIdentity,
  assertPackedExternalPluginCommandInvocation,
  assertPackedExternalPluginCommandRetirement,
  assertPackedNovelConnectedAccountQaCandidate,
  assertPackedPackageIdentity,
  buildVerticalAEvidenceLayerResult,
  buildVerticalAResult,
  buildVerticalADaemonRestartArgs,
  classifySyntheticNpmRegistryRequest,
  capturePackedAuthorCandidateArtifacts,
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
  loadPackedAuthorVerticalAArtifacts,
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
  PACKED_AUTHOR_NATIVE_TARGETS,
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

function candidateStandaloneCliRecord({
  version = '0.2.10',
  root = '/tmp/native',
  selectedTarget = 'linux-x64',
} = {}) {
  const archives = PACKED_AUTHOR_NATIVE_TARGETS.map((target, index) => {
    const [os, arch] = target.split('-');
    return {
      product: 'happier',
      version,
      os,
      arch,
      sha256: String(index + 4).repeat(64),
      archivePath: join(root, `happier-v${version}-${target}.tar.gz`),
    };
  });
  const selected = archives.find(({ os, arch }) => `${os}-${arch}` === selectedTarget);
  assert.ok(selected);
  return {
    ...selected,
    archives,
    checksums: {
      kind: 'sha256-checksums',
      fileName: `checksums-happier-v${version}.txt`,
      sizeBytes: 23,
      sha256: '9'.repeat(64),
      filePath: join(root, `checksums-happier-v${version}.txt`),
    },
    signature: {
      kind: 'minisign-signature',
      fileName: `checksums-happier-v${version}.txt.minisig`,
      sizeBytes: 29,
      sha256: 'a'.repeat(64),
      filePath: join(root, `checksums-happier-v${version}.txt.minisig`),
    },
    notarization: ['darwin-x64', 'darwin-arm64'].map((target, index) => ({
      target,
      evidence: {
        kind: 'apple-notarization-evidence',
        fileName: `${target}.cli.json`,
        sizeBytes: 31 + index,
        sha256: String.fromCharCode('b'.charCodeAt(0) + index).repeat(64),
        filePath: join(root, `${target}.cli.json`),
      },
    })),
  };
}

function candidatePluginUiRecord({
  version = '0.0.0',
  pluginSdkVersion = version,
  root = '/tmp/packages',
} = {}) {
  return {
    packageName: '@happier-dev/plugin-ui',
    version,
    pluginSdkVersion,
    integrity: 'sha512-YWJj',
    tarballPath: join(root, 'plugin-ui.tgz'),
  };
}

function packedPublicAuthoringArtifact({
  archiveBytes = Buffer.from('exact packed public authoring archive bytes'),
} = {}) {
  const entry = 'hosted-web/review-web/entry.mjs';
  const entryBytes = Buffer.from('export const reviewWeb = true;\n');
  const files = [{ relativePath: entry, bytes: entryBytes }];
  return {
    pluginId: 'examples.public-sdk-review-assistant',
    version: '0.1.0',
    archiveBytes,
    hostedWeb: {
      contributionId: 'review-web',
      entry,
      digest: computePluginUiArtifactFileSetSha256DigestV1(files),
      files: files.map(({ relativePath, bytes }) => ({
        relativePath,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byteSize: bytes.byteLength,
      })),
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
    movedTargetResyncs: 0,
    rematerializedAccountIds: ['account-b', 'account-a'],
  });
  const toleratedRejection = (settledObservations) => ({
    code: 'plugin_host_access_resource_not_selected',
    settledObservations,
  });
  const withMovedTargetResyncs = (movedTargetResyncs) => ({
    ...watchEnvelope,
    data: {
      result: {
        ...watchEnvelope.data.result,
        movedTargetResyncs,
      },
    },
  });

  assert.deepEqual(assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope: withMovedTargetResyncs([toleratedRejection(0)]),
    mutation,
  }), {
    selection: 'plugin_ui_unavailable',
    resyncCount: 2,
    movedTargetResyncs: 1,
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
    movedTargetResyncs: 0,
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

  // A tolerated mid-move rejection that no later resync settles leaves the watch proving nothing
  // about the rejected resync, so the trailing rejection must fail the stage.
  assert.throws(() => assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope: withMovedTargetResyncs([toleratedRejection(2)]),
    mutation,
  }), /level-triggered rematerialization/u);
  // An unbounded rejection burst between two settled observations would let a host that rejects
  // most resyncs still pass on the two ordered successes, so more than one rejection per settled
  // observation must fail the stage.
  assert.throws(() => assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope: withMovedTargetResyncs([
      toleratedRejection(0),
      toleratedRejection(0),
      toleratedRejection(1),
    ]),
    mutation,
  }), /level-triggered rematerialization/u);
  // Only the mid-move rejection is admissible; any other rejection code is a product failure.
  assert.throws(() => assertPackedConnectedAccountWatchRematerialization({
    selectionEnvelope,
    watchEnvelope: withMovedTargetResyncs([{
      code: 'plugin_host_access_denied',
      settledObservations: 0,
    }]),
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
        ...(entries.browser === undefined ? {} : {
          pluginBrowser: {
            family: 'pluginBrowser',
            entriesById: entries.browser,
          },
        }),
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
  });
  assert.throws(
    () => assertVerticalAScmInstalledProbe({
      probe: { ...probe, status: { success: true } },
      ...packedScmIds,
    }),
    /did not reach the external runtime/u,
  );
  assert.throws(
    () => assertVerticalAScmInstalledProbe({
      probe: {
        ...probe,
        projection: packedScmProjection({
          backends: probe.projection.projection.familiesById.scmBackends.entriesById,
          providers: probe.projection.projection.familiesById.scmHostingProviders.entriesById,
          browser: {},
        }),
      },
      ...packedScmIds,
    }),
    /unexpectedly exposed deferred browser declarations/u,
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
  }), /left a stale SCM projection or deferred browser declarations/u);
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
  }), /left a stale SCM projection or deferred browser declarations/u);
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
            container: 'appPage',
            target: { kind: 'app' },
            renderer: 'main-renderer',
            title: 'Vertical A',
          }],
          renderers: [{
            id: 'main-renderer',
            kind: 'hostedWeb',
            source: { kind: 'artifact', artifact: 'main-renderer' },
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
    'packed-fetch',
    'packed-novel-account',
    'packed-claude-account',
  ]);
  assert.deepEqual(configured.contributes.settings, [{
    id: 'notification-configuration',
    title: 'Packed notification configuration',
    target: { kind: 'plugin' },
    scope: 'account',
    fields: [{
      id: 'webhook.endpoint',
      title: 'Endpoint',
      schema: { type: 'string', minLength: 1 },
    }, {
      id: 'webhook.token',
      title: 'Token',
      schema: { type: 'string', minLength: 8 },
      secret: true,
    }],
  }]);
  assert.equal(configured.contributes.notificationChannels[0].settings, undefined);
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
  assert.deepEqual(configured.contributes.commands, [{
    id: 'roundtrip-shared-command',
    title: 'Vertical A shared roundtrip',
    path: ['vertical-a', 'roundtrip'],
    action: 'roundtrip',
  }, {
    id: 'roundtrip-command',
    title: 'Vertical A roundtrip',
    path: ['vertical-a', 'vertical-a'],
    action: 'roundtrip',
  }]);
  assert.equal(Object.hasOwn(configured.contributes, 'structuredMessages'), false);
  assert.deepEqual(configured.contributes.sessionHeaderActions, [{
    id: 'roundtrip-header',
    title: 'Run Vertical A roundtrip',
    action: { kind: 'executeAction', action: 'roundtrip' },
    order: 10,
  }]);
  assert.deepEqual(
    configured.contributes.ui.views.map(({ id, container, target, renderer }) => ({
      id,
      container,
      target,
      renderer,
    })),
    [{
      id: 'main',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'main-renderer',
    }],
  );
  assert.deepEqual(
    configured.contributes.ui.renderers.map(({ id, kind }) => ({ id, kind })),
    [
      { id: 'main-renderer', kind: 'hostedWeb' },
      { id: 'roundtrip-card', kind: 'declarative' },
    ],
  );
  assert.equal(
    Object.hasOwn(configured.contributes.ui.renderers[1], 'requiredHostMethods'),
    false,
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
      { id: 'main-renderer', kind: 'hostedWeb' },
      { id: 'roundtrip-card', kind: 'declarative' },
    ],
  );
  assert.deepEqual(
    reconfigured.contributes.ui.views.map(({ id, container, target, renderer }) => ({
      id,
      container,
      target,
      renderer,
    })),
    [{
      id: 'main',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'main-renderer',
    }],
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
    target: {
      kind: 'plugin',
      event: {
        pluginId: 'acme.vertical-a',
        localId: 'notification-ready',
      },
    },
  }]);
  assert.deepEqual(configured.hostAccess.required, [{
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
  }]);
  assert.equal(configured.contributes.requestInterceptors, undefined);
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
  assert.deepEqual(configured.contributes.providers, [{
    v: 1,
    id: 'packed-managed-provider',
    name: 'Packed managed Provider',
    kind: 'aggregator',
    endpointTemplates: [{
      id: 'responses',
      protocol: 'openai-responses',
      baseUrl: 'http://127.0.0.1:43123/v1',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'supported',
      },
    }],
    catalog: {
      source: 'probe',
      manualModelPolicy: 'allowed',
      probes: [{
        endpointTemplateId: 'responses',
        path: '/v1/models',
        parser: 'openai-models',
      }],
    },
    managedRuntime: {
      kind: 'managed',
      connectedAccounts: [{
        purpose: 'upstream',
        service: 'novel-cloud',
        required: true,
        materializationKinds: ['environment'],
      }],
      endpointTemplateIds: ['responses'],
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
  assert.deepEqual(siblingFixture.hostAccess.required, []);
  assert.equal(siblingFixture.contributes.providers, undefined);
  assert.deepEqual(configured.contributes.notifications, [{
    id: 'packed-ready',
    kind: 'activity',
    title: 'Packed notification ready',
    eventIds: ['notification-ready'],
    defaultChannels: ['webhook'],
  }]);
  assert.equal(configured.contributes.notificationChannels[0].settings, undefined);
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
  assert.equal(configured.contributes.browserTargets, undefined);
  assert.equal(configured.contributes.browserActions, undefined);
  assert.throws(() => configureVerticalAManifest({
    manifest: { id: 'acme.vertical-a', entrypoints: { daemon: './dist/index.js' } },
    version: '1.0.0',
    pluginId: 'acme.vertical-a',
  }), /missing entrypoints\.development/u);
});

test('packed external Command lifecycle evidence requires the exact command/action invocation and a retired exit', () => {
  const invocation = {
    ok: true,
    kind: 'plugin_command',
    data: {
      commandId: 'acme.vertical-a/roundtrip-command',
      actionId: 'acme.vertical-a/roundtrip',
      result: {
        pluginId: 'acme.vertical-a',
        version: '2.0.0',
        value: 'packed-v1',
      },
    },
  };
  assert.deepEqual(
    assertPackedExternalPluginCommandInvocation({
      envelope: invocation,
      commandId: 'acme.vertical-a/roundtrip-command',
      actionId: 'acme.vertical-a/roundtrip',
      pluginId: 'acme.vertical-a',
      version: '2.0.0',
      value: 'packed-v1',
      phase: 'replacement',
    }),
    {
      commandId: 'acme.vertical-a/roundtrip-command',
      actionId: 'acme.vertical-a/roundtrip',
      version: '2.0.0',
    },
  );
  assert.throws(
    () => assertPackedExternalPluginCommandInvocation({
      envelope: {
        ...invocation,
        data: { ...invocation.data, commandId: 'acme.vertical-a/other-command' },
      },
      commandId: 'acme.vertical-a/roundtrip-command',
      actionId: 'acme.vertical-a/roundtrip',
      pluginId: 'acme.vertical-a',
      version: '2.0.0',
      value: 'packed-v1',
      phase: 'replacement',
    }),
    /Packed external Command replacement did not invoke the exact declared Action/u,
  );
  assert.deepEqual(
    assertPackedExternalPluginCommandRetirement({
      invocation: { code: 1, signal: null },
      commandPath: ['vertical-a', 'vertical-a'],
      phase: 'disable',
    }),
    {
      commandPath: 'vertical-a vertical-a',
      rejection: 'exit-1',
    },
  );
  assert.throws(
    () => assertPackedExternalPluginCommandRetirement({
      invocation: { code: 0, signal: null },
      commandPath: ['vertical-a', 'vertical-a'],
      phase: 'uninstall',
    }),
    /Packed external Command uninstall remained callable/u,
  );
});

test('vertical-a harness consumes the packed SDK UI projection instead of a manual renderer map', async () => {
  const harnessSource = await readFile(
    resolve(import.meta.dirname, 'run-packed-author-ui-compat.mjs'),
    'utf8',
  );
  assert.match(
    harnessSource,
    /pathToFileURL\(\s*join\(projectionRoot,\s*'dist',\s*'index\.js'\)\)/u,
  );
  assert.doesNotMatch(harnessSource, /readScaffoldedDefinePluginInput/u);
  assert.doesNotMatch(harnessSource, /actions: Object\.fromEntries/u);
  assert.doesNotMatch(harnessSource, /renderer\?\.id === 'main-web'/u);
});

test('vertical-a hostedWeb author stage consumes the attested Plugin UI package without requiring a plugin dependency', async () => {
  const harnessSource = await readFile(
    resolve(import.meta.dirname, 'run-packed-author-ui-compat.mjs'),
    'utf8',
  );
  assert.doesNotMatch(harnessSource, /const installedPluginUiRoot =/u);
  assert.match(harnessSource, /packageName: pluginUiPackageJson\.name/u);
  assert.match(harnessSource, /pluginSdkVersion: candidate\.pluginUi\.pluginSdkVersion/u);
});

test('vertical-a public authoring copy supplies the managed TypeScript config loader dependency', async () => {
  const harnessSource = await readFile(
    resolve(import.meta.dirname, 'run-packed-author-ui-compat.mjs'),
    'utf8',
  );
  assert.match(harnessSource, /typescript: CONFIG_LOADER_TYPESCRIPT_DEPENDENCY_SPEC/u);
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
  assert.deepEqual(configured.contributes.ui.views, [{
    id: 'settings',
    container: 'settingsPage',
    target: { kind: 'app' },
    renderer: 'settings-form',
    title: 'Descriptor-only settings',
  }]);
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
      scope: { kind: 'account' },
      values: { 'webhook.endpoint': 'https://notifications.example.test/deliver' },
      redactedKeys: ['webhook.token'],
      secrets: { 'webhook.token': { state: 'configured' } },
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
      configuration: {
        storageScope: 'synced',
        values: input.configuration.values,
        redactedKeys: input.configuration.redactedKeys,
        secrets: input.configuration.secrets,
      },
    }),
    /canonical settings\/secrets owners/u,
  );
  assert.throws(
    () => assertVerticalANotificationLifecycleEvidence({
      ...input,
      configuration: {
        ...input.configuration,
        secrets: { 'webhook.token': { state: 'missing' } },
      },
    }),
    /canonical settings\/secrets owners/u,
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

    // The win32 fixture is a `.cmd`, which Windows cannot start from argv. Reuse the
    // canonical spawn shaping instead of `shell: true`, which would concatenate argv
    // into one unescaped command line (Node DEP0190) and split the tmpdir path at any
    // space — `C:\Users\Ada Lovelace\AppData\...` is an ordinary Windows tmpdir.
    const invocation = resolveManagedChildInvocation({ command: executable, args: ['--version'] });
    const result = spawnSync(invocation.command, invocation.args, {
      env: { PATH: ownedBinDir },
      encoding: 'utf8',
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
  const distribution = {
    kind: 'npm',
    registryOrigin: 'https://registry.example.test',
    packageName: 'acme-public-registry-plugin',
  };

  const input = {
    generation: {
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: 'acme.public-registry',
      immutableGenerationId: 'generation-acme-public-registry',
      manifestRelativePath: '.happier-plugin/plugin.json',
      files: [
        { relativePath: '.happier-plugin/plugin.json', byteLength: 128 },
        { relativePath: 'dist/plugin.mjs', byteLength: 256 },
      ],
    },
    installation: {
      enabled: true,
      trust: { pluginId: 'acme.public-registry', distribution, state: 'trusted', approvedAtMs: 1 },
      source: { distribution, admittedIntegrity: artifactIntegrity },
      updatePolicy: 'automatic',
      optionalAccess: [],
    },
    runtimeCatalog: {
      state: { enabled: true },
      source: {
        kind: 'package',
        locator: distribution.packageName,
        manifestPath: '/plugins/acme-public-registry/.happier-plugin/plugin.json',
        resolvedVersion: '1.0.0',
      },
      install: {
        mode: 'managed_install',
        manifestVersion: '1.0.0',
        updatePolicy: 'automatic',
        trust: { distribution },
      },
    },
    expected: {
      pluginId: 'acme.public-registry',
      version: '1.0.0',
      marketplaceIntegrity: artifactIntegrity,
      distribution,
      updatePolicy: 'automatic',
    },
  };

  assert.doesNotThrow(() => assertExactMarketplaceInstallationState(input));
  assert.throws(
    () => assertExactMarketplaceInstallationState({
      ...input,
      installation: {
        ...input.installation,
        source: {
          ...input.installation.source,
          admittedIntegrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
        },
      },
    }),
    /did not persist source integrity and structural generation identity/u,
  );
  assert.throws(
    () => assertExactMarketplaceInstallationState({
      ...input,
      runtimeCatalog: {
        ...input.runtimeCatalog,
        source: {
          ...input.runtimeCatalog.source,
          locator: '@acme/other-plugin',
        },
      },
    }),
    /did not persist source integrity and structural generation identity/u,
  );
  assert.throws(
    () => assertExactMarketplaceInstallationState({
      ...input,
      generation: {
        ...input.generation,
        manifestRelativePath: 'missing-plugin.json',
      },
    }),
    /did not persist source integrity and structural generation identity/u,
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
    'successful-update-replacement',
    'packed-connected-account-generation-lifecycle',
    'explicit-rollback',
    'uninstall-action-currentness-absence',
    'bootstrap-adopt-lkg-restart',
    'hard-revocation-disable-restart',
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
      pluginUi: {
        packageName: '@happier-dev/plugin-ui',
        version: '0.1.0-vertical-a.run-17',
        pluginSdkVersion: '0.1.0-vertical-a.run-17',
        integrity: 'sha512-cGx1Zw==',
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
      pluginUi: candidatePluginUiRecord({
        version: '0.1.0-run-layer-owner-failure',
      }),
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

test('vertical-a uses the direct bootstrap/adopt, LKG, restart, and hard-revocation lifecycle', () => {
  for (const stageId of [
    'bootstrap-adopt-lkg-restart',
    'hard-revocation-disable-restart',
  ]) {
    assert.ok(
      VERTICAL_A_REQUIRED_STAGE_IDS.includes(stageId),
      `direct lifecycle stage is missing: ${stageId}`,
    );
  }
  for (const retiredStageId of [
    'continuous-health-role-transition',
    'automatic-lkg-recovery',
    'quarantined-explicit-rollback',
    'no-eligible-lkg-disable',
    'try-once-reinstall-quarantine',
  ]) {
    assert.equal(
      VERTICAL_A_REQUIRED_STAGE_IDS.includes(retiredStageId),
      false,
      `retired health-supervisor stage is still required: ${retiredStageId}`,
    );
  }
});

test('vertical-a requires daemon-started native Agents without a carrier to fail before leaf activation', () => {
  assert.deepEqual(assertDaemonAgentCarrierFailClosed({
    code: 1,
    signal: null,
    stdout: '',
    stderr: "Daemon-spawned native Agent backend 'auggie' is missing its runner-local runtime source\n",
  }), {
    backendId: 'auggie',
    errorCode: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
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

test('runner accepts either the canonical candidate or direct non-acceptance smoke artifacts', () => {
  assert.deepEqual(
    parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--plugin-ui-tarball',
      '/tmp/plugin-ui.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
    ]),
    {
      scenario: 'vertical-a',
      sdkTarballPath: '/tmp/sdk.tgz',
      pluginUiTarballPath: '/tmp/plugin-ui.tgz',
      cliTarballPath: '/tmp/cli.tgz',
    },
  );
  assert.deepEqual(
    parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--plugin-ui-tarball',
      '/tmp/plugin-ui.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
      '--packed-novel-qa-handoff-root',
      '/tmp/packed-novel-handoff',
    ]),
    {
      scenario: 'vertical-a',
      sdkTarballPath: '/tmp/sdk.tgz',
      pluginUiTarballPath: '/tmp/plugin-ui.tgz',
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
      '--plugin-ui-tarball',
      '/tmp/plugin-ui.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
    ]),
    /vertical-a/u,
  );
  assert.deepEqual(
    parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--candidate',
      '/tmp/candidate.json',
    ]),
    {
      scenario: 'vertical-a',
      candidateManifestPath: '/tmp/candidate.json',
    },
  );
  assert.throws(
    () => parseRunnerArgs([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--plugin-ui-tarball',
      '/tmp/plugin-ui.tgz',
      '--cli-tarball',
      '/tmp/cli.tgz',
      '--candidate',
      '/tmp/candidate.json',
    ]),
    /cannot be combined/u,
  );
});

test('vertical-a candidate admission delegates to the canonical loader and binds evidence identity', async () => {
  const candidate = {
    schemaVersion: 1,
    runId: 'canonical-run-17',
    installers: candidateInstallerRecords('/candidate/installers'),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0',
      integrity: 'sha512-canonical-sdk',
      tarballPath: '/candidate/sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord({
      version: '0.1.0',
      root: '/candidate',
    }),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-canonical-cli',
      tarballPath: '/candidate/cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord({ root: '/candidate/native' }),
  };
  const argv = [
    '--scenario',
    'vertical-a',
    '--candidate',
    '/candidate/candidate.json',
  ];
  let candidateLoaderCalls = 0;
  let naturalLoaderCalls = 0;
  const loaded = await loadPackedAuthorVerticalAArtifacts(argv, {
    loadCandidateManifestImpl: async (receivedArgv) => {
      candidateLoaderCalls += 1;
      assert.deepEqual(receivedArgv, argv);
      return candidate;
    },
    loadNaturalArtifactsImpl: async () => {
      naturalLoaderCalls += 1;
      throw new Error('natural loader must not admit a canonical candidate');
    },
  });

  assert.equal(candidateLoaderCalls, 1);
  assert.equal(naturalLoaderCalls, 0);
  assert.equal(loaded.candidate, candidate);
  assert.deepEqual(loaded.admission, {
    kind: 'canonical-candidate',
    runId: candidate.runId,
    sdk: {
      packageName: candidate.sdk.packageName,
      version: candidate.sdk.version,
      integrity: candidate.sdk.integrity,
    },
    pluginUi: {
      packageName: candidate.pluginUi.packageName,
      version: candidate.pluginUi.version,
      pluginSdkVersion: candidate.pluginUi.pluginSdkVersion,
      integrity: candidate.pluginUi.integrity,
    },
    cli: {
      packageName: candidate.cli.packageName,
      version: candidate.cli.version,
      integrity: candidate.cli.integrity,
    },
  });
});

test('packed author runner passes its verified tarball pair directly into external author proof', async () => {
  const runnerSource = await readFile(
    new URL('./run-packed-author-ui-compat.mjs', import.meta.url),
    'utf8',
  );

  assert.match(
    runnerSource,
    /runExternalAuthoringFixture\(\{\s*sdkTarballPath:\s*verifiedSdkTarballPath,\s*pluginUiTarballPath:\s*verifiedPluginUiTarballPath,\s*\}\)/su,
  );
  assert.doesNotMatch(runnerSource, /createPackedAuthorExternalAuthoringSource/u);
  assert.doesNotMatch(runnerSource, /externalAuthoringArtifactSource/u);
});

test('vertical-a candidate admission fails closed on canonical mismatch or tamper rejection', async () => {
  for (const expectedFailure of [
    'Candidate artifact integrity mismatch',
    'Candidate SDK tarball changed during admission',
  ]) {
    let naturalLoaderCalled = false;
    await assert.rejects(
      loadPackedAuthorVerticalAArtifacts([
        '--scenario',
        'vertical-a',
        '--candidate',
        '/candidate/candidate.json',
      ], {
        loadCandidateManifestImpl: async () => {
          throw new Error(expectedFailure);
        },
        loadNaturalArtifactsImpl: async () => {
          naturalLoaderCalled = true;
          throw new Error('candidate rejection must not fall back to direct smoke artifacts');
        },
      }),
      new RegExp(expectedFailure, 'u'),
    );
    assert.equal(naturalLoaderCalled, false);
  }
});

test('candidate admission rejects an incomplete native matrix before artifact verification', async () => {
  const completeStandaloneCli = candidateStandaloneCliRecord({
    root: '/candidate/native',
  });
  const baseManifest = {
    schemaVersion: 1,
    runId: 'incomplete-candidate',
    installers: candidateInstallerRecords('/candidate/installers'),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord(),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: completeStandaloneCli,
  };
  const invalidManifests = [
    {
      label: 'missing standalone CLI',
      manifest: { ...baseManifest, standaloneCli: undefined },
      expected: /standalone CLI.*complete native release matrix/u,
    },
    {
      label: 'four archives',
      manifest: {
        ...baseManifest,
        standaloneCli: {
          ...completeStandaloneCli,
          archives: completeStandaloneCli.archives.slice(0, -1),
        },
      },
      expected: /exact five-target release matrix/u,
    },
    {
      label: 'one Darwin evidence record',
      manifest: {
        ...baseManifest,
        standaloneCli: {
          ...completeStandaloneCli,
          notarization: completeStandaloneCli.notarization.slice(0, -1),
        },
      },
      expected: /both Darwin targets/u,
    },
    {
      label: 'missing checksum binding',
      manifest: {
        ...baseManifest,
        standaloneCli: { ...completeStandaloneCli, checksums: null },
      },
      expected: /exact bound checksums-happier/u,
    },
    {
      label: 'missing minisign binding',
      manifest: {
        ...baseManifest,
        standaloneCli: { ...completeStandaloneCli, signature: null },
      },
      expected: /exact bound checksums-happier.*minisig/u,
    },
  ];
  for (const { label, manifest, expected } of invalidManifests) {
    let artifactVerificationCalled = false;
    await assert.rejects(
      loadPackedAuthorCandidateManifest([
        '--candidate',
        '/candidate/candidate.json',
      ], {
        readFileImpl: async () => JSON.stringify(manifest),
        assertCandidateArtifactsImpl: async () => {
          artifactVerificationCalled = true;
        },
      }),
      expected,
      label,
    );
    assert.equal(artifactVerificationCalled, false, label);
  }
});

test('ordinary packed admission accepts direct natural artifacts without candidate custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-natural-packed-admission-'));
  try {
    const sdkSourceRoot = join(root, 'sdk-source');
    const pluginUiSourceRoot = join(root, 'plugin-ui-source');
    const cliSourceRoot = join(root, 'cli-source');
    const sdkTarballPath = join(root, 'sdk.tgz');
    const pluginUiTarballPath = join(root, 'plugin-ui.tgz');
    const cliTarballPath = join(root, 'cli.tgz');
    await Promise.all([
      mkdir(join(sdkSourceRoot, 'package'), { recursive: true }),
      mkdir(join(pluginUiSourceRoot, 'package'), { recursive: true }),
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
        join(pluginUiSourceRoot, 'package', 'package.json'),
        `${JSON.stringify({
          name: '@happier-dev/plugin-ui',
          version: '0.0.0',
          dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
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
      tar.c({ cwd: pluginUiSourceRoot, file: pluginUiTarballPath, gzip: true }, ['package']),
      tar.c({ cwd: cliSourceRoot, file: cliTarballPath, gzip: true }, ['package']),
    ]);

    const argv = [
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      sdkTarballPath,
      '--plugin-ui-tarball',
      pluginUiTarballPath,
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
    assert.equal(candidate.pluginUi.packageName, '@happier-dev/plugin-ui');
    assert.equal(candidate.pluginUi.version, '0.0.0');
    assert.equal(candidate.pluginUi.pluginSdkVersion, '0.0.0');
    assert.equal(candidate.cli.packageName, '@happier-dev/cli');
    assert.equal(candidate.cli.version, '0.2.10');
    assert.equal(candidate.cli.entrypoint, 'package/bin/happier.mjs');
    assert.equal(candidate.sdk.tarballPath, sdkTarballPath);
    assert.equal(candidate.pluginUi.tarballPath, pluginUiTarballPath);
    assert.equal(candidate.cli.tarballPath, cliTarballPath);
    assert.equal(
      candidate.sdk.integrity,
      sha512Sri(await readFile(sdkTarballPath)),
    );
    assert.equal(
      candidate.pluginUi.integrity,
      sha512Sri(await readFile(pluginUiTarballPath)),
    );
    assert.equal(
      candidate.cli.integrity,
      sha512Sri(await readFile(cliTarballPath)),
    );
    assert.equal(candidate.installers, undefined);
    await assert.rejects(
      readFile(join(root, 'candidate.json'), 'utf8'),
      /ENOENT/u,
    );
    const smokeAdmission = await loadPackedAuthorVerticalAArtifacts(argv, {
      loadCandidateManifestImpl: async () => {
        throw new Error('direct smoke mode must not claim canonical candidate admission');
      },
      loadNaturalArtifactsImpl: async () => candidate,
    });
    assert.equal(smokeAdmission.admission.kind, 'direct-artifacts-smoke');
    assert.equal(smokeAdmission.admission.runId, candidate.runId);

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
    assert.equal(directRunnerEnvelope.candidate.pluginUi.tarballPath, pluginUiTarballPath);
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
        '--plugin-ui-tarball',
        pluginUiTarballPath,
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
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord(),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord(),
  }), '/tmp/candidate.json');
  assert.equal(parsed.sdk.version, '0.0.0');
  assert.equal(parsed.cli.version, '0.2.10');
  assert.equal(parsed.sdk.tarballPath, '/tmp/sdk.tgz');
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
    pluginUi: candidatePluginUiRecord(),
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
    pluginUi: candidatePluginUiRecord({
      version: '0.1.0-vertical-a.run-17',
    }),
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
    pluginUi: candidatePluginUiRecord({
      version: '0.1.0-vertical-a.run-17',
    }),
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
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.extra.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord({
      version: '0.1.0-vertical-a.extra.run-17',
    }),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10-vertical-a.run-17',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord({
      version: '0.2.10-vertical-a.run-17',
    }),
  }), '/tmp/candidate.json'));
  assert.doesNotThrow(() => parseCandidateManifest(JSON.stringify({
    schemaVersion: 1,
    runId: 'run-17',
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-vertical-a.run-17',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord({
      version: '0.1.0-vertical-a.run-17',
    }),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10-vertical-a.run-16',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord({
      version: '0.2.10-vertical-a.run-16',
    }),
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
    pluginUi: candidatePluginUiRecord({
      version: '0.1.0-vertical-a.run-17',
    }),
    cli: {
      packageName: '@happier-dev/cli',
      version: 'release-vertical-a.run-17',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  }), '/tmp/candidate.json'), /valid package semver/u);
  const strictSemverCandidate = {
    schemaVersion: 1,
    runId: 'run-17',
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.1.0-dev.1',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord({ version: '0.1.0-dev.1' }),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10-dev.1',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord({ version: '0.2.10-dev.1' }),
  };
  for (const { packageKind, version } of [
    { packageKind: 'sdk', version: '01.1.0' },
    { packageKind: 'sdk', version: '0.1.0-dev.01' },
    { packageKind: 'sdk', version: '0.1.0-preview.1.01' },
    { packageKind: 'cli', version: '01.2.10' },
    { packageKind: 'cli', version: '0.2.10-dev.01' },
    { packageKind: 'cli', version: '0.2.10-preview.1.01' },
  ]) {
    assert.throws(
      () => parseCandidateManifest(JSON.stringify({
        ...strictSemverCandidate,
        [packageKind]: {
          ...strictSemverCandidate[packageKind],
          version,
        },
      }), '/tmp/candidate.json'),
      /valid package semver/u,
    );
  }
  assert.throws(
    () => parseCandidateManifest(JSON.stringify({
      ...strictSemverCandidate,
      pluginUi: undefined,
    }), '/tmp/candidate.json'),
    /missing pluginUi/u,
  );
  assert.throws(
    () => parseCandidateManifest(JSON.stringify({
      ...strictSemverCandidate,
      pluginUi: {
        ...strictSemverCandidate.pluginUi,
        pluginSdkVersion: '0.1.0-dev.2',
      },
    }), '/tmp/candidate.json'),
    /Plugin UI SDK dependency must equal the candidate SDK version/u,
  );
  assert.throws(
    () => parseCandidateManifest(JSON.stringify({
      ...strictSemverCandidate,
      pluginUi: {
        ...strictSemverCandidate.pluginUi,
        version: '01.1.0',
      },
    }), '/tmp/candidate.json'),
    /Plugin UI version must be a valid package semver/u,
  );
});

test('candidate manifest admission does not require or return source coordination metadata', () => {
  const candidate = {
    schemaVersion: 1,
    runId: 'run-artifact-candidate',
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord(),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord(),
  };
  const parsed = parseCandidateManifest(
    JSON.stringify(candidate),
    '/tmp/candidate.json',
  );
  assert.equal(Object.hasOwn(parsed, 'sourceBasis'), false);
});

test('candidate manifest requires exact non-swappable installer custody records', () => {
  const candidate = {
    schemaVersion: 1,
    runId: 'run-installer-custody',
    installers: candidateInstallerRecords(),
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: 'sha512-YWJj',
      tarballPath: './sdk.tgz',
    },
    pluginUi: candidatePluginUiRecord(),
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
      integrity: 'sha512-ZGVm',
      tarballPath: './cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: candidateStandaloneCliRecord(),
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
      installers,
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        integrity: 'sha512-YWJj',
        tarballPath: './sdk.tgz',
      },
      pluginUi: candidatePluginUiRecord(),
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-ZGVm',
        tarballPath: './cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: candidateStandaloneCliRecord({ root: join(root, 'native') }),
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

test('public authoring hosted web proof accepts only the emitted review-web graph bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-authoring-hosted-web-'));
  try {
    const artifactRoot = join(root, 'dist', 'happier-plugin-ui');
    const entryPath = 'hosted-web/review-web/entry.mjs';
    const stylePath = 'hosted-web/review-web/style.css';
    const entryBytes = Buffer.from('export const reviewWeb = true;\n');
    const styleBytes = Buffer.from('.review-web { color: blue; }\n');
    const files = [
      { relativePath: entryPath, bytes: entryBytes },
      { relativePath: stylePath, bytes: styleBytes },
    ];
    const graphDigest = computePluginUiArtifactFileSetSha256DigestV1(files);
    const artifactFiles = files.map(({ relativePath, bytes }) => ({
      relativePath,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteSize: bytes.byteLength,
    }));
    await mkdir(dirname(join(artifactRoot, entryPath)), { recursive: true });
    await Promise.all([
      writeFile(join(artifactRoot, entryPath), entryBytes),
      writeFile(join(artifactRoot, stylePath), styleBytes),
    ]);
    await writeFile(join(artifactRoot, 'ui-artifacts.json'), `${JSON.stringify({
      version: 1,
      entries: [{
        contributionId: 'review-web',
        tier: 'hostedWeb',
        platform: 'web',
        entry: entryPath,
        files: artifactFiles,
        digest: graphDigest,
        builtWith: { bundler: 'vite', version: '7.3.1' },
        hostUiApiVersion: '1.0.0',
        compat: {},
      }],
    })}\n`);

    await assert.doesNotReject(
      attestPackedPublicAuthoringHostedWebGraph({ artifactRoot }),
    );
    await writeFile(join(artifactRoot, stylePath), 'tampered\n');
    await assert.rejects(
      attestPackedPublicAuthoringHostedWebGraph({ artifactRoot }),
      /public authoring hostedWeb file digest mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed scaffold artifact proof requires the exact React Native platform graph and hosted-web graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-scaffold-ui-graph-'));
  try {
    const reactNativeArtifactRoot = join(root, 'react-native', 'dist', 'happier-plugin-ui');
    const hostedWebArtifactRoot = join(root, 'hosted-web', 'dist', 'happier-plugin-ui');
    const reactNativeEntries = [
      { platform: 'web', relativePath: 'react-native/main-renderer/web.js' },
      { platform: 'ios', relativePath: 'react-native/main-renderer/ios.js' },
      { platform: 'android', relativePath: 'react-native/main-renderer/android.js' },
    ];
    const createEntry = async ({ tier, platform, relativePath }) => {
      const artifactRoot = tier === 'reactNative'
        ? reactNativeArtifactRoot
        : hostedWebArtifactRoot;
      const bytes = Buffer.from(`${tier}:${platform}\n`);
      await mkdir(dirname(join(artifactRoot, relativePath)), { recursive: true });
      await writeFile(join(artifactRoot, relativePath), bytes);
      return {
        contributionId: 'main-renderer',
        tier,
        platform,
        entry: relativePath,
        files: [{
          relativePath,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          byteSize: bytes.byteLength,
        }],
        digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]),
        builtWith: { bundler: platform === 'web' ? 'vite' : 'repack', version: '7.3.1' },
        ...(tier === 'reactNative' && platform !== 'web' ? {
          repack: {
            containerName: 'happier_plugin_main_renderer',
            modulePath: './renderSurface',
            exportName: 'renderSurface',
          },
        } : {}),
        hostUiApiVersion: '1.0.0',
        compat: tier === 'hostedWeb'
          ? {}
          : { react: '19.2.0', reactNative: '0.83.4' },
      };
    };
    const nativeManifestEntries = await Promise.all(reactNativeEntries.map(async ({ platform, relativePath }) => (
      await createEntry({ tier: 'reactNative', platform, relativePath })
    )));
    const hostedManifestEntry = await createEntry({
      tier: 'hostedWeb',
      platform: 'web',
      relativePath: 'hosted-web/main-renderer/index.html',
    });
    await Promise.all([
      writeFile(join(reactNativeArtifactRoot, 'ui-artifacts.json'), `${JSON.stringify({
        version: 1,
        entries: nativeManifestEntries,
      })}\n`),
      writeFile(join(hostedWebArtifactRoot, 'ui-artifacts.json'), `${JSON.stringify({
        version: 1,
        entries: [hostedManifestEntry],
      })}\n`),
    ]);

    assert.equal(typeof packedAuthorHarness.attestPackedScaffoldUiArtifactGraph, 'function');
    const reactNativeGraph = await packedAuthorHarness.attestPackedScaffoldUiArtifactGraph({
      artifactRoot: reactNativeArtifactRoot,
      ui: 'reactNative',
    });
    assert.deepEqual(
      reactNativeGraph.entries.map(({ tier, platform }) => ({ tier, platform })),
      [
        { tier: 'reactNative', platform: 'web' },
        { tier: 'reactNative', platform: 'ios' },
        { tier: 'reactNative', platform: 'android' },
      ],
    );
    const hostedWebGraph = await packedAuthorHarness.attestPackedScaffoldUiArtifactGraph({
      artifactRoot: hostedWebArtifactRoot,
      ui: 'hostedWeb',
    });
    assert.deepEqual(
      hostedWebGraph.entries.map(({ tier, platform }) => ({ tier, platform })),
      [{ tier: 'hostedWeb', platform: 'web' }],
    );
    assert.deepEqual(
      await packedAuthorHarness.attestPackedScaffoldUiArtifactGraph({
        artifactRoot: join(root, 'no-ui', 'dist', 'happier-plugin-ui'),
        ui: undefined,
      }),
      { mode: 'no-ui', entries: [] },
    );

    await writeFile(join(reactNativeArtifactRoot, reactNativeEntries[2].relativePath), 'tampered\n');
    await assert.rejects(
      packedAuthorHarness.attestPackedScaffoldUiArtifactGraph({
        artifactRoot: reactNativeArtifactRoot,
        ui: 'reactNative',
      }),
      /packed React Native scaffold file digest mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public authoring toolchain packet is bound to exact packed SDK/UI/CLI provenance only', () => {
  const candidate = {
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.3.1',
      integrity: 'sha512-sdk-candidate',
    },
    pluginUi: {
      packageName: '@happier-dev/plugin-ui',
      version: '0.3.2',
      pluginSdkVersion: '0.3.1',
      integrity: 'sha512-plugin-ui-candidate',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.9.4',
      integrity: 'sha512-cli-candidate',
    },
  };
  const packet = {
    schemaVersion: 1,
    host: {
      buildIdentity: '@happier-dev/cli@0.9.4',
    },
    pluginSdk: { version: '0.3.1' },
    pluginUi: { version: '0.3.2', pluginSdkVersion: '0.3.1' },
  };
  assert.equal(
    typeof packedAuthorHarness.assertPackedPublicToolchainCompatibilityCandidate,
    'function',
  );
  assert.equal(
    packedAuthorHarness.assertPackedPublicToolchainCompatibilityCandidate({
      packet,
      candidate,
    }),
    packet,
  );
  assert.throws(
    () => packedAuthorHarness.assertPackedPublicToolchainCompatibilityCandidate({
      packet: {
        ...packet,
        pluginUi: { ...packet.pluginUi, version: '0.3.3' },
      },
      candidate,
    }),
    /Plugin UI/u,
  );
  assert.throws(
    () => packedAuthorHarness.assertPackedPublicToolchainCompatibilityCandidate({
      packet: {
        ...packet,
        host: { ...packet.host, buildIdentity: '@happier-dev/cli@0.9.5' },
      },
      candidate,
    }),
    /CLI/u,
  );
});

test('candidate artifact capture keeps verified package bytes private after source mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-private-capture-'));
  try {
    const sdkBytes = Buffer.from('verified-sdk');
    const pluginUiBytes = Buffer.from('verified-plugin-ui');
    const cliBytes = Buffer.from('verified-cli');
    const sdkPath = join(root, 'sdk.tgz');
    const pluginUiPath = join(root, 'plugin-ui.tgz');
    const cliPath = join(root, 'cli.tgz');
    const manifestPath = join(root, 'candidate.json');
    await Promise.all([
      writeFile(sdkPath, sdkBytes),
      writeFile(pluginUiPath, pluginUiBytes),
      writeFile(cliPath, cliBytes),
      writeFile(manifestPath, '{}'),
    ]);
    const candidate = {
      schemaVersion: 1,
      runId: 'private-capture',
      installers: candidateInstallerRecords(join(root, 'installers')),
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        integrity: sha512Sri(sdkBytes),
        tarballPath: sdkPath,
      },
      pluginUi: {
        ...candidatePluginUiRecord({ root }),
        integrity: sha512Sri(pluginUiBytes),
        tarballPath: pluginUiPath,
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: sha512Sri(cliBytes),
        tarballPath: cliPath,
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: candidateStandaloneCliRecord({ root: join(root, 'native') }),
    };
    const captured = await capturePackedAuthorCandidateArtifacts(candidate, {
      manifestPath,
      destinationParent: root,
      selection: { packages: ['sdk', 'pluginUi', 'cli'] },
    });

    await Promise.all([
      writeFile(sdkPath, 'mutated-sdk'),
      writeFile(pluginUiPath, 'mutated-plugin-ui'),
      writeFile(cliPath, 'mutated-cli'),
    ]);
    assert.notEqual(captured.candidate.sdk.tarballPath, sdkPath);
    assert.notEqual(captured.candidate.pluginUi.tarballPath, pluginUiPath);
    assert.notEqual(captured.candidate.cli.tarballPath, cliPath);
    assert.deepEqual(await readFile(captured.candidate.sdk.tarballPath), sdkBytes);
    assert.deepEqual(await readFile(captured.candidate.pluginUi.tarballPath), pluginUiBytes);
    assert.deepEqual(await readFile(captured.candidate.cli.tarballPath), cliBytes);
    if (process.platform !== 'win32') {
      assert.equal((await stat(captured.root)).mode & 0o777, 0o700);
      assert.equal((await stat(captured.candidate.sdk.tarballPath)).mode & 0o777, 0o600);
    }
    assert.equal(captured.manifestPath, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('complete candidate capture rewrites and reloads every real filesystem artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-complete-private-capture-'));
  try {
    const sourceRoot = join(root, 'source');
    const packagesRoot = join(sourceRoot, 'packages');
    const installersRoot = join(sourceRoot, 'installers');
    const nativeRoot = join(sourceRoot, 'native');
    await Promise.all([
      mkdir(packagesRoot, { recursive: true }),
      mkdir(installersRoot, { recursive: true }),
      mkdir(nativeRoot, { recursive: true }),
    ]);
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const version = '1.2.3';
    const sdkBytes = Buffer.from('complete-sdk');
    const pluginUiBytes = Buffer.from('complete-plugin-ui');
    const cliBytes = Buffer.from('complete-cli');
    const sdkPath = join(packagesRoot, 'sdk.tgz');
    const pluginUiPath = join(packagesRoot, 'plugin-ui.tgz');
    const cliPath = join(packagesRoot, 'cli.tgz');
    const installerInputs = [
      ['shell', 'shell', 'install-dev.sh', Buffer.from('shell-installer')],
      ['powershell', 'powershell', 'install-dev.ps1', Buffer.from('powershell-installer')],
      ['publicKey', 'minisign-public-key', 'happier-release.pub', Buffer.from('public-key')],
    ];
    const archiveInputs = PACKED_AUTHOR_NATIVE_TARGETS.map((target, index) => {
      const [os, arch] = target.split('-');
      const fileName = `happier-v${version}-${target}.tar.gz`;
      return { os, arch, fileName, bytes: Buffer.from(`archive-${index}-${target}`) };
    });
    const evidenceInputs = ['darwin-x64', 'darwin-arm64'].map((target, index) => ({
      target,
      fileName: `${target}.cli.json`,
      bytes: Buffer.from(`notarization-${index}-${target}`),
    }));
    const checksumBytes = Buffer.from([
      ...archiveInputs.map(({ fileName, bytes }) => `${sha256(bytes)}  ${fileName}`),
      ...evidenceInputs.map(({ fileName, bytes }) => `${sha256(bytes)}  ${fileName}`),
      '',
    ].join('\n'));
    const signatureBytes = Buffer.from('test-minisign-signature\n');
    await Promise.all([
      writeFile(sdkPath, sdkBytes),
      writeFile(pluginUiPath, pluginUiBytes),
      writeFile(cliPath, cliBytes),
      ...installerInputs.map(([, , fileName, bytes]) => (
        writeFile(join(installersRoot, fileName), bytes)
      )),
      ...archiveInputs.map(({ fileName, bytes }) => writeFile(join(nativeRoot, fileName), bytes)),
      ...evidenceInputs.map(({ fileName, bytes }) => writeFile(join(nativeRoot, fileName), bytes)),
      writeFile(join(nativeRoot, `checksums-happier-v${version}.txt`), checksumBytes),
      writeFile(join(nativeRoot, `checksums-happier-v${version}.txt.minisig`), signatureBytes),
    ]);
    const installers = Object.fromEntries(installerInputs.map(([field, kind, fileName, bytes]) => [
      field,
      {
        kind,
        fileName,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        filePath: join(installersRoot, fileName),
      },
    ]));
    const archives = archiveInputs.map(({ os, arch, fileName, bytes }) => ({
      product: 'happier',
      version,
      os,
      arch,
      sha256: sha256(bytes),
      archivePath: join(nativeRoot, fileName),
    }));
    const candidate = {
      schemaVersion: 1,
      runId: 'complete-private-capture',
      installers: { releaseChannel: 'dev', ...installers },
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.1.0',
        integrity: sha512Sri(sdkBytes),
        tarballPath: sdkPath,
      },
      pluginUi: {
        ...candidatePluginUiRecord({ version: '0.1.0', root: packagesRoot }),
        integrity: sha512Sri(pluginUiBytes),
        tarballPath: pluginUiPath,
      },
      cli: {
        packageName: '@happier-dev/cli',
        version,
        integrity: sha512Sri(cliBytes),
        tarballPath: cliPath,
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: {
        ...archives[0],
        archives,
        checksums: {
          kind: 'sha256-checksums',
          fileName: `checksums-happier-v${version}.txt`,
          sizeBytes: checksumBytes.length,
          sha256: sha256(checksumBytes),
          filePath: join(nativeRoot, `checksums-happier-v${version}.txt`),
        },
        signature: {
          kind: 'minisign-signature',
          fileName: `checksums-happier-v${version}.txt.minisig`,
          sizeBytes: signatureBytes.length,
          sha256: sha256(signatureBytes),
          filePath: join(nativeRoot, `checksums-happier-v${version}.txt.minisig`),
        },
        notarization: evidenceInputs.map(({ target, fileName, bytes }) => ({
          target,
          evidence: {
            kind: 'apple-notarization-evidence',
            fileName,
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            filePath: join(nativeRoot, fileName),
          },
        })),
      },
    };
    const sourceManifestPath = join(sourceRoot, 'candidate.json');
    await writeFile(sourceManifestPath, `${JSON.stringify(candidate, null, 2)}\n`);
    const sourceCandidate = await loadPackedAuthorCandidateManifest([
      '--candidate',
      sourceManifestPath,
    ], { verifyMinisignImpl: () => true });
    const captured = await capturePackedAuthorCandidateArtifacts(sourceCandidate, {
      manifestPath: sourceManifestPath,
      destinationParent: root,
      selection: 'all',
      writeManifest: true,
    });
    assert.ok(captured.manifestPath);
    const reloaded = await loadPackedAuthorCandidateManifest([
      '--candidate',
      captured.manifestPath,
    ], { verifyMinisignImpl: () => true });
    const sourcePaths = [
      sourceCandidate.sdk.tarballPath,
      sourceCandidate.pluginUi.tarballPath,
      sourceCandidate.cli.tarballPath,
      sourceCandidate.installers.shell.filePath,
      sourceCandidate.installers.powershell.filePath,
      sourceCandidate.installers.publicKey.filePath,
      ...sourceCandidate.standaloneCli.archives.map(({ archivePath }) => archivePath),
      sourceCandidate.standaloneCli.checksums.filePath,
      sourceCandidate.standaloneCli.signature.filePath,
      ...sourceCandidate.standaloneCli.notarization.map(({ evidence }) => evidence.filePath),
    ];
    const reloadedPaths = [
      reloaded.sdk.tarballPath,
      reloaded.pluginUi.tarballPath,
      reloaded.cli.tarballPath,
      reloaded.installers.shell.filePath,
      reloaded.installers.powershell.filePath,
      reloaded.installers.publicKey.filePath,
      ...reloaded.standaloneCli.archives.map(({ archivePath }) => archivePath),
      reloaded.standaloneCli.checksums.filePath,
      reloaded.standaloneCli.signature.filePath,
      ...reloaded.standaloneCli.notarization.map(({ evidence }) => evidence.filePath),
    ];
    assert.equal(reloaded.standaloneCli.archives.length, 5);
    assert.equal(reloaded.standaloneCli.notarization.length, 2);
    for (let index = 0; index < reloadedPaths.length; index += 1) {
      assert.notEqual(reloadedPaths[index], sourcePaths[index]);
      const relativeCapturePath = relative(captured.root, reloadedPaths[index]);
      assert.notEqual(relativeCapturePath, '..');
      assert.equal(relativeCapturePath.startsWith(`..${sep}`), false);
      assert.equal(isAbsolute(relativeCapturePath), false);
      await access(reloadedPaths[index]);
    }
    if (process.platform !== 'win32') {
      assert.equal((await stat(captured.root)).mode & 0o777, 0o700);
      assert.equal((await stat(captured.manifestPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate capture removes its real root when post-mkdtemp setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-capture-setup-failure-'));
  try {
    const sdkBytes = Buffer.from('setup-failure-sdk');
    const sdkPath = join(root, 'sdk.tgz');
    await writeFile(sdkPath, sdkBytes);
    const candidate = {
      schemaVersion: 1,
      runId: 'setup-failure',
      installers: candidateInstallerRecords(join(root, 'installers')),
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.1.0',
        integrity: sha512Sri(sdkBytes),
        tarballPath: sdkPath,
      },
      pluginUi: candidatePluginUiRecord({ version: '0.1.0', root }),
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: sha512Sri(Buffer.from('unused-cli')),
        tarballPath: join(root, 'cli.tgz'),
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: candidateStandaloneCliRecord({ root: join(root, 'native') }),
    };
    if (process.platform !== 'win32') {
      await assert.rejects(
        capturePackedAuthorCandidateArtifacts(candidate, {
          manifestPath: join(root, 'candidate.json'),
          destinationParent: root,
          selection: { packages: ['sdk'] },
          chmodImpl: async () => {
            throw new Error('chmod setup failed');
          },
        }),
        /chmod setup failed/u,
      );
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.startsWith('verified-candidate-')),
        [],
      );
    }
    await assert.rejects(
      capturePackedAuthorCandidateArtifacts(candidate, {
        manifestPath: join(root, 'candidate.json'),
        destinationParent: root,
        selection: { installers: ['unknown-installer'] },
      }),
      /Unknown candidate installer artifact selection/u,
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('verified-candidate-')),
      [],
    );
    if (process.platform !== 'win32') {
      const transientRoot = join(root, 'transient-cleanup-failure');
      let transientCleanupAttempts = 0;
      await assert.rejects(
        capturePackedAuthorCandidateArtifacts(candidate, {
          manifestPath: join(root, 'candidate.json'),
          destinationParent: transientRoot,
          selection: { packages: ['sdk'] },
          chmodImpl: async () => {
            throw new Error('transient capture setup failed');
          },
          rmImpl: async (path, options) => {
            transientCleanupAttempts += 1;
            if (transientCleanupAttempts === 1) {
              throw new Error('transient capture cleanup failed');
            }
            await rm(path, options);
          },
        }),
        /transient capture setup failed/u,
      );
      assert.equal(transientCleanupAttempts, 2);
      assert.deepEqual(
        (await readdir(transientRoot))
          .filter((name) => name.startsWith('verified-candidate-')),
        [],
      );
      const aggregateRoot = join(root, 'aggregate-cleanup-failure');
      let permanentCleanupAttempts = 0;
      await assert.rejects(
        capturePackedAuthorCandidateArtifacts(candidate, {
          manifestPath: join(root, 'candidate.json'),
          destinationParent: aggregateRoot,
          selection: { packages: ['sdk'] },
          chmodImpl: async () => {
            throw new Error('capture setup failed');
          },
          rmImpl: async () => {
            permanentCleanupAttempts += 1;
            throw new Error(`capture cleanup failed ${permanentCleanupAttempts}`);
          },
        }),
        (error) => {
          assert.equal(error instanceof AggregateError, true);
          assert.deepEqual(
            error.errors.map((entry) => entry.message),
            ['capture setup failed', 'capture cleanup failed 1', 'capture cleanup failed 2'],
          );
          return true;
        },
      );
      assert.equal(permanentCleanupAttempts, 2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate capture cleanup is single-flight and retries after a transient removal failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-capture-cleanup-retry-'));
  try {
    const sdkBytes = Buffer.from('cleanup-retry-sdk');
    const sdkPath = join(root, 'sdk.tgz');
    await writeFile(sdkPath, sdkBytes);
    const candidate = {
      schemaVersion: 1,
      runId: 'cleanup-retry',
      installers: candidateInstallerRecords(join(root, 'installers')),
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.1.0',
        integrity: sha512Sri(sdkBytes),
        tarballPath: sdkPath,
      },
      pluginUi: candidatePluginUiRecord({ version: '0.1.0', root }),
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: sha512Sri(Buffer.from('unused-cli')),
        tarballPath: join(root, 'cli.tgz'),
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: candidateStandaloneCliRecord({ root: join(root, 'native') }),
    };
    let removeAttempts = 0;
    const captured = await capturePackedAuthorCandidateArtifacts(candidate, {
      manifestPath: join(root, 'candidate.json'),
      destinationParent: root,
      selection: { packages: ['sdk'] },
      rmImpl: async (path, options) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error('transient capture cleanup failure');
        await rm(path, options);
      },
    });
    const firstCleanup = captured.cleanup();
    const concurrentCleanup = captured.cleanup();
    assert.equal(firstCleanup, concurrentCleanup);
    await assert.rejects(firstCleanup, /transient capture cleanup failure/u);
    const successfulCleanup = captured.cleanup();
    await successfulCleanup;
    assert.equal(captured.cleanup(), successfulCleanup);
    assert.equal(removeAttempts, 2);
    await assert.rejects(access(captured.root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold inspection rejects repository links, bare tools, and TypeScript 5', () => {
  assert.deepEqual(inspectGeneratedScaffoldPackage({
    scripts: {
      build: 'happier plugins dev build .',
      typecheck: 'happier plugins dev typecheck .',
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
      build: 'happier plugins dev build .',
      typecheck: 'happier plugins dev typecheck .',
      test: 'happier plugins test .',
      'pack:plugin': 'happier plugins pack .',
    },
    dependencies: { '@happier-dev/plugin-sdk': '0.1.0-vertical-a.run-17' },
    devDependencies: { '@typescript/native': 'npm:typescript@7.x' },
  }, '0.1.0-vertical-a.run-17');
  assert.ok(compilerDriftFailures.some((message) => message.includes('exact repository-selected')));
});

test('packed author inventory preserves untouched no-UI, React Native, and hosted-web scaffold roots', () => {
  const specs = packedAuthorHarness.createPackedAuthorScaffoldSpecs('/fixture-root');
  const untouched = specs.filter((spec) => spec.mode === 'untouched');

  assert.deepEqual(
    untouched.map(({ pluginId, root, ui }) => ({ pluginId, root, ui })),
    [
      {
        pluginId: 'acme.scaffold.no-ui',
        root: '/fixture-root/untouched-no-ui-plugin',
        ui: undefined,
      },
      {
        pluginId: 'acme.scaffold.react-native',
        root: '/fixture-root/untouched-react-native-plugin',
        ui: 'reactNative',
      },
      {
        pluginId: 'acme.scaffold.hosted-web',
        root: '/fixture-root/untouched-hosted-web-plugin',
        ui: 'hostedWeb',
      },
    ],
  );
  assert.deepEqual(
    packedAuthorHarness.configuredPackedAuthorScaffoldSpecs(specs).map(({ pluginId }) => pluginId),
    [
      'acme.vertical-a',
      'acme.private-registry',
      'acme.public-registry',
      'acme.descriptor-only',
    ],
  );
  assert.ok(specs.some((spec) => spec.pluginId === 'acme.vertical-a' && spec.mode === 'configured'));
});

test('vertical-a fixture configuration keeps its author test aligned with the roundtrip registration', async () => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-vertical-a-configure-'));
  try {
    await Promise.all([
      mkdir(join(pluginRoot, 'src'), { recursive: true }),
      mkdir(join(pluginRoot, 'src', 'ui'), { recursive: true }),
      mkdir(join(pluginRoot, 'test'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'vertical-a-plugin',
        version: '0.0.0',
        files: ['.happier-plugin', 'dist'],
      }), 'utf8'),
      // The generated scaffold is code-defined: its manifest lives inside
      // `definePlugin(...)` and no `.happier-plugin/plugin.json` exists.
      writeFile(join(pluginRoot, 'src', 'index.ts'), [
        "import { definePlugin, defineUiSurfaceDefinition } from '@happier-dev/plugin-sdk';",
        "import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';",
        '',
        'export const mainSurface = defineUiSurfaceDefinition({',
        "  id: 'main',",
        "  placement: 'appPage',",
        "  title: 'Vertical A',",
        "  renderer: { kind: 'hostedWeb', requiredHostMethods: ['context', 'executeAction'] },",
        "  build: { entry: 'src/ui/index.ts' },",
        '});',
        '',
        'export const { manifest, activate } = definePlugin({',
        "  id: 'acme.vertical-a',",
        "  version: '0.1.0',",
        "  displayName: 'Vertical A',",
        "  description: 'Local Happier plugin scaffold for Vertical A.',",
        '  runtime: { apiVersion: 1 },',
        "  entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },",
        '  actions: {',
        "    'save-note': {",
        "      title: 'Save note',",
        "      execution: { target: 'daemon' },",
        "      inputSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),",
        '      async run(input) {',
        '        return { note: input.note };',
        '      },',
        '    },',
        '  },',
        '  ui: {',
        '    surfaces: [mainSurface],',
        '    translations: [],',
        '  },',
        '});',
        '',
      ].join('\n'), 'utf8'),
      writeFile(join(pluginRoot, 'test', 'index.test.mjs'), "invokeAction('save-note');\n", 'utf8'),
    ]);

    await configureVerticalAPlugin({
      pluginRoot,
      sdkPackageRoot: resolve(import.meta.dirname, '../../../plugin-sdk'),
      pluginId: 'acme.vertical-a',
      version: '1.0.0',
      fetchOrigin: 'http://127.0.0.1:43123',
      connectedAccountOrigin: 'https://127.0.0.1:43124',
    });

    const configuredTest = await readFile(join(pluginRoot, 'test', 'index.test.mjs'), 'utf8');
    const configuredSource = await readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8');
    const configuredManifestLiteralStart = configuredSource.indexOf('export const manifest = ');
    const configuredManifestLiteralEnd = configuredSource.indexOf('\n\nconst pluginVersion =');
    assert.ok(
      configuredManifestLiteralStart >= 0 && configuredManifestLiteralEnd > configuredManifestLiteralStart,
      'configured fixture must author its canonical manifest in the module',
    );
    const configuredManifestLiteral = configuredSource.slice(
      configuredManifestLiteralStart,
      configuredManifestLiteralEnd,
    );
    assert.doesNotMatch(
      configuredManifestLiteral,
      /"engines"/u,
      'the packed external fixture must not retain a synthesized engines.happier declaration',
    );
    // The manifest declaration carries authored prose such as host-access
    // reasons; the code-vocabulary assertions below target the fixture's own
    // runtime code, which is what must not reach for host internals.
    const configuredCode = configuredSource.replace(configuredManifestLiteral, '');
    const configuredPackage = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
    const configuredUiBuild = await readFile(join(pluginRoot, 'pluginUiBuild.mjs'), 'utf8');
    const configuredVite = await readFile(join(pluginRoot, 'vite.config.mjs'), 'utf8');
    const configuredHostedWeb = await readFile(join(pluginRoot, 'src', 'ui', 'index.ts'), 'utf8');
    assert.match(configuredTest, /registrations\(\)/u);
    assert.match(configuredTest, /localId === 'roundtrip'/u);
    assert.doesNotMatch(configuredTest, /family === 'requestInterceptors'/u);
    assert.doesNotMatch(configuredTest, /localId === 'observe-api'/u);
    assert.match(configuredTest, /family === 'agents'/u);
    assert.match(configuredTest, /localId === 'packed-external-agent'/u);
    assert.match(configuredTest, /family === 'connectedAccountDescriptors'/u);
    assert.match(configuredTest, /localId === 'novel-cloud'/u);
    assert.match(configuredTest, /plugin\.registration\('providers', 'packed-managed-provider'\)/u);
    for (const reason of ['explicitStartLocal', 'catalogProbe', 'sessionDemand']) {
      assert.ok(configuredTest.includes(`reason: '${reason}'`));
    }
    const healthySnapshotFixture = configuredTest.match(/const healthySnapshot = \{[^\n]+\};/u)?.[0];
    assert.ok(healthySnapshotFixture, 'configured fixture must define its managed-service snapshot');
    assert.match(healthySnapshotFixture, /baseUrl: ["']http:\/\/127\.0\.0\.1:43123["']/u);
    assert.doesNotMatch(healthySnapshotFixture, /\bhost\s*:/u);
    assert.doesNotMatch(healthySnapshotFixture, /\bport\s*:/u);
    assert.match(configuredTest, /Object\.hasOwn\(healthySnapshot, 'host'\), false/u);
    assert.match(configuredTest, /Object\.hasOwn\(healthySnapshot, 'port'\), false/u);
    assert.doesNotMatch(configuredSource, /api\.interceptors\.register\(/u);
    assert.match(configuredSource, /context\.services\.events\.plugin\.emit\('notification-ready'/u);
    assert.doesNotMatch(configuredSource, /context\.services\.events\.emit\(/u);
    assert.match(
      configuredSource,
      /context\.services\.settings\.forScope\(\{ kind: 'account' \}\)\.get\('webhook\.endpoint'\)/u,
    );
    assert.doesNotMatch(configuredSource, /context\.services\.settings\.get\(/u);
    assert.match(configuredSource, /context\.services\.secrets\.get\('webhook\.token'/u);
    assert.match(configuredSource, /api\.providers\.register\('packed-managed-provider', packedManagedProviderRuntime\)/u);
    assert.match(configuredSource, /ManagedProviderRuntime/u);
    assert.match(configuredSource, /ManagedServiceSpec/u);
    assert.match(configuredSource, /context\.managedServices\.supervise\(/u);
    assert.doesNotMatch(
      configuredSource,
      /managedRuntimeAdapter|MANAGED_PROVIDER_IMPLEMENTATION|\/src\/managed|plugin-sdk\/internal|experimental\/cloud\/request-auth/u,
    );
    assert.doesNotMatch(configuredCode, /provenance|first_party|bundled/u);
    assert.match(configuredSource, /api\.agents\.registerExternalSessions\('packed-external-agent'/u);
    assert.match(configuredSource, /api\.agents\.registerExternalSessionObservation\('packed-external-agent'/u);
    assert.match(configuredSource, /context\.services\.sessions\.external\.capabilities\(\)/u);
    assert.match(configuredSource, /context\.services\.sessions\.external\.list\(/u);
    assert.match(configuredSource, /context\.services\.sessions\.external\.attach\(/u);
    assert.match(configuredSource, /context\.services\.sessions\.external\.readTranscript\(/u);
    assert.match(configuredSource, /context\.services\.sessions\.external\.followTranscript\(/u);
    assert.match(configuredSource, /followed\.subscription\.dispose\(\)/u);
    assert.match(configuredSource, /context\.services\.sessions\.external\.takeover\(/u);
    assert.match(
      configuredSource,
      /context\.services\.actions\.execute\('sessions\.external\.operation\.status\.get'/u,
    );
    assert.match(
      configuredSource,
      /context\.services\.actions\.execute\('sessions\.external\.operation\.resume'/u,
    );
    assert.match(
      configuredSource,
      /import type \{ AgentExternalSessionHooksContribution, AgentExternalSessionObservationContribution, AgentExternalSessionsContribution \} from '@happier-dev\/plugin-sdk\/sessions\/external';/u,
    );
    assert.match(
      configuredSource,
      /import \{ readCurrentHostingProviderRuntimeServices \} from '@happier-dev\/plugin-sdk\/scm\/hosting';/u,
    );
    assert.match(
      configuredSource,
      /import type \{ HostingProviderRuntimeAdapter \} from '@happier-dev\/plugin-sdk\/scm\/hosting';/u,
    );
    assert.match(configuredSource, /import type \{ ActionHandler \} from '@happier-dev\/plugin-sdk\/actions';/u);
    assert.match(
      configuredSource,
      /import type \{ ConnectedAccountAuthenticationContext, ConnectedAccountRuntime \} from '@happier-dev\/plugin-sdk\/connected-accounts';/u,
    );
    assert.match(
      configuredSource,
      /import type \{ ManagedServiceSpec \} from '@happier-dev\/plugin-sdk\/managed-services';/u,
    );
    assert.match(
      configuredSource,
      /import type \{ ManagedProviderRuntime \} from '@happier-dev\/plugin-sdk\/providers';/u,
    );
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
    // Code-defined authoring: the configured fixture exposes its canonical
    // manifest from the module and never checks in `.happier-plugin/plugin.json`.
    assert.match(configuredSource, /^export const manifest = \{$/mu);
    const configuredManifest = JSON.parse(
      configuredManifestLiteral
        .slice('export const manifest = '.length)
        .replace(/;$/u, ''),
    );
    assert.equal(configuredManifest.id, 'acme.vertical-a');
    assert.equal(configuredManifest.version, '1.0.0');
    assert.equal(configuredManifest.entrypoints.development, './src/index.ts');
    assert.ok(configuredManifest.contributes.actions.some(({ id }) => id === 'roundtrip'));
    assert.ok(configuredManifest.contributes.ui.renderers.some(({ id, kind }) => (
      id === 'main-renderer' && kind === 'hostedWeb'
    )));
    assert.deepEqual(configuredManifest.contributes.ui.views, [{
      id: 'main',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'main-renderer',
      title: 'Vertical A',
    }]);
    assert.equal(configuredPackage.files.includes('.happier-plugin'), false);
    assert.ok(configuredPackage.files.includes('resources'));
    await assert.rejects(access(join(pluginRoot, '.happier-plugin', 'plugin.json')));
    assert.doesNotMatch(configuredTest, /\.happier-plugin\/plugin\.json/u);
    assert.match(configuredTest, /const \{ manifest \} = module;/u);
    assert.match(configuredUiBuild, /import \{ defineBuildConfig \} from '@happier-dev\/plugin-sdk\/ui\/build'/u);
    assert.match(configuredUiBuild, /rendererId: ["']main-renderer["']/u);
    assert.match(configuredUiBuild, /entry: 'src\/ui\/index\.ts'/u);
    assert.match(configuredUiBuild, /kind: 'hostedWeb'/u);
    assert.match(configuredVite, /dist\/ui\/hosted-web\/main-renderer/u);
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
    const packedHarnessDeclaration = await readFile(
      new URL('./run-packed-author-ui-compat.d.mts', import.meta.url),
      'utf8',
    );
    assert.match(
      packedRunnerSource,
      /RPC_METHODS\.DAEMON_EXTERNAL_SESSION_STATUS_GET/u,
    );
    // CSF-L5 removes the live generic structured-message resolver. The packed
    // author proof retains the canonical snapshot Action dispatcher, but must
    // never preserve the retired resolver as a second replay path.
    assert.doesNotMatch(
      packedRunnerSource,
      /DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE/u,
    );
    assert.match(
      packedRunnerSource,
      /RPC_METHODS\.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE/u,
    );
    assert.doesNotMatch(
      packedHarnessSource,
      /structuredResolution/u,
    );
    assert.doesNotMatch(
      packedHarnessDeclaration,
      /structuredResolution/u,
    );
    assert.match(
      packedHarnessSource,
      /structuredAction\?\.ok !== true/u,
    );
    assert.match(
      packedHarnessSource,
      /structuredAction\?\.ok !== false/u,
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
    assert.match(
      packedHarnessSource,
      /input:\s*\{ operation: 'external-sessions-public' \}/u,
    );
    assert.match(
      packedHarnessSource,
      /publicExternalSessions\.status\?\.ok !== true/u,
    );
    assert.match(
      packedHarnessSource,
      /publicExternalSessions\.recovery\?\.ok !== true/u,
    );
    assert.match(
      packedHarnessSource,
      /'external-public-follow-disposed'/u,
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
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [{ family: 'actions', count: 1 }],
    requestInterceptors: [],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    rawCredentialAccess: [{
      accessMode: 'raw',
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlot: {
        id: 'voice_auth',
        title: 'Voice credential',
        purpose: 'voice.client-auth',
      },
      sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
      realm: 'web',
      phase: 'connection',
      request: {
        kind: 'httpHeaders',
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      },
    }],
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
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [{ family: 'actions', count: 1 }],
    requestInterceptors: [],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    rawCredentialAccess: [],
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
    packages: [{
      ...sdk,
      bytes: sdkBytes,
      packageManifest: {
        dependencies: { '@types/node': '>=20' },
        bundledDependencies: ['@happier-dev/agents', '@happier-dev/protocol'],
      },
    }],
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

test('candidate registry serves every packed author package, not only the SDK', async () => {
  const sdkBytes = Buffer.from('candidate-sdk-bytes');
  const pluginUiBytes = Buffer.from('candidate-plugin-ui-bytes');
  const sdk = {
    packageName: '@happier-dev/plugin-sdk',
    version: '0.0.0',
    integrity: sha512Sri(sdkBytes),
  };
  const pluginUi = {
    packageName: '@happier-dev/plugin-ui',
    version: '0.0.0',
    integrity: sha512Sri(pluginUiBytes),
  };
  const registry = await startCandidateRegistry({
    packages: [
      { ...sdk, bytes: sdkBytes, packageManifest: { dependencies: { zod: '4.3.6' } } },
      {
        ...pluginUi,
        bytes: pluginUiBytes,
        packageManifest: {
          dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
          peerDependencies: { react: '19.2.0' },
        },
      },
    ],
  });
  try {
    for (const [artifact, bytes, expectedDependencies] of [
      [sdk, sdkBytes, { zod: '4.3.6' }],
      [pluginUi, pluginUiBytes, { '@happier-dev/plugin-sdk': '0.0.0' }],
    ]) {
      const encodedName = encodeURIComponent(artifact.packageName);
      const metadataResponse = await fetch(`${registry.origin}/${encodedName}`);
      assert.equal(metadataResponse.status, 200, `${artifact.packageName} metadata`);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.name, artifact.packageName);
      assert.equal(metadata['dist-tags'].latest, artifact.version);
      assert.deepEqual(metadata.versions[artifact.version].dependencies, expectedDependencies);
      const tarballResponse = await fetch(metadata.versions[artifact.version].dist.tarball);
      assert.equal(tarballResponse.status, 200, `${artifact.packageName} tarball`);
      assert.equal(sha512Sri(Buffer.from(await tarballResponse.arrayBuffer())), artifact.integrity);
    }
    assert.deepEqual(
      registry.packages.map((entry) => `${entry.packageName}@${entry.version}`),
      ['@happier-dev/plugin-sdk@0.0.0', '@happier-dev/plugin-ui@0.0.0'],
    );
    assert.equal((await fetch(`${registry.origin}/@happier-dev%2Fprotocol`)).status, 404);
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
  const pluginUiSourceRoot = join(root, 'plugin-ui-source');
  const cliSourceRoot = join(root, 'cli-source');
  const sdkTarballPath = join(root, 'sdk.tgz');
  const pluginUiTarballPath = join(root, 'plugin-ui.tgz');
  const cliTarballPath = join(root, 'cli.tgz');
  let preparedHome = false;
  try {
    await Promise.all([
      mkdir(join(sdkSourceRoot, 'package'), { recursive: true }),
      mkdir(join(pluginUiSourceRoot, 'package'), { recursive: true }),
      mkdir(join(cliSourceRoot, 'package', 'bin'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sdkSourceRoot, 'package', 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      }), 'utf8'),
      writeFile(join(sdkSourceRoot, 'package', '.env'), 'SDK_TOKEN=secret\n', 'utf8'),
      writeFile(join(pluginUiSourceRoot, 'package', 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-ui',
        version: '0.0.0',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }), 'utf8'),
      writeFile(join(cliSourceRoot, 'package', 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.2.10',
        bin: { happier: './bin/happier.mjs' },
      }), 'utf8'),
      writeFile(join(cliSourceRoot, 'package', 'bin', 'happier.mjs'), 'export {};\n', 'utf8'),
    ]);
    await Promise.all([
      tar.c({ cwd: sdkSourceRoot, file: sdkTarballPath, gzip: true }, ['package']),
      tar.c({ cwd: pluginUiSourceRoot, file: pluginUiTarballPath, gzip: true }, ['package']),
      tar.c({ cwd: cliSourceRoot, file: cliTarballPath, gzip: true }, ['package']),
    ]);
    const [sdkBytes, pluginUiBytes, cliBytes] = await Promise.all([
      readFile(sdkTarballPath),
      readFile(pluginUiTarballPath),
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
        pluginUi: {
          ...candidatePluginUiRecord({ root }),
          integrity: sha512Sri(pluginUiBytes),
          tarballPath: pluginUiTarballPath,
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
        probeExternalTool: async () => ({}),
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

test('vertical-a rejects a direct candidate missing its Plugin UI archive descriptor before tarball reads', async () => {
  let preparedHome = false;
  await assert.rejects(
    runVerticalA({
      schemaVersion: 1,
      runId: 'missing-plugin-ui-archive',
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        integrity: 'sha512-YWJj',
        tarballPath: '/must-not-read/sdk.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-ZGVm',
        tarballPath: '/must-not-read/cli.tgz',
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
      probeExternalTool: async () => ({}),
      probeRetainedCapabilities: async () => ({}),
      probeConnectedAccounts: async () => ({}),
      decideInstallReview: async () => ({}),
    }),
    /Plugin UI tarball must provide a non-empty tarballPath and sha512 SRI integrity/u,
  );
  assert.equal(preparedHome, false);
});

test('vertical-a requires the composed external MCP Tool probe before candidate inspection', async () => {
  let preparedHome = false;
  await assert.rejects(
    runVerticalA({
      schemaVersion: 1,
      runId: 'missing-external-tool-probe',
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        integrity: 'sha512-YWJj',
        tarballPath: '/must-not-read/sdk.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-ZGVm',
        tarballPath: '/must-not-read/cli.tgz',
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
    /external MCP Tool probe/u,
  );
  assert.equal(preparedHome, false);
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
    pluginUi: {
      ...candidatePluginUiRecord({ root: tmpdir() }),
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      tarballPath: join(tmpdir(), `${runId}-missing-plugin-ui.tgz`),
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
    probeExternalTool: async () => ({}),
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
  const publicAuthoringArtifact = packedPublicAuthoringArtifact();
  const candidate = {
    schemaVersion: 1,
    runId: 'natural-packed-novel-handoff',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.3.1',
      integrity: 'sha512-sdk-candidate',
      tarballPath: '/candidate/sdk.tgz',
    },
    pluginUi: {
      ...candidatePluginUiRecord({ version: '0.3.1', root: '/candidate' }),
      integrity: 'sha512-plugin-ui-candidate',
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
      publicAuthoringArtifact,
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
    assert.ok(loaded.publicAuthoring);
    assert.equal(
      await readFile(loaded.publicAuthoring.archivePath, 'utf8'),
      publicAuthoringArtifact.archiveBytes.toString('utf8'),
    );
    assert.equal(
      loaded.publicAuthoring.pluginId,
      publicAuthoringArtifact.pluginId,
    );
    assert.equal(
      loaded.publicAuthoring.version,
      publicAuthoringArtifact.version,
    );
    assert.equal(
      loaded.publicAuthoring.archive.integrity,
      sha512Sri(publicAuthoringArtifact.archiveBytes),
    );
    assert.equal(
      loaded.publicAuthoring.archive.sha256,
      createHash('sha256')
        .update(publicAuthoringArtifact.archiveBytes)
        .digest('hex'),
    );
    assert.equal(
      loaded.publicAuthoring.archive.archivePath,
      loaded.publicAuthoring.archivePath,
    );
    assert.deepEqual(
      loaded.publicAuthoring.hostedWeb,
      publicAuthoringArtifact.hostedWeb,
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
      /exact SDK\/Plugin UI\/CLI candidate/u,
    );
    assert.throws(
      () => assertPackedNovelConnectedAccountQaCandidate({
        handoff: loaded,
        candidate: {
          ...candidate,
          pluginUi: {
            ...candidate.pluginUi,
            integrity: 'sha512-substituted-plugin-ui-candidate',
          },
        },
      }),
      /exact SDK\/Plugin UI\/CLI candidate/u,
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
  const publicAuthoringArtifact = packedPublicAuthoringArtifact();
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
        pluginUi: {
          ...candidatePluginUiRecord({ version: '0.3.1', root: '/candidate' }),
          integrity: 'sha512-plugin-ui-candidate',
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
      publicAuthoringArtifact,
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

    await writeFile(admitted.plugin.archivePath, archiveBytes);
    await writeFile(
      admitted.publicAuthoring.archivePath,
      'tampered public authoring archive bytes',
    );
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /public authoring archive (?:integrity|size) mismatch/u,
    );
    await writeFile(
      admitted.publicAuthoring.archivePath,
      publicAuthoringArtifact.archiveBytes,
    );

    const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'));
    manifest.publicAuthoring.pluginId = 'examples.substitute-review-assistant';
    await writeFile(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /public authoring fixture is invalid/u,
    );

    manifest.publicAuthoring.pluginId = 'examples.public-sdk-review-assistant';
    manifest.publicAuthoring.hostedWeb.entry = '../substituted-entry.mjs';
    await writeFile(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      loadPackedNovelConnectedAccountQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /public authoring hostedWeb graph is invalid/u,
    );

    manifest.publicAuthoring.hostedWeb.entry = publicAuthoringArtifact.hostedWeb.entry;
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

test('packed candidate callers do not select SDK versions through plugins create', async () => {
  const callers = [
    ['packed author', new URL('./run-packed-author-ui-compat.mjs', import.meta.url)],
    ['plugins dev', new URL('../../src/plugin-platform/runPackedPluginsDev.ts', import.meta.url)],
    ['managed provider', new URL('../../src/plugin-platform/packedManagedProviderComposedRuntime.ts', import.meta.url)],
    ['native candidate', new URL('../../src/testkit/maestro/mobilePluginPlatformCandidateCli.ts', import.meta.url)],
    ['resources browser', new URL('../../suites/ui-e2e/plugins.resourcesBrowser.candidate.spec.ts', import.meta.url)],
  ];

  for (const [caller, sourceUrl] of callers) {
    const source = await readFile(sourceUrl, 'utf8');
    assert.doesNotMatch(source, /--sdk-version/u, `${caller} passes the retired CLI SDK override`);
  }
});
