import { randomBytes, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as nodeIsDeepStrictEqual } from 'node:util';

import {
  DaemonContributionRegistryProjectionDescribeResponseSchema,
} from '@happier-dev/protocol';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  assertPackedPackageIdentity,
  buildVerticalADaemonRestartArgs,
  loadPackedAuthorVerticalAArtifacts,
  materializePackedCli,
  prepareVerticalAChildEnvironment,
  readPackedPackageManifest,
  runPackedCli,
  runPackedCliJson,
  runPackedReviewedPluginInstall,
  sha512Sri,
  startCandidateRegistry,
  type PackedAuthorArtifactAdmission,
  type PackedAuthorDirectArtifactsSmoke,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { createTestAuth } from '../testkit/auth';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import { sanitizeDaemonEnvForSpawn } from '../testkit/daemon/daemon';
import { callEncryptedMachineRpc } from '../testkit/memoryRpc';
import {
  decideAuthenticatedPluginInstallReview,
} from '../testkit/pluginPlatform/authenticatedInstallReview';
import { startServerLight, type StartedServer } from '../testkit/process/serverLight';
import { createUserScopedSocketCollector, type SocketCollector } from '../testkit/socketClient';
import { waitFor } from '../testkit/timing';
import { waitForDaemonMachineIdFromCliSettings } from '../testkit/uiE2e/daemonMachineId';

const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const PLUGIN_UI_PACKAGE_NAME = '@happier-dev/plugin-ui';
const APP_CLIENT_PLATFORMS = ['web', 'ios', 'android'] as const;
const PACKED_TARGETED_FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/plugin-platform/packed-targeted-contribution-projection',
);

export const PACKED_TARGETED_CONTRIBUTION_FIXTURE = Object.freeze({
  targetPluginId: 'examples.packed-targeted-projection-target',
  contributorPluginId: 'examples.packed-targeted-projection-contributor',
  pointId: 'providers',
  protocolId: 'packed-targeted-projection',
  contributionId: 'github',
  actionId: 'setup',
  clientActionId: 'inspect-context',
  webOnlyClientActionId: 'inspect-web-only',
  writesLocalClientActionId: 'apply-local-effect',
  clientArtifactId: 'packed-client-runtime',
  voiceProviderId: 'packed-conversation',
  rendererId: 'provider-detail',
  appPageId: 'packed-provider-page',
});

type JsonRecord = Record<string, unknown>;

type PackedTargetedDescriptorSemanticBaseline = Readonly<{
  descriptor: JsonRecord;
}>;

type PackedTargetedContributionProjectionEvidence = Readonly<{
  target: Readonly<{
    pluginId: string;
    immutableGenerationId: string;
  }>;
  contributor: Readonly<{
    pluginId: string;
    contributionId: string;
    immutableGenerationId: string;
  }>;
  renderer: Readonly<{
    pluginId: string;
    localId: string;
  }>;
}>;

export type PackedTargetedContributionProjectionResult = Readonly<{
  ok: true;
  scenario: 'targeted-contribution-mounted-projection';
  candidate: Readonly<{
    runId: string;
    sdk: Readonly<{ packageName: string; version: string; integrity: string }>;
    pluginUi: Readonly<{
      packageName: string;
      version: string;
      integrity: string;
    }>;
    cli: Readonly<{ packageName: string; version: string; integrity: string }>;
  }>;
  artifactAdmission: PackedAuthorArtifactAdmission | undefined;
  evidence: Readonly<{
    targetGeneration: string;
    contributorGeneration: string;
    target: PackedTargetedContributionProjectionEvidence['target'];
    contributor: PackedTargetedContributionProjectionEvidence['contributor'];
    renderer: PackedTargetedContributionProjectionEvidence['renderer'];
    coldRestart: true;
  }>;
  cleanup: Readonly<{ disposition: 'removed' }>;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
  return nodeIsDeepStrictEqual(normalize(left), normalize(right));
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label}_must_be_an_object`);
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}_must_be_an_array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}_must_be_a_non_empty_string`);
  }
  return value;
}

function assertPackedCommandSucceeded(
  result: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>,
  label: string,
): void {
  if (result.code === 0 && result.signal === null) return;
  throw new Error(`${label}_failed:${result.stdout}${result.stderr}`);
}

function expectedTargetedInputSchema(): JsonRecord {
  return {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { reviewId: { type: 'string' } },
    required: ['reviewId'],
    additionalProperties: false,
  };
}

function expectedProtocol(): Readonly<{ id: string; version: number }> {
  return {
    id: PACKED_TARGETED_CONTRIBUTION_FIXTURE.protocolId,
    version: 1,
  };
}

function expectedBuiltInTargetedDescriptor(): JsonRecord {
  return { providerId: 'github' };
}

function expectedPackedClientTarget(): JsonRecord {
  return {
    artifactId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientArtifactId,
    modulePath: './clientRuntime',
    exportName: 'activate',
  };
}

function expectedPackedClientActionInputSchema(): JsonRecord {
  return {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      delayMs: { type: 'integer', minimum: 0, maximum: 60_000 },
    },
    additionalProperties: false,
  };
}

export function assertPackedTargetedClientBoundaryManifest(manifest: unknown): void {
  const contributes = requireRecord(
    requireRecord(manifest, 'packed_targeted_client_manifest').contributes,
    'packed_targeted_client_manifest_contributes',
  );
  const actions = requireArray(
    contributes.actions,
    'packed_targeted_client_manifest_actions',
  ).map((value, index) => requireRecord(value, `packed_targeted_client_action_${index}`));
  const clientAction = actions.find(
    (action) => action.id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientActionId,
  );
  const expectedTarget = expectedPackedClientTarget();
  if (
    !clientAction
    || !isDeepStrictEqual(clientAction.surfaces, ['ui', 'voice'])
    || !isDeepStrictEqual(clientAction.inputSchema, expectedPackedClientActionInputSchema())
    || !isDeepStrictEqual(clientAction.execution, {
      target: 'client',
      client: expectedTarget,
      platforms: APP_CLIENT_PLATFORMS,
    })
  ) {
    throw new Error('packed_targeted_client_action_boundary_invalid');
  }

  const webOnlyClientAction = actions.find(
    (action) => action.id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.webOnlyClientActionId,
  );
  if (
    !webOnlyClientAction
    || !isDeepStrictEqual(webOnlyClientAction.surfaces, ['ui', 'voice'])
    || !isDeepStrictEqual(webOnlyClientAction.execution, {
      target: 'client',
      client: expectedTarget,
      platforms: ['web'],
    })
  ) {
    throw new Error('packed_targeted_web_only_client_action_boundary_invalid');
  }

  const writesLocalClientAction = actions.find(
    (action) => action.id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.writesLocalClientActionId,
  );
  if (
    !writesLocalClientAction
    || !isDeepStrictEqual(writesLocalClientAction.surfaces, ['ui'])
    || writesLocalClientAction.dangerLevel !== 'writesLocal'
    || !isDeepStrictEqual(writesLocalClientAction.confirmation, {
      title: 'Apply packed local change?',
      body: 'This navigates only the invoking client within the packed fixture.',
      confirmLabel: 'Apply change',
    })
    || !isDeepStrictEqual(writesLocalClientAction.execution, {
      target: 'client',
      client: expectedTarget,
      platforms: APP_CLIENT_PLATFORMS,
    })
  ) {
    throw new Error('packed_targeted_writes_local_client_action_boundary_invalid');
  }

  const voiceProviders = requireArray(
    contributes.voiceProviders,
    'packed_targeted_client_manifest_voice_providers',
  ).map((value, index) => requireRecord(value, `packed_targeted_voice_provider_${index}`));
  const voiceProvider = voiceProviders.find(
    (provider) => provider.id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId,
  );
  if (
    !voiceProvider
    || !isDeepStrictEqual(voiceProvider.platforms, APP_CLIENT_PLATFORMS)
    || !isDeepStrictEqual(voiceProvider.client, expectedTarget)
    || !isDeepStrictEqual(voiceProvider.capabilities, {
      turn: { cancelResponse: false, bargeIn: false },
      tools: { effectCalls: 'stable_ids' },
    })
  ) {
    throw new Error('packed_targeted_voice_provider_boundary_invalid');
  }

  const ui = requireRecord(contributes.ui, 'packed_targeted_client_manifest_ui');
  const renderers = requireArray(
    ui.renderers,
    'packed_targeted_client_manifest_renderers',
  ).map((value, index) => requireRecord(value, `packed_targeted_renderer_${index}`));
  const renderer = renderers.find(
    (candidate) => candidate.id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
  );
  if (!renderer || !isDeepStrictEqual(renderer, {
    id: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
    kind: 'reactNative',
    artifact: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
    requiredHostMethods: ['executeAction', 'publishCurrentUiContext'],
  })) {
    throw new Error('packed_targeted_context_renderer_boundary_invalid');
  }

  const views = requireArray(
    ui.views,
    'packed_targeted_client_manifest_views',
  ).map((value, index) => requireRecord(value, `packed_targeted_view_${index}`));
  const appPage = views.find(
    (view) => view.id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.appPageId,
  );
  if (!appPage || !isDeepStrictEqual(appPage, {
    id: PACKED_TARGETED_CONTRIBUTION_FIXTURE.appPageId,
    container: 'appPage',
    target: { kind: 'app' },
    renderer: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
    title: 'Packed targeted provider',
    instancePolicy: 'singleton',
    headerActions: [],
  })) {
    throw new Error('packed_targeted_context_app_page_boundary_invalid');
  }
}

function assertExactTarget(value: unknown, targetGeneration: string): void {
  const target = requireRecord(value, 'targeted_projection_target');
  if (
    target.pluginId !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId
    || target.immutableGenerationId !== targetGeneration
    || !isDeepStrictEqual(Object.keys(target).sort(), ['immutableGenerationId', 'pluginId'])
  ) {
    throw new Error('targeted_projection_target_generation_invalid');
  }
}

function assertExactContributor(value: unknown, contributorGeneration: string): void {
  const contributor = requireRecord(value, 'targeted_projection_contributor');
  if (
    contributor.pluginId !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId
    || contributor.contributionId !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributionId
    || contributor.immutableGenerationId !== contributorGeneration
    || !isDeepStrictEqual(
      Object.keys(contributor).sort(),
      ['contributionId', 'immutableGenerationId', 'pluginId'],
    )
  ) {
    throw new Error('targeted_projection_contributor_generation_invalid');
  }
}

/**
 * Validates the one production RPC response consumed by the mounted Targeted
 * Surface host. Keeping these checks at the response boundary makes a fake
 * local decoder, registry injection, or identity-only admission endpoint
 * insufficient to satisfy the packed proof.
 */
export function assertMountedTargetedContributionProjection(params: Readonly<{
  projection: unknown;
  targetGeneration: string;
  contributorGeneration: string;
  machineId: string;
  builtInSemanticDescriptor?: unknown;
}>): PackedTargetedContributionProjectionEvidence {
  const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(
    params.projection,
  );
  if (!parsed.success) {
    throw new Error(`targeted_projection_response_invalid:${parsed.error.message}`);
  }

  if (parsed.data.projection.v !== 2) {
    throw new Error('targeted_projection_generation_unavailable');
  }

  const targeted = parsed.data.targetedContributions;
  if (!targeted) throw new Error('targeted_projection_public_snapshot_missing');
  assertExactTarget(targeted.target, params.targetGeneration);

  if (targeted.points.length !== 1) {
    throw new Error('targeted_projection_public_point_count_invalid');
  }
  const point = targeted.points[0];
  if (!point || point.pointId !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId) {
    throw new Error('targeted_projection_public_point_invalid');
  }
  if (point.protocols.length !== 1) {
    throw new Error('targeted_projection_public_protocol_count_invalid');
  }
  const protocolSnapshot = point.protocols[0];
  if (!protocolSnapshot || !isDeepStrictEqual(protocolSnapshot.protocol, expectedProtocol())) {
    throw new Error('targeted_projection_public_protocol_invalid');
  }
  if (protocolSnapshot.contributions.length !== 1) {
    throw new Error('targeted_projection_public_contributor_count_invalid');
  }
  const contribution = protocolSnapshot.contributions[0];
  if (!contribution) throw new Error('targeted_projection_public_contribution_missing');
  assertExactContributor(contribution.contributor, params.contributorGeneration);
  if (!isDeepStrictEqual(contribution.protocol, expectedProtocol())) {
    throw new Error('targeted_projection_contributor_protocol_invalid');
  }
  const builtInSemanticDescriptor = params.builtInSemanticDescriptor === undefined
    ? expectedBuiltInTargetedDescriptor()
    : requireRecord(
      params.builtInSemanticDescriptor,
      'targeted_projection_built_in_semantic_descriptor',
    );
  if (!isDeepStrictEqual(contribution.descriptor, builtInSemanticDescriptor)) {
    throw new Error('targeted_projection_external_built_in_semantic_mismatch');
  }
  if (contribution.operations.length !== 1) {
    throw new Error('targeted_projection_operation_count_invalid');
  }
  const operation = contribution.operations[0];
  if (!operation) throw new Error('targeted_projection_operation_missing');
  if (
    operation.role !== 'setup'
    || !isDeepStrictEqual(operation.point, {
      pointId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId,
      protocol: expectedProtocol(),
    })
    || !isDeepStrictEqual(operation.contributor, contribution.contributor)
    || !isDeepStrictEqual(operation.action, {
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.actionId,
    })
  ) {
    throw new Error('targeted_projection_operation_role_invalid');
  }
  if (contribution.surfaces.length !== 1) {
    throw new Error('targeted_projection_public_surface_count_invalid');
  }
  const publicSurface = contribution.surfaces[0];
  if (
    !publicSurface
    || !isDeepStrictEqual(publicSurface, {
      point: {
        pointId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId,
        protocol: expectedProtocol(),
      },
      contributor: contribution.contributor,
      role: 'detail',
      presentation: 'content',
    })
  ) {
    throw new Error('targeted_projection_public_surface_handle_invalid');
  }

  const mounts = parsed.data.targetedSurfaceMounts;
  if (!mounts || mounts.length !== 1) {
    throw new Error('targeted_surface_mount_count_invalid');
  }
  const mount = mounts[0];
  if (!mount) throw new Error('targeted_surface_mount_missing');
  if (
    mount.kind !== 'targetedSurface'
    || !isDeepStrictEqual(mount.target, targeted.target)
    || !isDeepStrictEqual(mount.point, publicSurface.point)
    || !isDeepStrictEqual(mount.contributor, contribution.contributor)
    || mount.role !== publicSurface.role
    || mount.presentation !== publicSurface.presentation
  ) {
    throw new Error('targeted_surface_mount_identity_invalid');
  }
  if (!isDeepStrictEqual(mount.inputSchema, expectedTargetedInputSchema())) {
    throw new Error('targeted_surface_input_schema_invalid');
  }
  const expectedRenderer = {
    pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
    localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
  };
  if (!isDeepStrictEqual(mount.rendererChain, [expectedRenderer])) {
    throw new Error('targeted_surface_renderer_chain_invalid');
  }
  const selectedRenderer = mount.selectedRenderer.renderer;
  if (
    !isDeepStrictEqual(mount.selectedRenderer.identity, expectedRenderer)
    || selectedRenderer.kind !== 'reactNative'
    || selectedRenderer.contributionId !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId
    || mount.selectedRenderer.availability.state !== 'available'
  ) {
    throw new Error('targeted_surface_selected_react_native_renderer_invalid');
  }
  if (
    mount.executionOrigin.materializationRef.machineId !== params.machineId
    || mount.executionOrigin.materializationRef.pluginId
      !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId
    || mount.executionOrigin.materializationRef.materializationId.trim().length === 0
    || mount.executionOrigin.serverIdentityId.trim().length === 0
  ) {
    throw new Error('targeted_surface_execution_origin_invalid');
  }
  if (!isDeepStrictEqual(mount.contributorTargetedContributions, {
    target: {
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      immutableGenerationId: params.contributorGeneration,
    },
    points: [],
  })) {
    throw new Error('targeted_surface_contributor_currentness_invalid');
  }

  return Object.freeze({
    target: Object.freeze({ ...targeted.target }),
    contributor: Object.freeze({ ...contribution.contributor }),
    renderer: Object.freeze({ ...expectedRenderer }),
  });
}

function contributionRecords(installed: unknown, label: string): readonly JsonRecord[] {
  const plugin = requireRecord(installed, `${label}_plugin`);
  const contributions = requireRecord(plugin.contributions, `${label}_contributions`);
  return requireArray(contributions.contributions, `${label}_contribution_records`).map(
    (record, index) => requireRecord(record, `${label}_contribution_${index}`),
  );
}

function findContributionRecord(
  records: readonly JsonRecord[],
  family: string,
  localId: string,
): JsonRecord | null {
  for (const record of records) {
    const contribution = record.contribution;
    if (!isRecord(contribution)) continue;
    if (contribution.family === family && contribution.localId === localId) return record;
  }
  return null;
}

function assertContributionIsColdStatic(
  record: JsonRecord | null,
  errorCode: string,
): void {
  if (!record) throw new Error(`${errorCode}_missing`);
  const registration = isRecord(record.registration) ? record.registration : null;
  const activation = isRecord(record.activation) ? record.activation : null;
  if (
    registration?.requirement !== 'notRequired'
    || registration.state !== 'notRequired'
    || activation?.state !== 'notRequired'
  ) {
    throw new Error(errorCode);
  }
}

/**
 * The target point and contributor targeted declaration are static admission
 * facts. The contributor still owns an Action, but that Action cannot make the
 * target-local mount projection require activation.
 */
export function assertColdTargetedContributionRecords(params: Readonly<{
  targetInstalled: unknown;
  contributorInstalled: unknown;
}>): void {
  assertContributionIsColdStatic(
    findContributionRecord(
      contributionRecords(params.targetInstalled, 'target'),
      'pluginContributionPoints',
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId,
    ),
    'targeted_point_activation_required',
  );
  assertContributionIsColdStatic(
    findContributionRecord(
      contributionRecords(params.contributorInstalled, 'contributor'),
      'targetedPluginContributions',
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributionId,
    ),
    'targeted_contribution_activation_required',
  );
  const action = findContributionRecord(
    contributionRecords(params.contributorInstalled, 'contributor'),
    'actions',
    PACKED_TARGETED_CONTRIBUTION_FIXTURE.actionId,
  );
  if (!action) throw new Error('targeted_contributor_action_missing');
  const activation = isRecord(action.activation) ? action.activation : null;
  if (activation?.state !== 'dormant') {
    throw new Error('targeted_contributor_action_activated');
  }
  assertContributionIsColdStatic(
    findContributionRecord(
      contributionRecords(params.contributorInstalled, 'contributor'),
      'actions',
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientActionId,
    ),
    'targeted_client_action_daemon_activation_required',
  );
  assertContributionIsColdStatic(
    findContributionRecord(
      contributionRecords(params.contributorInstalled, 'contributor'),
      'actions',
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.webOnlyClientActionId,
    ),
    'targeted_web_only_client_action_daemon_activation_required',
  );
  assertContributionIsColdStatic(
    findContributionRecord(
      contributionRecords(params.contributorInstalled, 'contributor'),
      'actions',
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.writesLocalClientActionId,
    ),
    'targeted_writes_local_client_action_daemon_activation_required',
  );
  assertContributionIsColdStatic(
    findContributionRecord(
      contributionRecords(params.contributorInstalled, 'contributor'),
      'voiceProviders',
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId,
    ),
    'targeted_voice_provider_daemon_activation_required',
  );
}

async function readJsonRecord(path: string, label: string): Promise<JsonRecord> {
  try {
    return requireRecord(JSON.parse(await readFile(path, 'utf8')), label);
  } catch (error) {
    throw new Error(`${label}_invalid_json`, { cause: error });
  }
}

async function writeJsonRecord(path: string, value: JsonRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function rewriteExternalContributorManifestForColdSemanticParity(
  manifest: JsonRecord,
): Readonly<{
  manifest: JsonRecord;
  builtInSemanticBaseline: PackedTargetedDescriptorSemanticBaseline;
}> {
  const contributes = requireRecord(
    manifest.contributes,
    'packed_targeted_contributor_manifest_contributes',
  );
  const declarations = requireArray(
    contributes.targetedPluginContributions,
    'packed_targeted_contributor_manifest_targeted_contributions',
  );
  if (declarations.length !== 1) {
    throw new Error('packed_targeted_contributor_manifest_targeted_contribution_count_invalid');
  }
  const declaration = requireRecord(
    declarations[0],
    'packed_targeted_contributor_manifest_targeted_contribution',
  );
  if (
    declaration.id !== PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributionId
    || !isDeepStrictEqual(declaration.target, {
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
      pointId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId,
    })
    || !isDeepStrictEqual(declaration.protocol, expectedProtocol())
  ) {
    throw new Error('packed_targeted_contributor_manifest_targeted_contribution_identity_invalid');
  }
  const descriptor = requireRecord(
    declaration.descriptor,
    'packed_targeted_contributor_manifest_descriptor',
  );
  const builtInSemanticDescriptor = { ...descriptor };
  if (!isDeepStrictEqual(builtInSemanticDescriptor, expectedBuiltInTargetedDescriptor())) {
    throw new Error('packed_targeted_built_in_semantic_descriptor_invalid');
  }

  // `definePlugin` emits the descriptor a bundled target would already see.
  // Add only a legal additive-open field to the separately packed external
  // contributor manifest. The fresh cold daemon must route that input through
  // the target's same semantic decoder and expose the original baseline.
  const externalDescriptor = {
    ...builtInSemanticDescriptor,
    ignoredByTargetParser: true,
  };
  return {
    manifest: {
      ...manifest,
      contributes: {
        ...contributes,
        targetedPluginContributions: declarations.map((candidate, index) => (
          index === 0
            ? { ...declaration, descriptor: externalDescriptor }
            : candidate
        )),
      },
    },
    builtInSemanticBaseline: {
      descriptor: builtInSemanticDescriptor,
    },
  };
}

async function prepareExternalContributorManifestForColdSemanticParity(
  projectRoot: string,
): Promise<PackedTargetedDescriptorSemanticBaseline> {
  const manifestPath = join(projectRoot, '.happier-plugin', 'plugin.json');
  const generatedManifest = await readJsonRecord(
    manifestPath,
    'packed_targeted_contributor_manifest',
  );
  assertPackedTargetedClientBoundaryManifest(generatedManifest);
  const rewritten = rewriteExternalContributorManifestForColdSemanticParity(generatedManifest);
  await writeJsonRecord(manifestPath, rewritten.manifest);
  return rewritten.builtInSemanticBaseline;
}

function isPublicFixtureImport(specifier: string): boolean {
  return specifier.startsWith('./')
    || specifier === SDK_PACKAGE_NAME
    || specifier.startsWith(`${SDK_PACKAGE_NAME}/`)
    || specifier === PLUGIN_UI_PACKAGE_NAME
    || specifier.startsWith(`${PLUGIN_UI_PACKAGE_NAME}/`)
    || specifier === 'react';
}

export async function assertPackedTargetedFixtureSourcesArePublicOnly(): Promise<void> {
  const publicProtocolPath = join(PACKED_TARGETED_FIXTURE_ROOT, 'public-protocol.ts');
  const targetSourcePath = join(
    PACKED_TARGETED_FIXTURE_ROOT,
    'target',
    'src',
    'index.ts',
  );
  const contributorSourcePath = join(
    PACKED_TARGETED_FIXTURE_ROOT,
    'contributor',
    'src',
    'index.ts',
  );
  const clientRuntimeSourcePath = join(
    PACKED_TARGETED_FIXTURE_ROOT,
    'contributor',
    'src',
    'clientRuntime.ts',
  );
  const providerDetailSourcePath = join(
    PACKED_TARGETED_FIXTURE_ROOT,
    'contributor',
    'ui',
    'providerDetail.native.tsx',
  );
  const providerDetailActionFailureSourcePath = join(
    PACKED_TARGETED_FIXTURE_ROOT,
    'contributor',
    'ui',
    'providerDetailActionFailure.ts',
  );
  const pluginUiBuildSourcePath = join(
    PACKED_TARGETED_FIXTURE_ROOT,
    'contributor',
    'pluginUiBuild.ts',
  );
  const sourcePaths = [
    publicProtocolPath,
    targetSourcePath,
    contributorSourcePath,
    clientRuntimeSourcePath,
    providerDetailSourcePath,
    providerDetailActionFailureSourcePath,
    pluginUiBuildSourcePath,
  ];
  for (const path of sourcePaths) {
    const source = await readFile(path, 'utf8');
    if (
      /\bglobalThis\b/u.test(source)
      || /@happier-dev\/protocol(?:\/|['"])/u.test(source)
      || /workspace:/u.test(source)
      || /from\s+['"]@\//u.test(source)
      || /packages\/|apps\/cli/u.test(source)
    ) {
      throw new Error(`packed_targeted_fixture_source_is_not_public_only:${path}`);
    }
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]);
    if (imports.some((specifier) => !isPublicFixtureImport(specifier))) {
      throw new Error(`packed_targeted_fixture_has_non_public_import:${path}`);
    }
  }

  const targetSource = await readFile(targetSourcePath, 'utf8');
  const contributorSource = await readFile(contributorSourcePath, 'utf8');
  const clientRuntimeSource = await readFile(clientRuntimeSourcePath, 'utf8');
  const providerDetailSource = await readFile(providerDetailSourcePath, 'utf8');
  const providerDetailActionFailureSource = await readFile(providerDetailActionFailureSourcePath, 'utf8');
  const pluginUiBuildSource = await readFile(pluginUiBuildSourcePath, 'utf8');
  const protocolSource = await readFile(publicProtocolPath, 'utf8');
  if (
    !targetSource.includes('definePlugin')
    || !targetSource.includes('contributionPoints')
    || !contributorSource.includes('definePlugin')
    || !contributorSource.includes('contributesTo')
    || !contributorSource.includes('actions')
    || !contributorSource.includes('defineProtocolNumber')
    || !contributorSource.includes('clientActionInputSchema')
    || !contributorSource.includes("surfaces: ['ui', 'voice']")
    || !contributorSource.includes("platforms: ['web', 'ios', 'android']")
    || !contributorSource.includes("platforms: ['web']")
    || !contributorSource.includes("dangerLevel: 'writesLocal'")
    || !contributorSource.includes('confirmation')
    || !contributorSource.includes('voiceProviders')
    || !contributorSource.includes("effectCalls: 'stable_ids'")
    || !contributorSource.includes("container: 'appPage'")
    || !contributorSource.includes("id: 'packed-provider-page'")
    || !clientRuntimeSource.includes("api.actions.register('inspect-context'")
    || !clientRuntimeSource.includes("api.actions.register('inspect-web-only'")
    || !clientRuntimeSource.includes("api.actions.register('apply-local-effect'")
    || !clientRuntimeSource.includes("api.voiceProviders.register('packed-conversation'")
    || !clientRuntimeSource.includes("import { throwIfAborted } from '@happier-dev/plugin-sdk/async';")
    || /\b[A-Za-z_$][\w$]*\.throwIfAborted\(/u.test(clientRuntimeSource)
    || (clientRuntimeSource.match(/\bthrowIfAborted\(/gu)?.length ?? 0) !== 5
    || !clientRuntimeSource.includes('currentUiContext')
    || !clientRuntimeSource.includes('readCurrentUiContext')
    || !clientRuntimeSource.includes('invokeCurrentUiCommand')
    || !clientRuntimeSource.includes('packed_voice_completion')
    || !providerDetailSource.includes('publishCurrentUiContext')
    || !providerDetailSource.includes('hostApi.executeAction')
    || !providerDetailSource.includes("kind: 'executeAction'")
    || !providerDetailSource.includes("action: 'inspect-context'")
    || !providerDetailSource.includes('classifyActionFailure')
    || !providerDetailActionFailureSource.includes("import { isPluginError } from '@happier-dev/plugin-sdk';")
    || !providerDetailActionFailureSource.includes('isPluginError(error)')
    || providerDetailActionFailureSource.includes("'code' in error")
    || providerDetailActionFailureSource.includes('Array.isArray(error)')
    || providerDetailActionFailureSource.includes("typeof error !== 'object'")
    || !providerDetailSource.includes('return () => hostApi.publishCurrentUiContext(null)')
    || !providerDetailSource.includes('packed-targeted-provider-title')
    || !providerDetailSource.includes('packed-targeted-context-action')
    || !providerDetailSource.includes('packed-targeted-context-result')
    || !providerDetailSource.includes('packed-targeted-context-invocation-count')
    || !providerDetailSource.includes('packed-targeted-stale-context-action')
    || !providerDetailSource.includes('packed-targeted-web-only-context-action')
    || !providerDetailSource.includes('packed-targeted-web-only-context-result')
    || !providerDetailSource.includes('packed-targeted-writes-local-action')
    || !providerDetailSource.includes('packed-targeted-writes-local-result')
    || !clientRuntimeSource.includes('packed_targeted_fixture_action_cancelled')
    || !clientRuntimeSource.includes('delayMs')
    || !pluginUiBuildSource.includes("rendererId: 'packed-client-runtime'")
    || !pluginUiBuildSource.includes("rendererId: 'provider-detail'")
    || (pluginUiBuildSource.match(/platforms: \['web', 'ios', 'android'\]/gu)?.length ?? 0) !== 2
    || !protocolSource.includes('defineContributionProtocol')
    || !protocolSource.includes("policy: 'additive-open/drop'")
    || !protocolSource.includes('descriptor')
    || !protocolSource.includes('operations')
    || !protocolSource.includes('surfaces')
    || !contributorSource.includes('ignoredByTargetParser')
  ) {
    throw new Error('packed_targeted_fixture_contract_source_missing');
  }

  for (const packageName of ['target', 'contributor']) {
    const manifest = await readJsonRecord(
      join(PACKED_TARGETED_FIXTURE_ROOT, packageName, 'package.json'),
      `packed_targeted_${packageName}_package`,
    );
    const dependencies = requireRecord(
      manifest.dependencies,
      `packed_targeted_${packageName}_dependencies`,
    );
    if (
      typeof dependencies[SDK_PACKAGE_NAME] !== 'string'
      || (
        packageName === 'contributor'
        && typeof dependencies[PLUGIN_UI_PACKAGE_NAME] !== 'string'
      )
      || Object.values(dependencies).some((dependency) => (
        typeof dependency === 'string' && dependency.startsWith('workspace:')
      ))
    ) {
      throw new Error(`packed_targeted_${packageName}_package_is_not_external`);
    }
  }
}

async function prepareExternalTargetedFixture(params: Readonly<{
  fixtureName: 'target' | 'contributor';
  root: string;
  candidate: PackedAuthorDirectArtifactsSmoke;
}>): Promise<void> {
  await cp(join(PACKED_TARGETED_FIXTURE_ROOT, params.fixtureName), params.root, {
    recursive: true,
    force: false,
  });
  await cp(
    join(PACKED_TARGETED_FIXTURE_ROOT, 'public-protocol.ts'),
    join(params.root, 'src', 'protocol.ts'),
    { force: false },
  );
  const packagePath = join(params.root, 'package.json');
  const packageJson = await readJsonRecord(
    packagePath,
    `packed_targeted_${params.fixtureName}_package`,
  );
  const dependencies = requireRecord(
    packageJson.dependencies,
    `packed_targeted_${params.fixtureName}_dependencies`,
  );
  await writeJsonRecord(packagePath, {
    ...packageJson,
    dependencies: {
      ...dependencies,
      [SDK_PACKAGE_NAME]: params.candidate.sdk.version,
      ...(params.fixtureName === 'contributor'
        ? { [PLUGIN_UI_PACKAGE_NAME]: params.candidate.pluginUi.version }
        : {}),
    },
  });
}

async function assertInstalledCandidateAuthorPackages(params: Readonly<{
  projectRoot: string;
  candidate: PackedAuthorDirectArtifactsSmoke;
  fixtureName: 'target' | 'contributor';
}>): Promise<void> {
  const artifacts = params.fixtureName === 'contributor'
    ? [['SDK', params.candidate.sdk], ['Plugin UI', params.candidate.pluginUi]] as const
    : [['SDK', params.candidate.sdk]] as const;
  for (const [label, artifact] of artifacts) {
    const packageRoot = await realpath(join(
      params.projectRoot,
      'node_modules',
      ...artifact.packageName.split('/'),
    ));
    assertPackedPackageIdentity(
      await readJsonRecord(
        join(packageRoot, 'package.json'),
        `packed_targeted_installed_${label.toLowerCase().replaceAll(' ', '_')}`,
      ),
      artifact,
      `Packed Targeted Contribution external author ${label}`,
    );
  }
}

async function authorAndPackExternalTargetedFixture(params: Readonly<{
  archivePath: string;
  candidate: PackedAuthorDirectArtifactsSmoke;
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fixtureName: 'target' | 'contributor';
  projectRoot: string;
  registryOrigin: string;
}>): Promise<PackedTargetedDescriptorSemanticBaseline | undefined> {
  const installation = await runPackedCliJson({
    cliEntrypoint: params.cliEntrypoint,
    cwd: params.cwd,
    env: params.env,
    args: [
      'plugins', 'author', 'install', params.projectRoot,
      '--sdk-registry', params.registryOrigin,
      '--json',
    ],
  }, 'plugins_author_install');
  const installationData = requireRecord(
    requireRecord(installation, 'packed_targeted_author_install').data,
    'packed_targeted_author_install_data',
  );
  if (
    installationData.operation !== 'install'
    || installationData.projectRoot !== params.projectRoot
  ) {
    throw new Error('packed_targeted_author_install_did_not_admit_project');
  }
  await assertInstalledCandidateAuthorPackages({
    projectRoot: params.projectRoot,
    candidate: params.candidate,
    fixtureName: params.fixtureName,
  });

  for (const operation of ['typecheck', 'build']) {
    const result = await runPackedCliJson({
      cliEntrypoint: params.cliEntrypoint,
      cwd: params.cwd,
      env: params.env,
      args: ['plugins', 'author', operation, params.projectRoot, '--json'],
    }, `plugins_author_${operation}`);
    const data = requireRecord(
      requireRecord(result, `packed_targeted_author_${operation}`).data,
      `packed_targeted_author_${operation}_data`,
    );
    if (data.operation !== operation || data.projectRoot !== params.projectRoot) {
      throw new Error(`packed_targeted_author_${operation}_did_not_complete`);
    }
  }

  const builtInSemanticBaseline = params.fixtureName === 'contributor'
    ? await prepareExternalContributorManifestForColdSemanticParity(params.projectRoot)
    : undefined;

  await mkdir(dirname(params.archivePath), { recursive: true });
  await runPackedCliJson({
    cliEntrypoint: params.cliEntrypoint,
    cwd: params.cwd,
    env: params.env,
    args: [
      'plugins', 'pack', params.projectRoot,
      '--out', params.archivePath,
      '--json',
    ],
  }, 'plugins_pack');
  if ((await readFile(params.archivePath)).byteLength === 0) {
    throw new Error('packed_targeted_fixture_archive_empty');
  }
  return builtInSemanticBaseline;
}

function assertCommittedPluginInstall(
  installation: unknown,
  pluginId: string,
  label: string,
  expectedApplication: 'dormant' | 'applied',
): string {
  const record = requireRecord(installation, label);
  const change = requireRecord(record.change, `${label}_change`);
  const generation = requireString(change.desiredGeneration, `${label}_desired_generation`);
  if (
    change.kind !== 'committed'
    || change.pluginId !== pluginId
    || change.appliedGeneration !== (expectedApplication === 'applied' ? generation : null)
    || !Array.isArray(change.pendingSurfaces)
    || change.pendingSurfaces.length !== 0
  ) {
    throw new Error(`${label}_did_not_commit_current_generation`);
  }
  return generation;
}

function assertInstalledPluginCurrent(
  installed: unknown,
  pluginId: string,
  generation: string,
  label: string,
  expectedApplication: 'dormant' | 'applied',
): void {
  const record = requireRecord(installed, label);
  if (
    record.pluginId !== pluginId
    || record.enabled !== true
    || record.desiredGeneration !== generation
    || record.appliedGeneration !== (expectedApplication === 'applied' ? generation : null)
  ) {
    throw new Error(`${label}_not_current`);
  }
}

function selectNoOptionalInstallAccess(review: unknown): readonly Readonly<{
  accessId: string;
  selected: boolean;
}>[] {
  const facts = requireRecord(review, 'packed_targeted_install_review');
  if (
    typeof facts.pluginId !== 'string'
    || facts.pluginId.length === 0
    || typeof facts.displayName !== 'string'
    || facts.displayName.length === 0
  ) {
    throw new Error('packed_targeted_install_review_facts_invalid');
  }
  return requireArray(facts.optionalHostAccess, 'packed_targeted_install_review_access')
    .map((access, index) => {
      const record = requireRecord(access, `packed_targeted_install_review_access_${index}`);
      return { accessId: requireString(record.id, 'packed_targeted_install_review_access_id'), selected: false };
    });
}

async function readInstalledPlugin(params: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginId: string;
}>): Promise<JsonRecord> {
  const response = await runPackedCliJson({
    cliEntrypoint: params.cliEntrypoint,
    cwd: params.cwd,
    env: params.env,
    args: ['plugins', 'show', params.pluginId, '--json'],
  }, 'plugins_show');
  const data = requireRecord(
    requireRecord(response, 'packed_targeted_plugins_show').data,
    'packed_targeted_plugins_show_data',
  );
  return requireRecord(data.plugin, 'packed_targeted_plugins_show_plugin');
}

export function assertColdRestart(result: Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  beforeDaemonPid: number;
  afterDaemonPid: number;
}>): void {
  assertPackedCommandSucceeded(result, 'packed_targeted_daemon_restart');
  const envelope = requireRecord(JSON.parse(result.stdout), 'packed_targeted_daemon_restart');
  if (
    envelope.ok !== true
    || envelope.status !== 'restarted'
    || !Number.isInteger(result.beforeDaemonPid)
    || result.beforeDaemonPid <= 0
    || !Number.isInteger(result.afterDaemonPid)
    || result.afterDaemonPid <= 0
    || result.afterDaemonPid === result.beforeDaemonPid
  ) {
    throw new Error('packed_targeted_daemon_restart_did_not_replace_runtime');
  }
}

async function readPackedTargetedDaemonPid(params: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): Promise<number> {
  const result = await runPackedCli({
    cliEntrypoint: params.cliEntrypoint,
    cwd: params.cwd,
    env: params.env,
    args: ['daemon', 'status', '--json'],
  });
  assertPackedCommandSucceeded(result, 'packed_targeted_daemon_status');
  const snapshot = requireRecord(
    JSON.parse(result.stdout),
    'packed_targeted_daemon_status',
  );
  const daemon = requireRecord(snapshot.daemon, 'packed_targeted_daemon_status_daemon');
  const daemonPid = daemon.pid;
  if (
    daemon.running !== true
    || typeof daemonPid !== 'number'
    || !Number.isInteger(daemonPid)
    || daemonPid <= 0
  ) {
    throw new Error('packed_targeted_daemon_status_missing_running_pid');
  }
  return daemonPid;
}

export async function runPackedTargetedContributionProjection(
  candidate: PackedAuthorDirectArtifactsSmoke,
  options: Readonly<{
    artifactAdmission?: PackedAuthorArtifactAdmission;
  }> = {},
): Promise<PackedTargetedContributionProjectionResult> {
  await assertPackedTargetedFixtureSourcesArePublicOnly();
  const tempRoot = await mkdtemp(join(
    tmpdir(),
    `happier-packed-targeted-projection-${candidate.runId}-`,
  ));
  let server: StartedServer | null = null;
  let registry: Awaited<ReturnType<typeof startCandidateRegistry>> | null = null;
  let cliEntrypoint: string | null = null;
  let childEnv: NodeJS.ProcessEnv | null = null;
  let ui: SocketCollector | null = null;
  let daemonStopped = false;
  try {
    const [sdkBytes, pluginUiBytes, cliBytes] = await Promise.all([
      readFile(candidate.sdk.tarballPath),
      readFile(candidate.pluginUi.tarballPath),
      readFile(candidate.cli.tarballPath),
    ]);
    if (sha512Sri(sdkBytes) !== candidate.sdk.integrity) {
      throw new Error('packed_targeted_sdk_artifact_integrity_mismatch');
    }
    if (sha512Sri(cliBytes) !== candidate.cli.integrity) {
      throw new Error('packed_targeted_cli_artifact_integrity_mismatch');
    }
    if (sha512Sri(pluginUiBytes) !== candidate.pluginUi.integrity) {
      throw new Error('packed_targeted_plugin_ui_artifact_integrity_mismatch');
    }
    const [sdkManifest, pluginUiManifest] = await Promise.all([
      readPackedPackageManifest(
        candidate.sdk.tarballPath,
        join(tempRoot, 'sdk-artifact'),
      ),
      readPackedPackageManifest(
        candidate.pluginUi.tarballPath,
        join(tempRoot, 'plugin-ui-artifact'),
      ),
    ]);
    assertPackedPackageIdentity(
      sdkManifest,
      candidate.sdk,
      'Packed Targeted Contribution SDK',
    );
    assertPackedPackageIdentity(
      pluginUiManifest,
      candidate.pluginUi,
      'Packed Targeted Contribution Plugin UI',
    );
    const candidateRegistry = await startCandidateRegistry({
      packages: [
        {
          ...candidate.sdk,
          bytes: sdkBytes,
          packageManifest: sdkManifest,
        },
        {
          ...candidate.pluginUi,
          bytes: pluginUiBytes,
          packageManifest: pluginUiManifest,
        },
      ],
    });
    registry = candidateRegistry;
    const packedCliEntrypoint = await materializePackedCli({
      cliArtifact: candidate.cli,
      installRoot: join(tempRoot, 'cli-install'),
      env: sanitizeDaemonEnvForSpawn(process.env),
    });
    cliEntrypoint = packedCliEntrypoint;

    const databaseUrl = renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(tempRoot, 'server-light-data', 'happier-server-light.sqlite'),
      platform: process.platform,
      sqlite: { connectionLimit: 4 },
    });
    const startedServer = await startServerLight({
      testDir: tempRoot,
      dbProvider: 'sqlite',
      extraEnv: { DATABASE_URL: databaseUrl },
    });
    server = startedServer;
    const auth = await createTestAuth(startedServer.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));
    const happyHomeDir = join(tempRoot, 'happier-home');
    const isolatedChildEnv = await prepareVerticalAChildEnvironment({
      happyHomeDir,
      markerPath: join(tempRoot, 'targeted-projection.marker'),
      baseEnv: sanitizeDaemonEnvForSpawn(process.env),
      prepareHome: async ({ happyHomeDir: isolatedHome }) => {
        const packedBinDir = join(isolatedHome, 'packed-targeted-projection-bin');
        await mkdir(packedBinDir, { recursive: true });
        await seedCliAuthForServer({
          cliHome: isolatedHome,
          serverUrl: startedServer.baseUrl,
          token: auth.token,
          secret,
        });
        return {
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_SERVER_URL: startedServer.baseUrl,
          HAPPIER_WEBAPP_URL: startedServer.baseUrl,
          PATH: packedBinDir,
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID:
            `packed-targeted-projection-${randomUUID()}`.slice(0, 64),
        };
      },
    });
    childEnv = isolatedChildEnv;
    const authorEnv = { ...isolatedChildEnv };
    delete authorEnv.HAPPIER_VERTICAL_A_MARKER;
    const fixtureRoot = join(tempRoot, 'external-author');
    const targetRoot = join(fixtureRoot, 'target');
    const contributorRoot = join(fixtureRoot, 'contributor');
    await mkdir(fixtureRoot, { recursive: true });
    await Promise.all([
      prepareExternalTargetedFixture({
        fixtureName: 'target',
        root: targetRoot,
        candidate,
      }),
      prepareExternalTargetedFixture({
        fixtureName: 'contributor',
        root: contributorRoot,
        candidate,
      }),
    ]);

    const installArchive = async (archivePath: string): Promise<unknown> => await runPackedReviewedPluginInstall({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: ['plugins', 'install', archivePath, '--json'],
      decideInstallReview: async ({ happyHomeDir: reviewHome, pendingChangeId, review }) => (
        await decideAuthenticatedPluginInstallReview({
          cliHomeDir: reviewHome,
          serverUrl: startedServer.baseUrl,
          pendingChangeId,
          optionalSelections: selectNoOptionalInstallAccess(review),
          confirmPresentUser: async () => true,
        })
      ),
    });

    const targetArchivePath = join(tempRoot, 'archives', 'target.happier-plugin.tgz');
    await authorAndPackExternalTargetedFixture({
      archivePath: targetArchivePath,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      fixtureName: 'target',
      projectRoot: targetRoot,
      registryOrigin: candidateRegistry.origin,
    });
    const targetGeneration = assertCommittedPluginInstall(
      await installArchive(targetArchivePath),
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
      'packed_targeted_target_install',
      'dormant',
    );

    const contributorArchivePath = join(tempRoot, 'archives', 'contributor.happier-plugin.tgz');
    const builtInSemanticBaseline = await authorAndPackExternalTargetedFixture({
      archivePath: contributorArchivePath,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      fixtureName: 'contributor',
      projectRoot: contributorRoot,
      registryOrigin: candidateRegistry.origin,
    });
    if (!builtInSemanticBaseline) {
      throw new Error('packed_targeted_built_in_semantic_baseline_missing');
    }
    const contributorGeneration = assertCommittedPluginInstall(
      await installArchive(contributorArchivePath),
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      'packed_targeted_contributor_install',
      'applied',
    );

    const targetInstalled = await readInstalledPlugin({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
    });
    const contributorInstalled = await readInstalledPlugin({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
    });
    assertInstalledPluginCurrent(
      targetInstalled,
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
      targetGeneration,
      'packed_targeted_target_before_restart',
      'dormant',
    );
    assertInstalledPluginCurrent(
      contributorInstalled,
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      contributorGeneration,
      'packed_targeted_contributor_before_restart',
      'applied',
    );
    assertColdTargetedContributionRecords({ targetInstalled, contributorInstalled });

    const daemonBeforeRestart = await readPackedTargetedDaemonPid({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
    });
    const restart = await runPackedCli({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: buildVerticalADaemonRestartArgs(),
    });
    const daemonAfterRestart = await readPackedTargetedDaemonPid({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
    });
    assertColdRestart({
      ...restart,
      beforeDaemonPid: daemonBeforeRestart,
      afterDaemonPid: daemonAfterRestart,
    });

    const targetAfterRestart = await readInstalledPlugin({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
    });
    const contributorAfterRestart = await readInstalledPlugin({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
    });
    assertInstalledPluginCurrent(
      targetAfterRestart,
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
      targetGeneration,
      'packed_targeted_target_after_restart',
      'dormant',
    );
    assertInstalledPluginCurrent(
      contributorAfterRestart,
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      contributorGeneration,
      'packed_targeted_contributor_after_restart',
      'applied',
    );
    assertColdTargetedContributionRecords({
      targetInstalled: targetAfterRestart,
      contributorInstalled: contributorAfterRestart,
    });

    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir: happyHomeDir });
    ui = createUserScopedSocketCollector(startedServer.baseUrl, auth.token, {
      captureEvents: false,
    });
    ui.connect();
    await waitFor(() => ui?.isConnected() === true, {
      timeoutMs: 20_000,
      context: 'packed targeted contribution projection user socket',
    });
    const projection = await callEncryptedMachineRpc({
      ui,
      machineId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      req: {
        machineId,
        mountedTarget: {
          pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
          immutableGenerationId: targetGeneration,
        },
      },
      secret,
      schema: DaemonContributionRegistryProjectionDescribeResponseSchema,
    });
    const mountedEvidence = assertMountedTargetedContributionProjection({
      projection,
      targetGeneration,
      contributorGeneration,
      machineId,
      builtInSemanticDescriptor: builtInSemanticBaseline.descriptor,
    });
    const targetAfterMountedProjection = await readInstalledPlugin({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
    });
    const contributorAfterMountedProjection = await readInstalledPlugin({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
    });
    assertInstalledPluginCurrent(
      targetAfterMountedProjection,
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
      targetGeneration,
      'packed_targeted_target_after_mounted_projection',
      'dormant',
    );
    assertInstalledPluginCurrent(
      contributorAfterMountedProjection,
      PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      contributorGeneration,
      'packed_targeted_contributor_after_mounted_projection',
      'applied',
    );
    assertColdTargetedContributionRecords({
      targetInstalled: targetAfterMountedProjection,
      contributorInstalled: contributorAfterMountedProjection,
    });

    const stop = await runPackedCli({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: ['daemon', 'stop'],
    });
    assertPackedCommandSucceeded(stop, 'packed_targeted_daemon_stop');
    daemonStopped = true;

    return {
      ok: true,
      scenario: 'targeted-contribution-mounted-projection',
      candidate: {
        runId: candidate.runId,
        sdk: {
          packageName: candidate.sdk.packageName,
          version: candidate.sdk.version,
          integrity: candidate.sdk.integrity,
        },
        pluginUi: {
          packageName: candidate.pluginUi.packageName,
          version: candidate.pluginUi.version,
          integrity: candidate.pluginUi.integrity,
        },
        cli: {
          packageName: candidate.cli.packageName,
          version: candidate.cli.version,
          integrity: candidate.cli.integrity,
        },
      },
      artifactAdmission: options.artifactAdmission,
      evidence: {
        targetGeneration,
        contributorGeneration,
        ...mountedEvidence,
        coldRestart: true,
      },
      cleanup: { disposition: 'removed' },
    };
  } finally {
    ui?.close();
    if (cliEntrypoint && childEnv && !daemonStopped) {
      await runPackedCli({
        cliEntrypoint,
        cwd: tempRoot,
        env: childEnv,
        args: ['daemon', 'stop'],
      }).catch(() => undefined);
    }
    await registry?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const startedAt = new Date().toISOString();
  let candidate: PackedAuthorDirectArtifactsSmoke | null = null;
  let artifactAdmission: PackedAuthorArtifactAdmission | undefined;
  try {
    const loaded = await loadPackedAuthorVerticalAArtifacts(argv);
    candidate = loaded.candidate;
    artifactAdmission = loaded.admission;
    const result = await runPackedTargetedContributionProjection(candidate, {
      artifactAdmission,
    });
    process.stdout.write(`${JSON.stringify({
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      scenario: 'targeted-contribution-mounted-projection',
      candidate: candidate === null ? null : {
        runId: candidate.runId,
        sdk: candidate.sdk,
        cli: candidate.cli,
      },
      artifactAdmission,
      error: {
        code: 'packed_targeted_contribution_projection_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      cleanup: { disposition: 'attempted' },
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main();
}
