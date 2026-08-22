import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildQualifiedPluginContributionKey,
  ProviderContributionV1Schema,
} from '@happier-dev/protocol';

import {
  assertBundledProviderVerificationV1,
  collectProviderExecutableFactPathsV1,
  readAndAssertBundledProviderVerificationsV1,
} from './bundledProviderVerification.ts';

const contribution = {
  v: 1,
  id: 'fixture',
  name: 'Fixture',
  kind: 'local',
  websiteUrl: 'https://example.com',
  endpointTemplates: [{
    id: 'fixture-openai',
    protocol: 'openai-chat',
    localUrlCandidates: ['http://127.0.0.1:1234'],
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'unknown',
      statefulResponses: 'unsupported',
      reasoningControls: 'unknown',
    },
  }],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: false,
    keyUrl: 'https://example.com/keys',
    transports: [{
      id: 'fixture-bearer',
      protocols: ['openai-chat'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'static+probe',
    manualModelPolicy: 'allowed',
    staticModels: [{ id: 'fixture-model', name: 'Fixture Model' }],
    probes: [{ endpointTemplateId: 'fixture-openai', path: '/v1/models', parser: 'openai-models' }],
  },
  discovery: {
    v: 1,
    listener: { executableBasenames: ['fixture'], defaultPorts: [1234] },
    availabilityProbe: { endpointTemplateId: 'fixture-openai', path: '/v1/models', parser: 'openai-models' },
  },
  compatibilityOverrides: [{
    agentTargetKey: 'agent:fixture',
    protocol: 'openai-chat',
    status: 'experimental',
    reason: 'Fixture binding requires live proof',
  }],
};

type VerificationFixture = {
  v: 1;
  contributionKey: string;
  reviewedAt: string;
  sources: Array<{
    id: string;
    kind: 'official-doc' | 'repository-history' | 'product-decision';
    url?: string;
    locator?: string;
    accessedAt: string;
    revision: string;
  }>;
  facts: Array<{
    path: string;
    sourceIds: string[];
    status: 'verified' | 'experimental';
  }>;
};

function verificationFor(paths: readonly string[]): VerificationFixture {
  return {
    v: 1,
    contributionKey: 'happier.provider.fixture/fixture',
    reviewedAt: '2026-07-12',
    sources: [{
      id: 'official-api',
      kind: 'official-doc',
      url: 'https://example.com/docs',
      accessedAt: '2026-07-12',
      revision: 'docs-current-2026-07-12',
    }],
    facts: paths.map((path) => ({ path, sourceIds: ['official-api'], status: 'verified' })),
  };
}

test('collectProviderExecutableFactPathsV1 derives stable semantic paths without copying values', () => {
  assert.deepEqual(collectProviderExecutableFactPathsV1(contribution), [
    'catalog.probes.fixture-openai.openai-models',
    'catalog.source',
    'catalog.staticModels.fixture-model',
    'compatibilityOverrides.agent:fixture.openai-chat',
    'credential.keyUrl',
    'credential.kind',
    'credential.required',
    'credential.transports.fixture-bearer',
    'discovery.availabilityProbe',
    'discovery.listener',
    'endpointTemplates.fixture-openai.capabilities.statefulResponses',
    'endpointTemplates.fixture-openai.capabilities.streaming',
    'endpointTemplates.fixture-openai.localUrlCandidates',
    'endpointTemplates.fixture-openai.protocol',
    'kind',
    'websiteUrl',
  ]);
});

test('collectProviderExecutableFactPathsV1 closes every managed-runtime declaration fact', () => {
  const managedContribution = ProviderContributionV1Schema.parse({
    ...contribution,
    endpointTemplates: [...contribution.endpointTemplates, {
      id: 'fixture-anthropic',
      protocol: 'anthropic',
      localUrlCandidates: ['http://127.0.0.1:1234'],
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    }],
    managedRuntime: {
      kind: 'managed',
      dependencies: ['gateway-runtime'],
      connectedAccounts: [{
        purpose: 'subscription-auth',
        service: 'subscription-accounts',
        required: true,
        materializationKinds: ['httpHeaders', 'environment'],
      }, {
        purpose: 'repository-auth',
        service: { pluginId: 'acme.accounts', localId: 'repository' },
        materializationKinds: ['files', 'httpHeaders'],
      }],
      requestAuthUses: [{
        purpose: 'subscription-auth',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://accounts.example.com',
          headerNames: ['authorization', 'x-subscription-id'],
        },
      }, {
        purpose: 'repository-auth',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://repository.example.com',
          headerNames: ['authorization'],
        },
      }],
      endpointTemplateIds: ['fixture-openai'],
    },
  });
  const managedRuntime = managedContribution.managedRuntime;
  assert.ok(managedRuntime);
  const requestAuthUses = managedRuntime.requestAuthUses ?? [];
  const firstRequestAuthUse = requestAuthUses[0];
  assert.ok(firstRequestAuthUse);

  const requestAuthUseChanges = [{
    ...managedRuntime,
    requestAuthUses: requestAuthUses.map((use, index) => (
      index === 0 ? { ...use, purpose: 'replacement-auth' } : use
    )),
  }, {
    ...managedRuntime,
    requestAuthUses: requestAuthUses.map((use, index) => (
      index === 0
        ? { ...use, materialization: { ...use.materialization, kind: 'environment' } }
        : use
    )),
  }, {
    ...managedRuntime,
    requestAuthUses: requestAuthUses.map((use, index) => (
      index === 0
        ? { ...use, materialization: { ...use.materialization, origin: 'https://replacement.example.com' } }
        : use
    )),
  }, {
    ...managedRuntime,
    requestAuthUses: requestAuthUses.map((use, index) => (
      index === 0
        ? {
            ...use,
            materialization: {
              ...use.materialization,
              headerNames: ['authorization', 'x-replacement-id'],
            },
          }
        : use
    )),
  }];
  const paths = collectProviderExecutableFactPathsV1(managedContribution);
  for (const changedManagedRuntime of requestAuthUseChanges) {
    const changedContribution = { ...managedContribution, managedRuntime: changedManagedRuntime };
    assert.notDeepEqual(collectProviderExecutableFactPathsV1(changedContribution), paths);
    assert.throws(() => assertBundledProviderVerificationV1({
      buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      pluginId: 'happier.provider.fixture',
      contribution: changedContribution,
      verification: verificationFor(paths),
      todayUtc: '2026-07-12',
    }), /Missing Provider verification|Orphaned Provider verification/);
  }

  const duplicateRequestAuthPurpose = {
    ...managedContribution,
    managedRuntime: {
      ...managedRuntime,
      requestAuthUses: [...requestAuthUses, firstRequestAuthUse],
    },
  };
  assert.equal(ProviderContributionV1Schema.safeParse(duplicateRequestAuthPurpose).success, false);
  assert.equal(ProviderContributionV1Schema.safeParse({
    ...managedContribution,
    managedRuntime: requestAuthUseChanges[1],
  }).success, false);

  const reorderedRequestAuthUses = {
    ...managedContribution,
    managedRuntime: {
      ...managedRuntime,
      requestAuthUses: [...requestAuthUses].reverse().map((use) => ({
        ...use,
        materialization: {
          ...use.materialization,
          headerNames: [...use.materialization.headerNames].reverse(),
        },
      })),
    },
  };
  assert.deepEqual(collectProviderExecutableFactPathsV1(reorderedRequestAuthUses), paths);

  const managedPaths = collectProviderExecutableFactPathsV1(managedContribution)
    .filter((path) => path.startsWith('managedRuntime.'));
  assert.deepEqual(managedPaths, [
    'managedRuntime.connectedAccounts.repository-auth.materializationKinds.files',
    'managedRuntime.connectedAccounts.repository-auth.materializationKinds.httpHeaders',
    'managedRuntime.connectedAccounts.repository-auth.service.acme.accounts/repository',
    'managedRuntime.connectedAccounts.subscription-auth.materializationKinds.environment',
    'managedRuntime.connectedAccounts.subscription-auth.materializationKinds.httpHeaders',
    'managedRuntime.connectedAccounts.subscription-auth.required',
    'managedRuntime.connectedAccounts.subscription-auth.service.subscription-accounts',
    'managedRuntime.dependencies.gateway-runtime',
    'managedRuntime.endpointTemplateIds.fixture-openai',
    'managedRuntime.kind',
    'managedRuntime.requestAuthUses.repository-auth.materialization.headerNames.authorization',
    'managedRuntime.requestAuthUses.repository-auth.materialization.kind.httpHeaders',
    'managedRuntime.requestAuthUses.repository-auth.materialization.origin.https%3A%2F%2Frepository.example.com',
    'managedRuntime.requestAuthUses.subscription-auth.materialization.headerNames.authorization',
    'managedRuntime.requestAuthUses.subscription-auth.materialization.headerNames.x-subscription-id',
    'managedRuntime.requestAuthUses.subscription-auth.materialization.kind.httpHeaders',
    'managedRuntime.requestAuthUses.subscription-auth.materialization.origin.https%3A%2F%2Faccounts.example.com',
  ]);

  for (const changedManagedRuntime of [{
    ...managedRuntime,
    dependencies: ['replacement-runtime'],
  }, {
    ...managedRuntime,
    connectedAccounts: (managedRuntime.connectedAccounts ?? []).map((entry, index) => (
      index === 0 ? { ...entry, purpose: 'replacement-auth' } : entry
    )),
  }, {
    ...managedRuntime,
    endpointTemplateIds: ['fixture-anthropic'],
  }]) {
    const changedContribution = {
      ...managedContribution,
      managedRuntime: changedManagedRuntime,
    };
    assert.notDeepEqual(collectProviderExecutableFactPathsV1(changedContribution), paths);
    assert.throws(() => assertBundledProviderVerificationV1({
      buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      pluginId: 'happier.provider.fixture',
      contribution: changedContribution,
      verification: verificationFor(paths),
      todayUtc: '2026-07-12',
    }), /Missing Provider verification|Orphaned Provider verification/);
  }

  assert.doesNotThrow(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture',
    contribution: managedContribution,
    verification: verificationFor(paths),
    todayUtc: '2026-07-12',
  }));
  for (const missingPath of managedPaths) {
    assert.throws(() => assertBundledProviderVerificationV1({
      buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      pluginId: 'happier.provider.fixture',
      contribution: managedContribution,
      verification: verificationFor(paths.filter((path) => path !== missingPath)),
      todayUtc: '2026-07-12',
    }), new RegExp(`Missing Provider verification for .*${missingPath.replaceAll('.', '\\.')}`));
  }
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture',
    contribution: managedContribution,
    verification: {
      ...verificationFor(paths),
      managedRuntime: managedContribution.managedRuntime,
    },
    todayUtc: '2026-07-12',
  }), /must not restate executable Provider facts/);
});

test('assertBundledProviderVerificationV1 accepts complete field-path provenance', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  assert.doesNotThrow(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture',
    contribution,
    verification: verificationFor(paths),
    todayUtc: '2026-07-12',
  }));
});

test('assertBundledProviderVerificationV1 rejects the retired colon-form contribution key', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture',
    contribution,
    verification: {
      ...verificationFor(paths),
      contributionKey: 'happier.provider.fixture:providers:fixture',
    },
    todayUtc: '2026-07-12',
  }), /contributionKey/);
});

test('automatic legacy-profile migration facts require verified evidence while experimental capability and binding facts remain allowed', () => {
  const contributionWithMigration = {
    ...contribution,
    legacyProfileMigrations: [{
      sourceProfileId: 'fixture',
      descriptorRevision: 1,
      implicitModelAliasReplacements: [],
      primaryModel: {
        agentTargetKey: 'agent:fixture',
        legacyEnvVarName: 'FIXTURE_MODEL',
        defaultModelId: 'fixture-model',
      },
      migratedEnvironmentVariables: [{ name: 'FIXTURE_MODEL', value: 'fixture-model' }],
      retainedEnvironmentVariables: [],
    }],
  };
  const paths = collectProviderExecutableFactPathsV1(contributionWithMigration);
  const migrationPath = 'legacyProfileMigrations.fixture.primaryModel';
  const experimentalMigration = verificationFor(paths);
  experimentalMigration.facts = experimentalMigration.facts.map((fact) => (
    fact.path === migrationPath ? { ...fact, status: 'experimental' } : fact
  ));

  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture',
    contribution: contributionWithMigration,
    verification: experimentalMigration,
    todayUtc: '2026-07-12',
  }), /Automatic Provider migration fact .* must be verified/);

  const experimentalRuntimeEvidence = verificationFor(paths);
  experimentalRuntimeEvidence.facts = experimentalRuntimeEvidence.facts.map((fact) => (
    fact.path === 'endpointTemplates.fixture-openai.capabilities.statefulResponses'
      || fact.path === 'compatibilityOverrides.agent:fixture.openai-chat'
      ? { ...fact, status: 'experimental' }
      : fact
  ));
  assert.doesNotThrow(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture',
    contribution: contributionWithMigration,
    verification: experimentalRuntimeEvidence,
    todayUtc: '2026-07-12',
  }));
});

test('assertBundledProviderVerificationV1 rejects missing, orphaned, and duplicate fact coverage', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution,
    verification: verificationFor(paths.slice(1)), todayUtc: '2026-07-12',
  }), /Missing Provider verification/);

  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution,
    verification: verificationFor([...paths, 'catalog.staticModels.deleted-model']), todayUtc: '2026-07-12',
  }), /Orphaned Provider verification/);

  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution,
    verification: {
      ...verificationFor(paths),
      facts: [...verificationFor(paths).facts, verificationFor(paths).facts[0]],
    },
    todayUtc: '2026-07-12',
  }), /Duplicate Provider verification/);
});

test('closure fails independently for unevidenced endpoint, model, auth, discovery, and binding facts', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  for (const missingPath of [
    'endpointTemplates.fixture-openai.localUrlCandidates',
    'catalog.staticModels.fixture-model',
    'credential.transports.fixture-bearer',
    'discovery.availabilityProbe',
    'compatibilityOverrides.agent:fixture.openai-chat',
  ]) {
    assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      pluginId: 'happier.provider.fixture', contribution,
      verification: verificationFor(paths.filter((path) => path !== missingPath)),
      todayUtc: '2026-07-12',
    }), new RegExp(`Missing Provider verification for .*${missingPath.replaceAll('.', '\\.')}`));
  }
});

test('assertBundledProviderVerificationV1 rejects stale identity, unknown sources, and duplicated executable values', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.other', contribution,
    verification: verificationFor(paths), todayUtc: '2026-07-12',
  }), /contributionKey/);

  const unknownSource = verificationFor(paths);
  unknownSource.facts[0] = { ...unknownSource.facts[0], sourceIds: ['missing-source'] };
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution,
    verification: unknownSource, todayUtc: '2026-07-12',
  }), /unknown evidence source/);

  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution,
    verification: { ...verificationFor(paths), endpointTemplates: contribution.endpointTemplates },
    todayUtc: '2026-07-12',
  }), /must not restate executable Provider facts/);
});

test('assertBundledProviderVerificationV1 validates canonical dates and official HTTPS sources', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  const future = verificationFor(paths);
  future.sources[0] = { ...future.sources[0], accessedAt: '2026-07-13' };
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution, verification: future, todayUtc: '2026-07-12',
  }), /future/);

  const insecure = verificationFor(paths);
  insecure.sources[0] = { ...insecure.sources[0], url: 'http://example.com/docs' };
  assert.throws(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution, verification: insecure, todayUtc: '2026-07-12',
  }), /HTTPS/);
});

test('assertBundledProviderVerificationV1 accepts repository evidence without inventing a public URL', () => {
  const paths = collectProviderExecutableFactPathsV1(contribution);
  const repositoryEvidence = verificationFor(paths);
  repositoryEvidence.sources[0] = {
    id: 'legacy-source',
    kind: 'repository-history',
    locator: 'packages/plugins/fixture/src/profiles.ts',
    accessedAt: '2026-07-12',
    revision: 'pre-provider-migration',
  };
  repositoryEvidence.facts = repositoryEvidence.facts.map((fact) => ({
    ...fact,
    sourceIds: ['legacy-source'],
  }));
  assert.doesNotThrow(() => assertBundledProviderVerificationV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    pluginId: 'happier.provider.fixture', contribution,
    verification: repositoryEvidence, todayUtc: '2026-07-12',
  }));
});

test('readAndAssertBundledProviderVerificationsV1 requires exactly one record per bundled contribution', () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'happier-provider-verification-'));
  const verificationDir = resolve(rootDir, 'packages/plugins/fixture/src/provider/verification');
  mkdirSync(verificationDir, { recursive: true });

  assert.throws(() => readAndAssertBundledProviderVerificationsV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    rootDir,
    pluginPackageId: 'fixture',
    pluginId: 'happier.provider.fixture',
    contributions: [contribution],
    todayUtc: '2026-07-12',
  }), /Missing Provider verification/);

  writeFileSync(
    resolve(verificationDir, 'fixture.json'),
    `${JSON.stringify(verificationFor(collectProviderExecutableFactPathsV1(contribution)))}\n`,
    'utf8',
  );
  assert.equal(readAndAssertBundledProviderVerificationsV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    rootDir,
    pluginPackageId: 'fixture',
    pluginId: 'happier.provider.fixture',
    contributions: [contribution],
    todayUtc: '2026-07-12',
  }).length, 1);

  writeFileSync(
    resolve(verificationDir, 'orphan.json'),
    `${JSON.stringify({ ...verificationFor([]), contributionKey: 'happier.provider.fixture/orphan' })}\n`,
    'utf8',
  );
  assert.throws(() => readAndAssertBundledProviderVerificationsV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
    rootDir,
    pluginPackageId: 'fixture',
    pluginId: 'happier.provider.fixture',
    contributions: [contribution],
    todayUtc: '2026-07-12',
  }), /Orphaned Provider verification record/);
});

test('all bundled first-party Provider contributions have complete current verification records', async () => {
  const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
  const specs = [
    ['deepseek', 'happier.provider.deepseek', 'DEEPSEEK_PROVIDER_CONTRIBUTION'],
    ['zai', 'happier.provider.zai', 'ZAI_PROVIDER_CONTRIBUTION'],
    ['openrouter', 'happier.provider.openrouter', 'OPENROUTER_PROVIDER_CONTRIBUTION'],
    ['ollama', 'happier.provider.ollama', 'OLLAMA_PROVIDER_CONTRIBUTION'],
    ['lmstudio', 'happier.provider.lmstudio', 'LMSTUDIO_PROVIDER_CONTRIBUTION'],
    ['cliproxyapi', 'happier.provider.cliproxyapi', 'CLIPROXYAPI_PROVIDER_CONTRIBUTION'],
    ['openai-models', 'happier.provider.openai', 'OPENAI_PROVIDER_CONTRIBUTION'],
    ['claude', 'happier.agent.claude', 'ANTHROPIC_PROVIDER_CONTRIBUTION'],
  ] as const;
  for (const [pluginPackageId, pluginId, exportName] of specs) {
    const module = await import(`../../../packages/plugins/${pluginPackageId}/src/provider/contribution.ts`);
    assert.equal(readAndAssertBundledProviderVerificationsV1({
    buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      rootDir,
      pluginPackageId,
      pluginId,
      contributions: [module[exportName]],
      todayUtc: '2026-08-10',
    }).length, 1);
  }
});
