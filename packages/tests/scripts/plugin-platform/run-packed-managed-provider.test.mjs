import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS,
  assertPackedManagedStandaloneCliArchiveIdentity,
  buildPackedManagedProviderRecipe,
  parsePackedManagedProviderArgs,
  resolvePackedManagedWrapperExecutable,
  runPackedManagedProviderVertical,
} from './run-packed-managed-provider.mjs';

const candidate = Object.freeze({
  schemaVersion: 1,
  runId: 'r445-exact-candidate',
  sdk: Object.freeze({
    packageName: '@happier-dev/plugin-sdk',
    version: '0.0.0',
    integrity: 'sha512-sdk',
    tarballPath: '/candidate/sdk.tgz',
  }),
  cli: Object.freeze({
    packageName: '@happier-dev/cli',
    version: '0.2.10',
    integrity: 'sha512-cli',
    tarballPath: '/candidate/cli.tgz',
    entrypoint: 'package/bin/happier.mjs',
  }),
  standaloneCli: Object.freeze({
    product: 'happier',
    version: '0.2.10',
    os: 'darwin',
    arch: 'arm64',
    sha256: 'a'.repeat(64),
    archivePath: '/candidate/happier-v0.2.10-darwin-arm64.tar.gz',
    archives: Object.freeze([
      Object.freeze({
        product: 'happier',
        version: '0.2.10',
        os: 'darwin',
        arch: 'arm64',
        sha256: 'a'.repeat(64),
        archivePath: '/candidate/happier-v0.2.10-darwin-arm64.tar.gz',
      }),
    ]),
  }),
});

const standaloneCliArtifact = Object.freeze({
  product: 'happier',
  version: '0.2.10',
  os: 'darwin',
  arch: 'arm64',
  archivePath: '/candidate/happier-v0.2.10-darwin-arm64.tar.gz',
  sha256: 'a'.repeat(64),
  extractRoot: '/isolated/standalone/happier-v0.2.10-darwin-arm64',
  executablePath: '/isolated/standalone/happier-v0.2.10-darwin-arm64/happier',
});

function exactPreparation() {
  return Object.freeze({
    candidate,
    standaloneCliArtifact,
    cliLaunchSpec: Object.freeze({
      command: standaloneCliArtifact.executablePath,
      args: [],
      cwd: '/isolated/agent-workspace',
    }),
    wrapperExecutable:
      '/isolated/standalone/happier-v0.2.10-darwin-arm64/tools/unpacked/happier-cliproxyapi-managed',
    verifiedCandidateIntegrity: true,
    verifiedCandidatePackageIdentity: true,
    verifiedStandaloneCliIntegrity: true,
    verifiedStandaloneCliIdentity: true,
  });
}

function managedSequenceEvidence(overrides = {}) {
  return Object.freeze({
    freshSession: true,
    agentId: 'opencode',
    canonicalSessionIdBeforeWebhook: null,
    canonicalSessionId: 'session-canonical-a',
    purposes: Object.freeze([
      'happier.agent.opencode/opencode:openai-codex-model-request',
      'happier.provider.cliproxyapi/cliproxyapi:openai-upstream',
    ]),
    capabilityScopeDigests: Object.freeze([
      'a'.repeat(64),
      'b'.repeat(64),
    ]),
    timeline: Object.freeze({
      freshSpawnStartedAtMs: 1,
      canonicalSessionRegisteredAtMs: 2,
      capabilitiesActivatedAtMs: 2,
      canonicalWebhookAcknowledgedAtMs: 3,
      spawnAcknowledgedAtMs: 4,
      agentRequestAuthLookupAtMs: 5,
      agentRequestAuthLookupCompletedAtMs: 6,
      managedRequestAuthLookupAtMs: 7,
      managedRequestAuthLookupCompletedAtMs: 8,
      providerAttemptAtMs: 9,
    }),
    observedPorts: Object.freeze({
      server: 41001,
      serverProxy: 41002,
      daemon: 41003,
      brokerProxy: 41004,
      upstreamProxy: 41005,
      wrapper: 41006,
    }),
    stockPortRequestCount: 0,
    stockPortOsConnectionAttemptCount: 0,
    stockListenerIdentityBefore: `sha256:${'e'.repeat(64)}`,
    stockListenerIdentityAfter: `sha256:${'e'.repeat(64)}`,
    preActivationCredentialReleased: false,
    preActivationUpstreamAttempted: false,
    preActivationAgentCapabilityPresent: false,
    managedLeaseCredentialRevision: 'revision-current',
    managedLeaseAccessTokenFingerprint: `sha256:${'c'.repeat(64)}`,
    upstreamAuthorizationFingerprint: `sha256:${'c'.repeat(64)}`,
    managedRequestAuthOrigin: 'https://chatgpt.com',
    managedConnectionSecurityFingerprint:
      `connection-security:v1:${'d'.repeat(43)}`,
    upstreamConnectTarget: 'chatgpt.com:443',
    promptSentinelObserved: true,
    upstreamRequestPath: '/backend-api/codex/responses',
    currentCredentialRevision: 'revision-current',
    currentAccessTokenFingerprint: `sha256:${'c'.repeat(64)}`,
    ...overrides,
  });
}

function dependencies(overrides = {}) {
  const events = [];
  return {
    events,
    deps: {
      prepareCandidate: async () => {
        events.push('prepare-candidate');
        return exactPreparation();
      },
      runPackagedWrapperConformance: async () => {
        events.push('wrapper-conformance');
        return {
          tokenFreeReadiness: true,
          preActivationLookupRefused: true,
          preActivationCredentialReleased: false,
          preActivationUpstreamAttempted: false,
        };
      },
      runFreshManagedSequence: async () => {
        events.push('managed-sequence');
        return managedSequenceEvidence();
      },
      runActivationFailureCleanupProbe: async () => {
        events.push('activation-failure-cleanup');
        return {
          activationFailedBeforeAck: true,
          firstInputDispatched: false,
          providerAttempted: false,
          wrapperStopped: true,
          capabilityRetired: true,
          materializationRemoved: true,
        };
      },
      cleanup: async () => {
        events.push('cleanup');
      },
      ...overrides,
    },
  };
}

test('prints a candidate-free dry-run recipe with the exact future command and isolated resources', () => {
  assert.deepEqual(parsePackedManagedProviderArgs(['--recipe']), {
    mode: 'recipe',
    candidateManifestPath: null,
  });
  const recipe = buildPackedManagedProviderRecipe({
    packageRoot: '/repo/packages/tests',
  });
  assert.equal(
    recipe.command,
    'yarn workspace @happier-dev/tests test:plugin-platform:packed-managed-provider --candidate <candidate-manifest.json>',
  );
  assert.equal(recipe.inputs.candidateManifest.includes('one run'), true);
  assert.equal(recipe.inputs.standaloneCliArtifact.includes('candidate-manifest-bound'), true);
  assert.deepEqual(recipe.requiredStageIds, PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS);
  assert.equal(recipe.resources.stockCliProxyApiPort, 8317);
  assert.equal(recipe.resources.stockCliProxyApiPolicy, 'must-not-connect-or-mutate');
  assert.equal(recipe.resources.cliSourceFallback, false);
  assert.equal(recipe.resources.dynamicPortsOnly, true);
});

test('selects the exact host-native standalone CLI artifact only from the candidate manifest', () => {
  assert.deepEqual(
    parsePackedManagedProviderArgs([
      '--candidate',
      '/candidate/candidate-manifest.json',
    ]),
    {
      mode: 'run',
      candidateManifestPath: '/candidate/candidate-manifest.json',
      enableOpenCodeLive: false,
    },
  );
  assert.throws(
    () => parsePackedManagedProviderArgs([
      '--candidate',
      '/candidate/candidate-manifest.json',
      '--standalone-cli-artifact',
      standaloneCliArtifact.archivePath,
    ]),
    /packed_managed_provider_unknown_argument/,
  );
  assert.throws(
    () => parsePackedManagedProviderArgs([
      '--candidate',
      '/candidate/candidate-manifest.json',
      '--opencode-live',
    ]),
    /packed_managed_provider_opencode_live_not_supported/,
  );
});

test('resolves only a wrapper physically owned by the private standalone CLI artifact', () => {
  const standaloneCliExecutable = standaloneCliArtifact.executablePath;
  const expected =
    '/isolated/standalone/happier-v0.2.10-darwin-arm64/tools/unpacked/happier-cliproxyapi-managed';
  assert.equal(resolvePackedManagedWrapperExecutable({
    standaloneCliExecutable,
    standaloneCliExtractRoot: standaloneCliArtifact.extractRoot,
    platform: 'darwin',
    existsSync: (path) => path === expected,
    realpathSync: (path) => path,
  }), expected);

  assert.throws(
    () => resolvePackedManagedWrapperExecutable({
      standaloneCliExecutable,
      standaloneCliExtractRoot: standaloneCliArtifact.extractRoot,
      platform: 'darwin',
      existsSync: () => false,
      realpathSync: (path) => path,
    }),
    /packed_managed_provider_wrapper_absent_from_standalone_cli/,
  );
  assert.throws(
    () => resolvePackedManagedWrapperExecutable({
      standaloneCliExecutable,
      standaloneCliExtractRoot: standaloneCliArtifact.extractRoot,
      platform: 'darwin',
      existsSync: () => true,
      realpathSync: (path) => path.endsWith('happier-cliproxyapi-managed')
        ? '/workspace/apps/cli/tools/unpacked/happier-cliproxyapi-managed'
        : path,
    }),
    /packed_managed_provider_wrapper_escaped_candidate/,
  );
});

test('accepts only the canonical host-native standalone archive layout and binds it to candidate version', () => {
  assert.deepEqual(
    assertPackedManagedStandaloneCliArchiveIdentity({
      archivePath: standaloneCliArtifact.archivePath,
      candidateCliVersion: candidate.cli.version,
      platform: 'darwin',
      arch: 'arm64',
      entries: [
        { path: 'happier-v0.2.10-darwin-arm64', kind: 'directory' },
        { path: 'happier-v0.2.10-darwin-arm64/happier', kind: 'file' },
        {
          path: 'happier-v0.2.10-darwin-arm64/tools/unpacked/happier-cliproxyapi-managed',
          kind: 'file',
        },
        {
          path: 'happier-v0.2.10-darwin-arm64/tools/unpacked/CLIProxyAPI-LICENSE',
          kind: 'file',
        },
        {
          path: 'happier-v0.2.10-darwin-arm64/tools/unpacked/CLIProxyAPI-THIRD-PARTY-NOTICES',
          kind: 'file',
        },
      ],
    }),
    {
      product: 'happier',
      version: '0.2.10',
      os: 'darwin',
      arch: 'arm64',
      archiveName: 'happier-v0.2.10-darwin-arm64.tar.gz',
      artifactRootName: 'happier-v0.2.10-darwin-arm64',
      executableRelativePath: 'happier-v0.2.10-darwin-arm64/happier',
      wrapperRelativePath:
        'happier-v0.2.10-darwin-arm64/tools/unpacked/happier-cliproxyapi-managed',
    },
  );
  assert.throws(
    () => assertPackedManagedStandaloneCliArchiveIdentity({
      archivePath: '/candidate/happier-v0.2.9-darwin-arm64.tar.gz',
      candidateCliVersion: candidate.cli.version,
      platform: 'darwin',
      arch: 'arm64',
      entries: [],
    }),
    /packed_managed_provider_standalone_cli_identity_mismatch/,
  );
  assert.throws(
    () => assertPackedManagedStandaloneCliArchiveIdentity({
      archivePath: standaloneCliArtifact.archivePath,
      candidateCliVersion: candidate.cli.version,
      platform: 'darwin',
      arch: 'arm64',
      entries: [
        { path: 'happier-v0.2.10-darwin-arm64/happier', kind: 'file' },
      ],
    }),
    /packed_managed_provider_standalone_cli_wrapper_missing/,
  );
});

test('accepts only exact candidate identity and the canonical fresh managed activation sequence', async () => {
  const { deps, events } = dependencies();
  const result = await runPackedManagedProviderVertical({
    candidateManifestPath: '/candidate/candidate-manifest.json',
    workRoot: '/isolated/run',
    enableOpenCodeLive: false,
  }, deps);

  assert.equal(result.status, 'passed');
  assert.equal(result.candidate.runId, candidate.runId);
  assert.equal(result.standaloneCliArtifact.sha256, standaloneCliArtifact.sha256);
  assert.deepEqual(result.stages.map((stage) => stage.id), PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS);
  assert.deepEqual(
    result.stages.find((stage) => stage.id === 'fresh-managed-spawn')?.evidence,
    { agentId: 'opencode' },
  );
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(events, [
    'prepare-candidate',
    'wrapper-conformance',
    'managed-sequence',
    'activation-failure-cleanup',
    'cleanup',
  ]);
});

test('rejects a lookalike candidate preparation before executing the managed boundary', async () => {
  const { deps, events } = dependencies({
    prepareCandidate: async () => ({
      ...exactPreparation(),
      verifiedCandidatePackageIdentity: false,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_candidate_identity_mismatch/,
  );
  assert.deepEqual(events, ['cleanup']);
});

test('rejects a standalone artifact not bound to the exact candidate version and digest', async () => {
  const { deps, events } = dependencies({
    prepareCandidate: async () => ({
      ...exactPreparation(),
      standaloneCliArtifact: {
        ...standaloneCliArtifact,
        version: '0.2.9',
      },
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_standalone_cli_identity_mismatch/,
  );
  assert.deepEqual(events, ['cleanup']);
});

test('rejects npm-candidate or source-tree launch specs for the managed vertical', async () => {
  const { deps } = dependencies({
    prepareCandidate: async () => ({
      ...exactPreparation(),
      cliLaunchSpec: {
        command:
          '/isolated/candidate/node_modules/@happier-dev/cli/bin/happier.mjs',
        args: [],
        cwd: '/isolated/agent-workspace',
      },
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_standalone_cli_launch_mismatch/,
  );
});

test('rejects first input or a provider attempt before canonical webhook acknowledgement', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      timeline: Object.freeze({
        freshSpawnStartedAtMs: 1,
        canonicalSessionRegisteredAtMs: 2,
        capabilitiesActivatedAtMs: 2,
        canonicalWebhookAcknowledgedAtMs: 5,
        spawnAcknowledgedAtMs: 6,
        agentRequestAuthLookupAtMs: 3,
        managedRequestAuthLookupAtMs: 4,
        agentRequestAuthLookupCompletedAtMs: 4,
        managedRequestAuthLookupCompletedAtMs: 5,
        providerAttemptAtMs: 7,
      }),
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_sequence_mismatch/,
  );
});

test('does not treat server session registration as the daemon webhook acknowledgement', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      timeline: Object.freeze({
        freshSpawnStartedAtMs: 1,
        canonicalSessionRegisteredAtMs: 2,
        capabilitiesActivatedAtMs: 3,
        agentRequestAuthLookupAtMs: 4,
        agentRequestAuthLookupCompletedAtMs: 5,
        managedRequestAuthLookupAtMs: 4,
        managedRequestAuthLookupCompletedAtMs: 5,
        canonicalWebhookAcknowledgedAtMs: 6,
        spawnAcknowledgedAtMs: 7,
        providerAttemptAtMs: 8,
      }),
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_sequence_mismatch/,
  );
});

test('requires capability activation before the exact daemon webhook acknowledgement', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      timeline: Object.freeze({
        freshSpawnStartedAtMs: 1,
        canonicalSessionRegisteredAtMs: 2,
        canonicalWebhookAcknowledgedAtMs: 3,
        capabilitiesActivatedAtMs: 4,
        spawnAcknowledgedAtMs: 5,
        agentRequestAuthLookupAtMs: 6,
        agentRequestAuthLookupCompletedAtMs: 7,
        managedRequestAuthLookupAtMs: 6,
        managedRequestAuthLookupCompletedAtMs: 7,
        providerAttemptAtMs: 8,
      }),
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_sequence_mismatch/,
  );
});

test('requires both exact Agent and managed purpose authorities before acknowledgement', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      capabilityScopeDigests: Object.freeze(['b'.repeat(64)]),
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_missing_agent_request_auth/,
  );
});

test('requires the exact first prompt and broker lease token at the decrypted upstream boundary', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      upstreamAuthorizationFingerprint: `sha256:${'d'.repeat(64)}`,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_current_auth_mismatch/,
  );
});

test('rejects drift between the managed request-auth origin and observed final target', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      managedRequestAuthOrigin: 'https://chatgpt.com',
      upstreamConnectTarget: 'api.openai.com:443',
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_managed_origin_mismatch/,
  );
});

test('requires the canonical managed connection-security fingerprint', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      managedConnectionSecurityFingerprint: `sha256:${'d'.repeat(64)}`,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_managed_origin_mismatch/,
  );
});

test('requires a passive unchanged identity for the stock CLIProxyAPI listener', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      stockListenerIdentityAfter: `sha256:${'f'.repeat(64)}`,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_current_auth_mismatch/,
  );
});

test('rejects an OS-observed candidate connection to stock even when proxy and listener evidence look clean', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      stockPortRequestCount: 0,
      stockPortOsConnectionAttemptCount: 1,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_current_auth_mismatch/,
  );
});

test('requires exact cleanup and no first input or provider attempt after activation failure', async () => {
  const { deps } = dependencies({
    runActivationFailureCleanupProbe: async () => ({
      activationFailedBeforeAck: true,
      firstInputDispatched: true,
      providerAttempted: false,
      wrapperStopped: true,
      capabilityRetired: true,
      materializationRemoved: true,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_activation_failure_cleanup_mismatch/,
  );
});
