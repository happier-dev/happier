import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PACKED_CHANNEL_PROVIDER_REQUIRED_STAGE_IDS,
  PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS,
  assertPackedManagedStandaloneCliArchiveIdentity,
  buildPackedManagedProviderEntrypointInvocation,
  buildPackedManagedProviderRecipe,
  parsePackedManagedProviderArgs,
  resolvePackedManagedWrapperExecutable,
  runPackedChannelProviderVertical,
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
  pluginUi: Object.freeze({
    packageName: '@happier-dev/plugin-ui',
    version: '0.0.0',
    pluginSdkVersion: '0.0.0',
    integrity: 'sha512-plugin-ui',
    tarballPath: '/candidate/plugin-ui.tgz',
  }),
  channelsProtocol: Object.freeze({
    packageName: '@happier-dev/channels-protocol',
    version: '0.0.0',
    integrity: 'sha512-Y2hhbm5lbHMtcHJvdG9jb2w=',
    tarballPath: '/candidate/channels-protocol.tgz',
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

function exactPreparation(candidateInput = candidate) {
  return Object.freeze({
    candidate: candidateInput,
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
    canonicalSessionId: 'session-canonical-a',
    publicActivationReason: 'sessionDemand',
    connectionRevision: 3,
    purposes: Object.freeze([
      'happier.agent.opencode/opencode:openai-codex-model-request',
      'happier.provider.cliproxyapi/cliproxyapi:openai-upstream',
    ]),
    timeline: Object.freeze({
      freshSpawnStartedAtMs: 1,
      canonicalSessionRegisteredAtMs: 2,
      spawnAcknowledgedAtMs: 4,
      providerAttemptAtMs: 9,
    }),
    observedPorts: Object.freeze({
      server: 41001,
      serverProxy: 41002,
      daemon: 41003,
      upstreamProxy: 41005,
    }),
    stockPortRequestCount: 0,
    stockPortOsConnectionAttemptCount: 0,
    stockListenerIdentityBefore: `sha256:${'e'.repeat(64)}`,
    stockListenerIdentityAfter: `sha256:${'e'.repeat(64)}`,
    preSessionDemandCredentialReleased: false,
    preSessionDemandUpstreamAttempted: false,
    upstreamAuthorizationFingerprint: `sha256:${'c'.repeat(64)}`,
    managedRequestAuthOrigin: 'https://chatgpt.com',
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
          publicExplicitStart: true,
          publicCatalogProbe: true,
          catalogOwnerReleased: true,
          publicCredentialLeakObserved: false,
          providerAttemptedBeforeSessionDemand: false,
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
          publicSessionCleanupComplete: true,
          sessionProviderExited: true,
        };
      },
      cleanup: async () => {
        events.push('cleanup');
      },
      ...overrides,
    },
  };
}

test('prints a moving-source recipe with the normal development command and isolated resources', () => {
  assert.deepEqual(parsePackedManagedProviderArgs(['--recipe']), {
    mode: 'recipe',
    candidateManifestPath: null,
  });
  const recipe = buildPackedManagedProviderRecipe({
    packageRoot: '/repo/packages/tests',
  });
  assert.equal(
    recipe.command,
    'yarn workspace @happier-dev/tests test:plugin-platform:packed-managed-provider',
  );
  assert.match(recipe.inputs.source, /current checkout/u);
  assert.equal(Object.hasOwn(recipe.inputs, 'candidateManifest'), false);
  assert.match(recipe.resources.externalAuthoring, /current packed SDK/u);
  assert.equal(recipe.resources.cliSourceFallback, false);
  assert.equal(recipe.resources.dynamicPortsOnly, true);
  assert.deepEqual(recipe.environment.required, [
    'HAPPIER_FEATURE_PROVIDERS__ENABLED=1',
    'HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED=0',
  ]);
  assert.equal(
    recipe.environment.required.includes(
      'HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED=1',
    ),
    false,
  );
});

test('dispatches the current-source External Sessions packed proof without candidate or native archive inputs', () => {
  const parsed = parsePackedManagedProviderArgs(['--current-source']);

  assert.deepEqual(parsed, {
    mode: 'current-source',
    candidateManifestPath: null,
  });

  const invocation = buildPackedManagedProviderEntrypointInvocation({
    packageRoot: '/repo/packages/tests',
    parsed,
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    '/repo/packages/tests/scripts/runTsxEntrypoint.mjs',
    'src/plugin-platform/runPackedManagedProviderContinuity.ts',
    '--current-source',
  ]);
  assert.equal(invocation.args.includes('--candidate'), false);

  assert.throws(
    () => parsePackedManagedProviderArgs([
      '--current-source',
      '--candidate',
      '/candidate/manifest.json',
    ]),
    /packed_managed_provider_current_source_must_be_candidate_free/u,
  );
});

test('current-source external packaged runtime owns non-CPX bytes without a Go build', () => {
  const continuitySource = readFileSync(
    new URL('../../src/plugin-platform/runPackedManagedProviderContinuity.ts', import.meta.url),
    'utf8',
  );
  const composedSource = readFileSync(
    new URL('../../src/plugin-platform/packedManagedProviderComposedRuntime.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(continuitySource, /spawn\(['"]go['"]/u);
  assert.doesNotMatch(
    continuitySource,
    /await runPackedManagedProviderVertical\(/u,
  );
  assert.match(continuitySource, /copyFile\(process\.execPath, wrapperExecutable\)/u);
  assert.match(continuitySource, /acme-packed-provider-runtime/u);
  assert.match(continuitySource, /join\(root, 'external-provider-runtime'\)/u);
  assert.match(
    continuitySource,
    /probeCandidateExternalAgentProviderHandoff\([\s\S]*?source\.prepared/u,
  );
  assert.match(composedSource, /const externalRuntimeProgram = \[/u);
  assert.match(composedSource, /CANDIDATE_HANDOFF_PROVIDER_BINARY_NAME =\s*'acme-packed-provider-runtime'/u);
  assert.match(composedSource, /args: \['-e', externalRuntimeProgram\]/u);
  assert.doesNotMatch(
    composedSource,
    /CLIProxyAPI-LICENSE[\s\S]{0,500}?writeCandidateHandoffProviderSource/u,
  );
});

test('dispatches the packed Channel provider vertical as its own executable candidate mode', () => {
  const parsed = parsePackedManagedProviderArgs([
    '--channel',
    '--candidate',
    '/candidate/manifest.json',
  ]);

  assert.deepEqual(parsed, {
    mode: 'channel',
    candidateManifestPath: '/candidate/manifest.json',
    enableOpenCodeLive: false,
  });

  const invocation = buildPackedManagedProviderEntrypointInvocation({
    packageRoot: '/repo/packages/tests',
    parsed,
  });
  assert.deepEqual(invocation.args, [
    '/repo/packages/tests/scripts/runTsxEntrypoint.mjs',
    'src/plugin-platform/runPackedManagedProviderContinuity.ts',
    '--channel',
    '--candidate',
    '/candidate/manifest.json',
  ]);

  assert.deepEqual(
    parsePackedManagedProviderArgs([
      '--channel',
      '--candidate',
      '/candidate/manifest.json',
      '--work-root',
      '/candidate/work',
    ]),
    {
      mode: 'channel',
      candidateManifestPath: '/candidate/manifest.json',
      enableOpenCodeLive: false,
      workRoot: '/candidate/work',
    },
  );

  // The Channel vertical reverifies a candidate channels-protocol archive, so it
  // can never run from the candidate-free recipe or current-source modes.
  assert.throws(
    () => parsePackedManagedProviderArgs(['--channel']),
    /packed_managed_provider_candidate_required/u,
  );
  assert.throws(
    () => parsePackedManagedProviderArgs(['--channel', '--current-source']),
    /packed_managed_provider_current_source_must_be_candidate_free/u,
  );
  assert.throws(
    () => parsePackedManagedProviderArgs(['--recipe', '--channel']),
    /packed_managed_provider_recipe_must_be_candidate_free/u,
  );
  assert.throws(
    () => parsePackedManagedProviderArgs([
      '--channel',
      '--channel',
      '--candidate',
      '/candidate/manifest.json',
    ]),
    /packed_managed_provider_channel_repeated/u,
  );
});

test('does not advertise the release-only manifest Channel path as ordinary moving-source QA', () => {
  const recipe = buildPackedManagedProviderRecipe({
    packageRoot: '/repo/packages/tests',
  });

  assert.equal(Object.hasOwn(recipe, 'channelCommand'), false);
  assert.equal(Object.hasOwn(recipe, 'channelProviderStageIds'), false);
});

test('explicitly disables the separate Local Services product in every packed Provider launcher', () => {
  const harnessSources = [
    './run-packed-managed-provider.mjs',
    '../../src/plugin-platform/runPackedManagedProviderVertical.ts',
    '../../src/plugin-platform/packedManagedProviderComposedRuntime.ts',
  ];
  const positiveInjection =
    /HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED\s*(?:=|:)\s*['"]?(?:1|true)/iu;
  const disabledInjection =
    /HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED\s*(?:=|:)\s*['"]?(?:0|false)/iu;

  assert.deepEqual(
    harnessSources.flatMap((path) => (
      positiveInjection.test(readFileSync(new URL(path, import.meta.url), 'utf8'))
        ? [path]
        : []
    )),
    [],
  );
  assert.deepEqual(
    harnessSources.flatMap((path) => (
      disabledInjection.test(readFileSync(new URL(path, import.meta.url), 'utf8'))
        ? [path]
        : []
    )),
    harnessSources,
  );
});

test('registers a packed external-session observation contribution with an observe-resource descriptor', () => {
  const harnessSource = readFileSync(
    new URL('../../src/plugin-platform/packedManagedProviderComposedRuntime.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    harnessSource,
    /AgentExternalSessionObservationContribution/u,
  );
  assert.match(
    harnessSource,
    /export const externalSessionObservation = \{/u,
  );
  assert.match(
    harnessSource,
    /if \(request\.purpose === 'resource_descriptors'\) \{[\s\S]{0,4000}?kind: 'described' as const,[\s\S]{0,1000}?changeObservation: 'observe_resource' as const,/u,
  );
  assert.match(
    harnessSource,
    /request\.requestTranscriptRefresh\(packedExternalSessionObservationLinkKeyForResource\(request\.resourceKey\)\);/u,
  );
  assert.match(
    harnessSource,
    /import \{ createPackedAgentRuntime, externalSessions, externalSessionObservation, packedAgentGeneration \} from '\.\/agentRuntime\.js';/u,
  );
  const externalSessionsRegistration = harnessSource.indexOf(
    "'      externalSessions,'",
  );
  const observationRegistration = harnessSource.indexOf(
    "'      externalSessionObservation,'",
  );
  const providerBindingRegistration = harnessSource.indexOf(
    "'      providerBinding,'",
  );
  assert.ok(externalSessionsRegistration >= 0, 'the Agent keeps its External Sessions facet');
  assert.ok(
    observationRegistration > externalSessionsRegistration,
    'the observation facet is registered beside External Sessions',
  );
  assert.ok(
    providerBindingRegistration > observationRegistration,
    'the existing Provider binding remains after observation registration',
  );
});

test('uses one packed Agent declaration for the manifest, runtime facets, and packedCandidate source', () => {
  const harnessSource = readFileSync(
    new URL('../../src/plugin-platform/packedManagedProviderComposedRuntime.ts', import.meta.url),
    'utf8',
  );
  const declarationStart = harnessSource.indexOf(
    'const candidateHandoffAgentDeclaration = Object.freeze({',
  );
  const declarationEnd = harnessSource.indexOf('\n});', declarationStart);

  assert.ok(declarationStart >= 0, 'the packed Agent has one declaration owner');
  assert.ok(declarationEnd > declarationStart, 'the packed Agent declaration is bounded');
  const declaration = harnessSource.slice(declarationStart, declarationEnd);
  assert.match(
    declaration,
    /surfaces: \['terminal', 'externalSessions'\]/u,
  );
  assert.match(
    declaration,
    /externalLinkedTakeover: \{ writerSafety: 'native_prevention' \}/u,
  );
  assert.equal(
    (declaration.match(/sourceKind: 'packedCandidate'/gu) ?? []).length,
    1,
    'the declaration has exactly one packedCandidate source',
  );
  assert.match(
    declaration,
    /\{ kind: 'string', name: 'scope', min: 1, max: 256, nullish: true \}/u,
  );
  assert.match(
    declaration,
    /key:\s*\{\s*segments:\s*\[\s*\{ kind: 'literal', value: 'packedCandidate' \},\s*\{ kind: 'field', field: 'scope' \},\s*\],\s*\},/u,
  );
  assert.match(
    harnessSource,
    /agents: \[\{\s*id: CANDIDATE_HANDOFF_AGENT_ID,\s*\.\.\.candidateHandoffAgentDeclaration,\s*\}\]/u,
  );
  assert.equal(
    harnessSource.includes(
      '`      declaration: ${JSON.stringify(candidateHandoffAgentDeclaration)},`,',
    ),
    true,
    'the generated definePlugin declaration uses the same data-only owner',
  );
  assert.equal(
    harnessSource.includes("'      externalSessions,'")
      && harnessSource.includes("'      externalSessionObservation,'"),
    true,
    'the public runtime facets match the declared External Sessions surface',
  );
});

test('uses the canonical external-session background-follow Action and proves its disabled cleanup', () => {
  const harnessSource = readFileSync(
    new URL('../../src/plugin-platform/packedManagedProviderComposedRuntime.ts', import.meta.url),
    'utf8',
  );
  const attachedMarker =
    'const attached = await context.services.sessions.external.attach(publicRef);';
  const enabledMarker =
    "sessions.external.backgroundFollow.set', { sessionId: attached.sessionId, enabled: true }";
  const disabledMarker =
    "sessions.external.backgroundFollow.set', { sessionId: attached.sessionId, enabled: false }";
  const takeoverMarker =
    'const takeover = await context.services.sessions.external.takeover(publicRef,';
  const attachedIndex = harnessSource.indexOf(attachedMarker);
  const enabledIndex = harnessSource.indexOf(enabledMarker);
  const disabledIndex = harnessSource.indexOf(disabledMarker);
  const takeoverIndex = harnessSource.indexOf(takeoverMarker);

  assert.ok(attachedIndex >= 0, 'the H public phase attaches the external Session');
  assert.ok(enabledIndex > attachedIndex, 'background follow is enabled after attachment');
  assert.ok(disabledIndex > enabledIndex, 'background follow is disabled after it is enabled');
  assert.ok(takeoverIndex > disabledIndex, 'takeover happens after the cleanup assertion');
  const backgroundFollowSource = harnessSource.slice(attachedIndex, takeoverIndex);
  assert.match(
    backgroundFollowSource,
    /let backgroundFollowEnableFailed = false;[\s\S]*?try \{[\s\S]*?const backgroundFollowEnabledResult = await context\.services\.actions\.execute\('sessions\.external\.backgroundFollow\.set', \{ sessionId: attached\.sessionId, enabled: true \}\);[\s\S]*?backgroundFollowEnabled = backgroundFollowEnabledResult;[\s\S]*?\} catch \(error\) \{[\s\S]*?backgroundFollowEnableFailed = true;[\s\S]*?backgroundFollowPrimaryFailure = error;[\s\S]*?\} finally \{[\s\S]*?const backgroundFollowDisabledResult = await context\.services\.actions\.execute\('sessions\.external\.backgroundFollow\.set', \{ sessionId: attached\.sessionId, enabled: false \}\);[\s\S]*?backgroundFollowDisabled = backgroundFollowDisabledResult;[\s\S]*?if \(!backgroundFollowDisabledResult\.ok \|\| backgroundFollowDisabledResult\.enabled !== false \|\| backgroundFollowDisabledResult\.leaseActive !== false\) throw new Error\('packed_external_background_follow_disable_invalid'\);/u,
  );
  assert.match(
    backgroundFollowSource,
    /if \(backgroundFollowEnableFailed\) \{[\s\S]*?throw new AggregateError\(\[backgroundFollowPrimaryFailure, cleanupError\], 'packed_external_background_follow_enable_and_cleanup_failed'\);[\s\S]*?\}[\s\S]*?throw cleanupError;[\s\S]*?if \(backgroundFollowEnableFailed\) throw backgroundFollowPrimaryFailure;/u,
  );
  assert.equal(
    (backgroundFollowSource.match(/sessions\.external\.backgroundFollow\.set', \{ sessionId: attached\.sessionId, enabled: false \}/gu) ?? []).length,
    1,
    'the existing Action has one unconditional cleanup invocation',
  );
  assert.match(
    harnessSource,
    /PLUGIN_ACTION_OUTPUT_SCHEMAS\[\s*'sessions\.external\.backgroundFollow\.set'\s*\]\.safeParse\(value\)/u,
  );
  assert.match(
    harnessSource,
    /isRecord\(parsed\.data\)\s*&&\s*parsed\.data\.ok === true\s*&&\s*parsed\.data\.enabled === expectedEnabled\s*&&\s*parsed\.data\.leaseActive === expectedEnabled/u,
  );
  assert.match(
    harnessSource,
    /backgroundFollowEnabled:\s*isPackedCandidateBackgroundFollowActionResult\(\s*externalSessionsHPhase\.backgroundFollowEnabled,\s*true,\s*\)/u,
  );
  assert.match(
    harnessSource,
    /backgroundFollowDisabled:\s*isPackedCandidateBackgroundFollowActionResult\(\s*externalSessionsHPhase\.backgroundFollowDisabled,\s*false,\s*\)/u,
  );
});

test('drives the packed public External Sessions flow through current H with a G logical ref and one settled terminal disposal', () => {
  const harnessSource = readFileSync(
    new URL('../../src/plugin-platform/packedManagedProviderComposedRuntime.ts', import.meta.url),
    'utf8',
  );
  const acceptanceStart = harnessSource.indexOf(
    "'export async function runPackedExternalSessionsAcceptance(context: PluginInvocationContext) {',",
  );
  const acceptanceEnd = harnessSource.indexOf(
    "'const plugin = definePlugin({',",
    acceptanceStart,
  );

  assert.ok(acceptanceStart >= 0, 'the packed public External Sessions action exists');
  assert.ok(acceptanceEnd > acceptanceStart, 'the packed public External Sessions action is bounded');
  const acceptance = harnessSource.slice(acceptanceStart, acceptanceEnd);
  const capabilitiesIndex = acceptance.indexOf(
    'const capabilities = await context.services.sessions.external.capabilities();',
  );
  const listIndex = acceptance.indexOf(
    'const listed = await context.services.sessions.external.list(',
  );
  const attachIndex = acceptance.indexOf(
    'const attached = await context.services.sessions.external.attach(publicRef);',
  );
  const readIndex = acceptance.indexOf(
    'const transcript = await context.services.sessions.external.readTranscript(publicRef,',
  );
  const followIndex = acceptance.indexOf(
    'const followed = await context.services.sessions.external.followTranscript(publicRef,',
  );
  const takeoverIndex = acceptance.indexOf(
    'const takeover = await context.services.sessions.external.takeover(publicRef,',
  );

  assert.ok(capabilitiesIndex >= 0, 'capabilities is asynchronous public-service evidence');
  assert.ok(listIndex > capabilitiesIndex, 'list follows capabilities');
  assert.ok(attachIndex > listIndex, 'attach follows list');
  assert.ok(readIndex > attachIndex, 'readTranscript follows attach');
  assert.ok(followIndex > readIndex, 'followTranscript follows readTranscript');
  assert.ok(takeoverIndex > followIndex, 'takeover follows the settled follow lifecycle');
  assert.match(
    acceptance,
    /let publicGFollowPersistence: Promise<void> = Promise\.resolve\(\);[\s\S]*?const persistPublicGFollow = \(\): Promise<void> => \{ const phase = \{ ref: candidate\.ref, listCursor: listed\.nextCursor, followCursor: publicGFollowCursor, publicGFollow \}; publicGFollowPersistence = publicGFollowPersistence\.then\(async \(\) => \{ await context\.services\.storage\.daemon\.set\('packed-external-sessions-public-phase', phase\); \}\); return publicGFollowPersistence; \};[\s\S]*?if \(packedAgentGeneration === 'G'\) \{ await publicGFollowPersistence; if \(!followListenerSettled \|\| publicGFollow\.dataEventCount < 1 \|\| publicGFollow\.terminalAcknowledgements !== 0 \|\| publicGFollow\.postTerminalEventCount !== 0\) throw new Error\('packed_external_public_g_follow_invalid'\);/u,
  );
  assert.match(
    acceptance,
    /const previousRefRecord = previous && typeof previous\.ref === 'object'[\s\S]*?const previousRef = previousRefRecord[\s\S]*?const publicRef = previousRef \?\? candidate\.ref;/u,
  );
  assert.match(
    acceptance,
    /if \(!previousRef\) throw new Error\('packed_external_public_g_ref_missing'\);/u,
  );
  assert.match(
    acceptance,
    /await Promise\.resolve\(\);[\s\S]*?followListenerSettled = true;[\s\S]*?acknowledgeFollowData\?\.\(\);/u,
  );
  assert.match(
    acceptance,
    /await followed\.subscription\.dispose\(\);[\s\S]*?await followed\.subscription\.dispose\(\);[\s\S]*?disposedTerminalAcknowledgements !== 1/u,
  );
  assert.match(
    harnessSource,
    /assertPackedCandidatePublicExternalSessionsPrivacy\(result\);/u,
  );
});

test('keeps one canonical package command wired to the daemon continuity entrypoint', () => {
  const packageManifest = JSON.parse(readFileSync(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    packageManifest.scripts['test:plugin-platform:packed-managed-provider'],
    'node scripts/plugin-platform/run-packed-managed-provider.mjs --current-source',
  );
  assert.equal(
    Object.hasOwn(
      packageManifest.scripts,
      'test:plugin-platform:packed-channel-provider',
    ),
    false,
  );
  // Candidate QA is reachable through its own explicit package entrypoint into the
  // SAME canonical runner: no mode flag is hardcoded, so an appended --candidate
  // parses as the candidate run mode instead of colliding with the strict
  // candidate-free parsing of the moving-source command.
  assert.equal(
    packageManifest.scripts['test:plugin-platform:packed-managed-provider-candidate'],
    'node scripts/plugin-platform/run-packed-managed-provider.mjs',
  );

  const invocation = buildPackedManagedProviderEntrypointInvocation({
    packageRoot: '/repo/packages/tests',
    parsed: {
      mode: 'run',
      candidateManifestPath: '/candidate/candidate-manifest.json',
      enableOpenCodeLive: false,
      workRoot: '/isolated/run',
    },
  });
  assert.deepEqual(invocation.args, [
    '/repo/packages/tests/scripts/runTsxEntrypoint.mjs',
    'src/plugin-platform/runPackedManagedProviderContinuity.ts',
    '--candidate',
    '/candidate/candidate-manifest.json',
    '--work-root',
    '/isolated/run',
  ]);
  assert.equal(invocation.cwd, '/repo/packages/tests');
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
    result.stages.find((stage) => stage.id === 'public-provider-session-demand')?.evidence,
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

test('rejects a provider attempt before canonical session registration', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      timeline: Object.freeze({
        freshSpawnStartedAtMs: 1,
        canonicalSessionRegisteredAtMs: 5,
        spawnAcknowledgedAtMs: 6,
        providerAttemptAtMs: 4,
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

test('rejects a spawn acknowledgement timestamp before the public request starts', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      timeline: Object.freeze({
        freshSpawnStartedAtMs: 4,
        canonicalSessionRegisteredAtMs: 2,
        spawnAcknowledgedAtMs: 3,
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

test('requires a positive public connection revision', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      connectionRevision: 0,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_connection_revision_missing/,
  );
});

test('requires both public Agent and managed purpose bindings', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      purposes: Object.freeze([
        'happier.provider.cliproxyapi/cliproxyapi:openai-upstream',
      ]),
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_purpose_binding_mismatch/,
  );
});

test('requires the exact first prompt and current token at the decrypted upstream boundary', async () => {
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

test('requires the public sessionDemand activation reason', async () => {
  const { deps } = dependencies({
    runFreshManagedSequence: async () => managedSequenceEvidence({
      publicActivationReason: 'catalogProbe',
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_fresh_session_mismatch/,
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
      publicSessionCleanupComplete: true,
      sessionProviderExited: true,
    }),
  });

  await assert.rejects(
    runPackedManagedProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      workRoot: '/isolated/run',
      enableOpenCodeLive: false,
    }, deps),
    /packed_managed_provider_public_session_cleanup_mismatch/,
  );
});

function packedChannelProviderLifecycleEvidence(overrides = {}) {
  const evidence = {
    archive: {
      hostRuntime: 'daemonArchive',
      reviewedInstall: true,
      publicOnlyArtifact: true,
      publicDependencyClosure: true,
    },
    discovery: {
      corePluginId: 'happier.channels',
      providerPluginId: 'acme.channels.out-of-tree-socket',
      actionLocalId: 'fixture/setup',
      targetSurface: 'plugin',
      coldCatalogBeforeProviderActivation: true,
      demandedActivation: true,
      caller: { kind: 'plugin', pluginId: 'happier.channels' },
      strictInputRejectedBeforeHandler: true,
      strictResultRejectedBeforeCore: true,
    },
    resource: {
      localId: 'status-v1',
      readObserved: true,
      watchSubscribed: true,
      invalidationDropped: true,
      rereadConverged: true,
    },
    background: {
      startedAfterAdoption: true,
      normalizedNetworkClientObserved: true,
      socketConnectCountBeforeAdoption: 0,
      observationIngressCustodied: true,
      outboundDeliveryCustodied: true,
      historyGapReported: true,
      confirmedStopReported: true,
    },
    lifecycle: {
      disableAbortedGeneration: true,
      reenableSocketCount: 1,
      daemonRestartSocketCount: 1,
      failedReplacementRetainedLkg: true,
      retiredGenerationReportInert: true,
      uninstalledCleanly: true,
    },
  };
  return {
    ...evidence,
    ...overrides,
    archive: { ...evidence.archive, ...overrides.archive },
    discovery: { ...evidence.discovery, ...overrides.discovery },
    resource: { ...evidence.resource, ...overrides.resource },
    background: { ...evidence.background, ...overrides.background },
    lifecycle: { ...evidence.lifecycle, ...overrides.lifecycle },
  };
}

test('requires daemon-owned archive lifecycle evidence for the packed external channel provider', async () => {
  const events = [];
  const result = await runPackedChannelProviderVertical({
    candidateManifestPath: '/candidate/candidate-manifest.json',
    workRoot: '/isolated/channels',
    enableOpenCodeLive: false,
  }, {
    prepareCandidate: async () => {
      events.push('prepare-candidate');
      return exactPreparation();
    },
    runPackedChannelProviderLifecycle: async () => {
      events.push('daemon-archive-lifecycle');
      return packedChannelProviderLifecycleEvidence();
    },
    cleanup: async () => {
      events.push('cleanup');
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(
    result.stages.map((stage) => stage.id),
    PACKED_CHANNEL_PROVIDER_REQUIRED_STAGE_IDS,
  );
  assert.deepEqual(events, [
    'prepare-candidate',
    'daemon-archive-lifecycle',
    'cleanup',
  ]);
});

test('rejects a Channel lifecycle candidate without the exact Channels protocol tarball', async () => {
  const { channelsProtocol: _channelsProtocol, ...candidateWithoutChannelsProtocol } = candidate;

  await assert.rejects(
    runPackedChannelProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      enableOpenCodeLive: false,
    }, {
      prepareCandidate: async () => exactPreparation(candidateWithoutChannelsProtocol),
      runPackedChannelProviderLifecycle: async () => packedChannelProviderLifecycleEvidence(),
      cleanup: async () => undefined,
    }),
    /packed_channel_provider_channels_protocol_candidate_mismatch/u,
  );
});

test('rejects a dropped Resource invalidation that does not converge by reread', async () => {
  const lifecycle = packedChannelProviderLifecycleEvidence({
    resource: { rereadConverged: false },
  });

  await assert.rejects(
    runPackedChannelProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      enableOpenCodeLive: false,
    }, {
      prepareCandidate: async () => exactPreparation(),
      runPackedChannelProviderLifecycle: async () => lifecycle,
      cleanup: async () => undefined,
    }),
    /packed_channel_provider_resource_reread_mismatch/,
  );
});

test('rejects an archive that did not retain its clean public dependency closure', async () => {
  await assert.rejects(
    runPackedChannelProviderVertical({
      candidateManifestPath: '/candidate/candidate-manifest.json',
      enableOpenCodeLive: false,
    }, {
      prepareCandidate: async () => exactPreparation(),
      runPackedChannelProviderLifecycle: async () => (
        packedChannelProviderLifecycleEvidence({
          archive: { publicDependencyClosure: false },
        })
      ),
      cleanup: async () => undefined,
    }),
    /packed_channel_provider_archive_lifecycle_mismatch/,
  );
});
