import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  sanitizeDaemonEnvForSpawn,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  resolveUiWebBeforeAllTimeoutMs,
  startUiWeb,
  type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import {
  attestLoadedBrowserModules,
  buildPackedCandidateBrowserQaRunOutcome,
  observeLoadedBrowserModuleResponses,
  preparePackedUcxWebQa,
  resolvePackedCandidateBrowserQaBeforeAllTimeoutMs,
  type LoadedBrowserModuleAttestation,
  type PreparedPackedUcxWebQa,
} from '../../src/testkit/pluginPlatform/packedCandidateBrowserQa';
import {
  decideAuthenticatedPluginInstallReview,
  readPluginInstallReviewRequiredEnvelope,
  type PluginInstallDecisionOutcome,
} from '../../src/testkit/pluginPlatform/authenticatedInstallReview';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  runCliJson,
  type JsonEnvelope,
  writeRedactedResultArtifact,
} from '../../src/testkit/uiE2e/cliJson';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import {
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedHomeUi,
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import {
  installLocalAgentVoiceSettings,
  startVoiceQaBoundaryServer,
  type VoiceQaBoundaryServer,
} from '../../src/testkit/uiE2e/voiceBrowserQaHarness';

const run = createRunDirs({ runLabel: 'packed-targeted-projection-browser' });
const TARGET_PLUGIN_ID = 'examples.packed-targeted-projection-target';
const CONTRIBUTOR_PLUGIN_ID = 'examples.packed-targeted-projection-contributor';
const APP_PAGE_ID = 'packed-provider-page';
const VOICE_PROVIDER_LOCAL_ID = 'packed-conversation';
const VOICE_PROVIDER_ID = `${CONTRIBUTOR_PLUGIN_ID}/${VOICE_PROVIDER_LOCAL_ID}`;
const VOICE_PROVIDER_ROW_TEST_ID = `settings.voice.provider.${encodeURIComponent(VOICE_PROVIDER_ID)}.default`;
const PACKED_VOICE_COMPLETION_TEXT = 'Packed Voice action completed for packed-provider-detail.';
const PACKED_VOICE_AUTOMATIC_METADATA_TEXT = 'Packed Voice automatic context metadata received.';
const PACKED_VOICE_CURRENT_UI_TOOLS_OFF_TEXT = 'Packed Voice current UI tools: none.';
const PACKED_VOICE_CURRENT_UI_TOOLS_AVAILABLE_TEXT = 'Packed Voice current UI tools: readCurrentUiContext, invokeCurrentUiCommand.';
const TRIAGE_GITHUB_PLUGIN_ID = 'happier.scm.forge.github';
const TRIAGE_GITHUB_CONNECTED_ACCOUNT_LOCAL_ID = 'github-account';
const TRIAGE_GITHUB_VOICE_HANDOFF_MANIFEST_ENV =
  'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST';
const TRIAGE_GITHUB_VOICE_MICROPHONE_FIXTURE_PATH_ENV =
  'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH';
const TRIAGE_GITHUB_VOICE_ADAPTER_ENV =
  'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ADAPTER';
const UCX_WEB_SDK_TARBALL_ENV = 'HAPPIER_E2E_UCX_WEB_SDK_TARBALL';
const UCX_WEB_PLUGIN_UI_TARBALL_ENV =
  'HAPPIER_E2E_UCX_WEB_PLUGIN_UI_TARBALL';
const UCX_WEB_CLI_TARBALL_ENV = 'HAPPIER_E2E_UCX_WEB_CLI_TARBALL';
const candidateManifestPath =
  process.env.HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST?.trim() || null;
const ucxWebSdkTarballPath = process.env[UCX_WEB_SDK_TARBALL_ENV]?.trim() || null;
const ucxWebPluginUiTarballPath =
  process.env[UCX_WEB_PLUGIN_UI_TARBALL_ENV]?.trim() || null;
const ucxWebCliTarballPath = process.env[UCX_WEB_CLI_TARBALL_ENV]?.trim() || null;
const ucxWebRowLocalArtifactPaths = [
  ucxWebSdkTarballPath,
  ucxWebPluginUiTarballPath,
  ucxWebCliTarballPath,
];
const hasUcxWebRowLocalArtifact = ucxWebRowLocalArtifactPaths.some(Boolean);
const hasCompleteUcxWebRowLocalArtifacts =
  ucxWebRowLocalArtifactPaths.every(Boolean);
if (candidateManifestPath !== null && hasUcxWebRowLocalArtifact) {
  throw new Error('packed_candidate_browser_qa_artifact_basis_conflict');
}
if (candidateManifestPath === null && !hasUcxWebRowLocalArtifact) {
  throw new Error('packed_candidate_browser_qa_artifact_basis_required');
}
if (candidateManifestPath === null && !hasCompleteUcxWebRowLocalArtifacts) {
  throw new Error('packed_candidate_browser_qa_row_local_artifacts_required');
}
const triageGithubVoiceHandoffManifestRaw =
  process.env[TRIAGE_GITHUB_VOICE_HANDOFF_MANIFEST_ENV];
const triageGithubVoiceHandoffManifestPath =
  triageGithubVoiceHandoffManifestRaw?.trim() || null;
const triageGithubVoiceMicrophoneFixturePath =
  process.env[TRIAGE_GITHUB_VOICE_MICROPHONE_FIXTURE_PATH_ENV]?.trim() || null;
const triageGithubVoiceAdapterRaw = process.env[TRIAGE_GITHUB_VOICE_ADAPTER_ENV]?.trim() || null;
const triageGithubVoiceAdapter = triageGithubVoiceAdapterRaw === null
  ? (triageGithubVoiceHandoffManifestPath === null ? null : 'external_realtime')
  : triageGithubVoiceAdapterRaw === 'external_realtime'
    || triageGithubVoiceAdapterRaw === 'local_agent'
    ? triageGithubVoiceAdapterRaw
    : null;
if (
  triageGithubVoiceHandoffManifestRaw !== undefined
  && triageGithubVoiceHandoffManifestPath === null
) {
  throw new Error('packed_candidate_browser_qa_triage_github_voice_blocked_handoff_value_required');
}
if (
  triageGithubVoiceHandoffManifestPath !== null
  && triageGithubVoiceAdapter === null
) {
  throw new Error('packed_triage_github_voice_browser_qa_blocked_handoff_adapter_invalid');
}
const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/plugin-platform/packed-targeted-contribution-projection',
);

type CandidateRegistry = Readonly<{
  origin: string;
  close: () => Promise<void>;
}>;

type CandidateRegistryPackage = Readonly<{
  packageName: string;
  version: string;
  integrity: string;
  tarballPath: string;
  bytes: Uint8Array;
  packageManifest?: Record<string, unknown>;
}>;

type CommittedPluginInstallOutcome = PluginInstallDecisionOutcome & Readonly<{
  kind: 'committed';
  pluginId: string;
  desiredGeneration: string;
  pendingSurfaces: readonly string[];
}>;

type CandidateRunnerModule = Readonly<{
  readPackedPackageManifest: (
    tarballPath: string,
    extractionRoot: string,
  ) => Promise<Record<string, unknown>>;
  startCandidateRegistry: (params: Readonly<{
    packages: readonly CandidateRegistryPackage[];
  }>) => Promise<CandidateRegistry>;
}>;

type TriageGithubVoiceQaHandoffBase = Readonly<{
  schemaVersion: 1 | 2;
  github: Readonly<{
    token: string;
    scopeTitle: string;
    issueA: Readonly<{ title: string }>;
    issueB: Readonly<{ title: string }>;
  }>;
}>;

type TriageGithubRealtimeVoiceQaHandoff = TriageGithubVoiceQaHandoffBase & Readonly<{
  schemaVersion: 1;
  voice: Readonly<{
    providerId: string;
    optionId: string;
    credentialSlotId: string;
    credential: string;
    microphoneFixturePath: string;
  }>;
}>;

type TriageGithubLocalAgentVoiceQaHandoff = TriageGithubVoiceQaHandoffBase & Readonly<{
  schemaVersion: 2;
  voice: Readonly<{
    adapterId: 'local_conversation';
    conversationMode: 'agent';
    agentId: 'claude';
    sttProviderId: 'happier.voice.openai-compat/stt';
    microphoneFixturePath: string;
  }>;
}>;

type TriageGithubVoiceQaHandoff =
  | TriageGithubRealtimeVoiceQaHandoff
  | TriageGithubLocalAgentVoiceQaHandoff;

type TriageGithubVoiceQaRunnerModule = Readonly<{
  loadPackedTriageGithubVoiceQaHandoff: (params: Readonly<{
    manifestPath: string;
  }>) => Promise<TriageGithubVoiceQaHandoff>;
  assertPackedTriageGithubVoiceQaCandidate: (params: Readonly<{
    handoff: TriageGithubVoiceQaHandoff;
    candidate: PreparedPackedUcxWebQa['candidate'];
  }>) => TriageGithubVoiceQaHandoff;
  resolvePackedTriageGithubVoiceQaAdapter: (
    handoff: TriageGithubVoiceQaHandoff,
  ) => 'external_realtime' | 'local_agent';
}>;

type AuthoredArchives = Readonly<{
  targetArchivePath: string;
  contributorV1ArchivePath: string;
  contributorV2ArchivePath: string;
  closeRegistry: () => Promise<void>;
}>;

async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`${label}_must_be_object`);
  return record;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}_must_be_non_empty_string`);
  }
  return value;
}

function requireSuccessfulEnvelope(
  envelope: JsonEnvelope,
  expectedKind: string,
): Record<string, unknown> {
  if (envelope.ok !== true || envelope.kind !== expectedKind) {
    throw new Error(
      `packed_targeted_${expectedKind}_failed:${JSON.stringify(envelope)}`,
    );
  }
  return requireRecord(envelope.data, `packed_targeted_${expectedKind}_data`);
}

function replaceExactly(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`packed_targeted_fixture_${label}_marker_invalid`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function buildServerScopedUiUrl(
  uiBaseUrl: string,
  serverBaseUrl: string,
  path: string,
): string {
  const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
  url.searchParams.set('server', serverBaseUrl);
  return url.toString();
}

async function enterVoiceCredentialThroughUi(params: Readonly<{
  page: Page;
  credentialTestId: string;
  value: string;
}>): Promise<void> {
  await params.page.getByTestId(params.credentialTestId).click();
  const input = params.page.getByTestId('web-prompt-input');
  await expect(input).toHaveCount(1, { timeout: 30_000 });
  await input.fill(params.value);
  const confirm = params.page.getByTestId('web-prompt-confirm');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(input).toHaveCount(0, { timeout: 30_000 });
}

type FakeClaudeLogRow = Readonly<Record<string, unknown>>;

async function readFakeClaudeLogRows(logPath: string): Promise<readonly FakeClaudeLogRow[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (error) {
    if (
      error !== null
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
  return raw.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      const value: unknown = JSON.parse(trimmed);
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? [value as FakeClaudeLogRow]
        : [];
    } catch {
      return [];
    }
  });
}

function fakeClaudeProviderPrompts(rows: readonly FakeClaudeLogRow[]): readonly string[] {
  return rows.flatMap((row) => (
    row.type === 'sdk_stdin'
    && row.hasUserText === true
    && typeof row.userText === 'string'
      ? [row.userText]
      : []
  ));
}

async function waitForFakeClaudeLogRow(params: Readonly<{
  logPath: string;
  description: string;
  matches: (row: FakeClaudeLogRow) => boolean;
}>): Promise<void> {
  await expect.poll(async () => {
    const rows = await readFakeClaudeLogRows(params.logPath);
    return rows.some(params.matches);
  }, {
    message: `fake Claude did not receive ${params.description}`,
    timeout: 180_000,
  }).toBe(true);
}

async function setCurrentUiContextPrivacyMode(params: Readonly<{
  page: Page;
  serverBaseUrl: string;
  uiBaseUrl: string;
  mode: 'off' | 'on_demand' | 'automatic';
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(
    params.page,
    buildServerScopedUiUrl(
      params.uiBaseUrl,
      params.serverBaseUrl,
      '/settings/voice/privacy?happier_hmr=0',
    ),
    180_000,
  );
  await waitForAuthenticatedRouteUi({
    page: params.page,
    expectedPathname: '/settings/voice/privacy',
    requiredTestIds: ['settings.voice.section.privacy'],
    timeoutMs: 180_000,
  });
  await params.page.getByTestId('settings.voice.privacy.currentUiContextMode').click();
  const option = params.page.getByTestId(`dropdown-option-${params.mode}`);
  await expect(option).toHaveCount(1, { timeout: 120_000 });
  await option.click();
}

async function setSessionSummaryPrivacy(params: Readonly<{
  page: Page;
  serverBaseUrl: string;
  uiBaseUrl: string;
  enabled: boolean;
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(
    params.page,
    buildServerScopedUiUrl(
      params.uiBaseUrl,
      params.serverBaseUrl,
      '/settings/voice/privacy?happier_hmr=0',
    ),
    180_000,
  );
  await waitForAuthenticatedRouteUi({
    page: params.page,
    expectedPathname: '/settings/voice/privacy',
    requiredTestIds: ['settings.voice.section.privacy'],
    timeoutMs: 180_000,
  });
  const summarySwitch = params.page.getByRole('switch', {
    name: 'Share session summary',
    exact: true,
  });
  await expect(summarySwitch).toHaveCount(1, { timeout: 120_000 });
  const expectedChecked = String(params.enabled);
  if (await summarySwitch.getAttribute('aria-checked') !== expectedChecked) {
    await summarySwitch.click();
  }
  await expect(summarySwitch).toHaveAttribute('aria-checked', expectedChecked, {
    timeout: 120_000,
  });
}

function readFakeClaudeCurrentUiResult(row: FakeClaudeLogRow): Record<string, unknown> | null {
  if (row.type !== 'sdk_stdin' || typeof row.userText !== 'string') return null;
  const marker = 'VOICE_TOOL_RESULTS_JSON:';
  const markerIndex = row.userText.indexOf(marker);
  if (markerIndex < 0) return null;
  try {
    const envelope = asRecord(
      JSON.parse(row.userText.slice(markerIndex + marker.length).trim()),
    );
    const toolResults = envelope?.toolResults;
    if (!Array.isArray(toolResults)) return null;
    const readCurrentUiContext = toolResults.find((toolResult) => (
      asRecord(toolResult)?.t === 'readCurrentUiContext'
    ));
    return asRecord(asRecord(readCurrentUiContext)?.result);
  } catch {
    return null;
  }
}

async function sendNormalLocalAgentVoiceTurn(params: Readonly<{
  page: Page;
  boundary: VoiceQaBoundaryServer;
}>): Promise<void> {
  const before = params.boundary.getTranscriptionRequestCount();
  const toggle = params.page.getByTestId('voice-surface-toggle:sidebar');
  await expect(toggle).toBeEnabled({ timeout: 120_000 });
  await toggle.click();
  await expect(params.page.getByTestId('voice-surface-status:sidebar:connected'))
    .toHaveCount(1, { timeout: 120_000 });
  await expect(params.page.getByTestId('voice-surface-mode:sidebar:listening'))
    .toHaveCount(1, { timeout: 120_000 });
  await toggle.click();
  await expect.poll(
    () => params.boundary.getTranscriptionRequestCount(),
    { timeout: 120_000 },
  ).toBe(before + 1);
}

async function stopNormalLocalAgentVoiceSession(page: Page): Promise<void> {
  const toggle = page.getByTestId('voice-surface-toggle:sidebar');
  await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
    .toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId('voice-surface-mode:sidebar:idle'))
    .toHaveCount(1, { timeout: 120_000 });
  await toggle.click();
  await expect(page.getByTestId('voice-surface-status:sidebar:disconnected'))
    .toHaveCount(1, { timeout: 120_000 });
}

async function prepareExternalFixtureProject(params: Readonly<{
  candidate: PreparedPackedUcxWebQa['candidate'];
  fixtureName: 'target' | 'contributor';
  projectRoot: string;
  version: string;
}>): Promise<void> {
  await cp(join(FIXTURE_ROOT, params.fixtureName), params.projectRoot, {
    recursive: true,
    force: false,
  });
  await cp(
    join(FIXTURE_ROOT, 'public-protocol.ts'),
    join(params.projectRoot, 'src', 'protocol.ts'),
    { force: false },
  );

  const packagePath = join(params.projectRoot, 'package.json');
  const packageJson = requireRecord(
    JSON.parse(await readFile(packagePath, 'utf8')),
    `packed_targeted_${params.fixtureName}_package`,
  );
  const dependencies = requireRecord(
    packageJson.dependencies,
    `packed_targeted_${params.fixtureName}_dependencies`,
  );
  await writeFile(packagePath, `${JSON.stringify({
    ...packageJson,
    version: params.version,
    dependencies: {
      ...dependencies,
      '@happier-dev/plugin-sdk': params.candidate.sdk.version,
      ...(params.fixtureName === 'contributor'
        ? { '@happier-dev/plugin-ui': params.candidate.pluginUi.version }
        : {}),
    },
  }, null, 2)}\n`, 'utf8');

  const entryPath = join(params.projectRoot, 'src', 'index.ts');
  const entry = await readFile(entryPath, 'utf8');
  await writeFile(entryPath, replaceExactly(
    entry,
    "version: '1.0.0',",
    `version: '${params.version}',`,
    `${params.fixtureName}_version`,
  ), 'utf8');

  if (params.fixtureName === 'contributor') {
    const surfacePath = join(params.projectRoot, 'ui', 'providerDetail.native.tsx');
    const surface = await readFile(surfacePath, 'utf8');
    await writeFile(surfacePath, replaceExactly(
      surface,
      'value="Packed provider detail"',
      `value=${JSON.stringify(`Packed provider detail ${params.version}`)}`,
      'contributor_surface_version',
    ), 'utf8');
  }
}

async function authorAndPackFixtureProject(params: Readonly<{
  archivePath: string;
  cliHomeDir: string;
  cliLaunchSpec: PreparedPackedUcxWebQa['cliLaunchSpec'];
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  registryOrigin: string;
  serverUrl: string;
  testDir: string;
  uiBaseUrl: string;
}>): Promise<void> {
  requireSuccessfulEnvelope(await runCliJson({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    env: params.env,
    cliLaunchSpec: params.cliLaunchSpec,
    label: `author-install-${params.projectRoot.split('/').at(-1) ?? 'fixture'}`,
    args: [
      'plugins',
      'author',
      'install',
      params.projectRoot,
      '--sdk-registry',
      params.registryOrigin,
      '--json',
    ],
    timeoutMs: 300_000,
  }), 'plugins_dev_install');
  for (const operation of ['typecheck', 'build'] as const) {
    requireSuccessfulEnvelope(await runCliJson({
      testDir: params.testDir,
      cliHomeDir: params.cliHomeDir,
      serverUrl: params.serverUrl,
      webappUrl: params.uiBaseUrl,
      env: params.env,
      cliLaunchSpec: params.cliLaunchSpec,
      label: `author-${operation}-${params.projectRoot.split('/').at(-1) ?? 'fixture'}`,
      args: ['plugins', 'author', operation, params.projectRoot, '--json'],
      timeoutMs: 300_000,
    }), `plugins_dev_${operation}`);
  }
  requireSuccessfulEnvelope(await runCliJson({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    env: params.env,
    cliLaunchSpec: params.cliLaunchSpec,
    label: `pack-${params.projectRoot.split('/').at(-1) ?? 'fixture'}`,
    args: [
      'plugins',
      'pack',
      params.projectRoot,
      '--out',
      params.archivePath,
      '--json',
    ],
    timeoutMs: 240_000,
  }), 'plugins_pack');
  await access(params.archivePath);
}

async function authorPackedTargetedArchives(params: Readonly<{
  candidate: PreparedPackedUcxWebQa;
  cliHomeDir: string;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  testDir: string;
  uiBaseUrl: string;
}>): Promise<AuthoredArchives> {
  const candidateRunner = await import(
    '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs'
  ) as unknown as CandidateRunnerModule;
  const [sdkBytes, pluginUiBytes] = await Promise.all([
    readFile(params.candidate.candidate.sdk.tarballPath),
    readFile(params.candidate.candidate.pluginUi.tarballPath),
  ]);
  const [sdkPackageManifest, pluginUiPackageManifest] = await Promise.all([
    candidateRunner.readPackedPackageManifest(
      params.candidate.candidate.sdk.tarballPath,
      join(params.testDir, 'verify-sdk'),
    ),
    candidateRunner.readPackedPackageManifest(
      params.candidate.candidate.pluginUi.tarballPath,
      join(params.testDir, 'verify-plugin-ui'),
    ),
  ]);
  const registry = await candidateRunner.startCandidateRegistry({
    packages: [{
      ...params.candidate.candidate.sdk,
      bytes: sdkBytes,
      packageManifest: sdkPackageManifest,
    }, {
      ...params.candidate.candidate.pluginUi,
      bytes: pluginUiBytes,
      packageManifest: pluginUiPackageManifest,
    }],
  });
  try {
    const fixtureRoot = join(params.testDir, 'external-author');
    const targetRoot = join(fixtureRoot, 'target');
    const contributorV1Root = join(fixtureRoot, 'contributor-v1');
    const contributorV2Root = join(fixtureRoot, 'contributor-v2');
    const targetArchivePath = join(params.testDir, 'archives', 'target-v1.tgz');
    const contributorV1ArchivePath = join(params.testDir, 'archives', 'contributor-v1.tgz');
    const contributorV2ArchivePath = join(params.testDir, 'archives', 'contributor-v2.tgz');
    await mkdir(join(params.testDir, 'archives'), { recursive: true });
    await Promise.all([
      prepareExternalFixtureProject({
        candidate: params.candidate.candidate,
        fixtureName: 'target',
        projectRoot: targetRoot,
        version: '1.0.0',
      }),
      prepareExternalFixtureProject({
        candidate: params.candidate.candidate,
        fixtureName: 'contributor',
        projectRoot: contributorV1Root,
        version: '1.0.0',
      }),
      prepareExternalFixtureProject({
        candidate: params.candidate.candidate,
        fixtureName: 'contributor',
        projectRoot: contributorV2Root,
        version: '1.0.1',
      }),
    ]);
    await authorAndPackFixtureProject({
      archivePath: targetArchivePath,
      cliHomeDir: params.cliHomeDir,
      cliLaunchSpec: params.candidate.cliLaunchSpec,
      env: params.env,
      projectRoot: targetRoot,
      registryOrigin: registry.origin,
      serverUrl: params.serverUrl,
      testDir: params.testDir,
      uiBaseUrl: params.uiBaseUrl,
    });
    await authorAndPackFixtureProject({
      archivePath: contributorV1ArchivePath,
      cliHomeDir: params.cliHomeDir,
      cliLaunchSpec: params.candidate.cliLaunchSpec,
      env: params.env,
      projectRoot: contributorV1Root,
      registryOrigin: registry.origin,
      serverUrl: params.serverUrl,
      testDir: params.testDir,
      uiBaseUrl: params.uiBaseUrl,
    });
    await authorAndPackFixtureProject({
      archivePath: contributorV2ArchivePath,
      cliHomeDir: params.cliHomeDir,
      cliLaunchSpec: params.candidate.cliLaunchSpec,
      env: params.env,
      projectRoot: contributorV2Root,
      registryOrigin: registry.origin,
      serverUrl: params.serverUrl,
      testDir: params.testDir,
      uiBaseUrl: params.uiBaseUrl,
    });
    return {
      targetArchivePath,
      contributorV1ArchivePath,
      contributorV2ArchivePath,
      closeRegistry: () => registry.close(),
    };
  } catch (error) {
    await registry.close().catch(() => undefined);
    throw error;
  }
}

async function installReviewedArchive(params: Readonly<{
  archivePath: string;
  cliHomeDir: string;
  cliLaunchSpec: PreparedPackedUcxWebQa['cliLaunchSpec'];
  env: NodeJS.ProcessEnv;
  expectedPluginId: string;
  serverUrl: string;
  testDir: string;
  uiBaseUrl: string;
}>): Promise<CommittedPluginInstallOutcome> {
  const installEnvelope = await runCliJson({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    env: params.env,
    cliLaunchSpec: params.cliLaunchSpec,
    label: `install-${params.expectedPluginId.replaceAll('.', '-')}`,
    args: ['plugins', 'install', params.archivePath, '--json'],
    timeoutMs: 240_000,
    acceptedExitCodes: [1],
  });
  const review = readPluginInstallReviewRequiredEnvelope(installEnvelope);
  expect(review.review.pluginId).toBe(params.expectedPluginId);
  const outcome = await decideAuthenticatedPluginInstallReview({
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    pendingChangeId: review.pendingChangeId,
    optionalSelections: review.review.optionalHostAccess.map((entry) => ({
      accessId: entry.id,
      selected: false,
    })),
    confirmPresentUser: async () => true,
  });
  if (
    outcome.kind !== 'committed'
    || outcome.pluginId !== params.expectedPluginId
    || !outcome.desiredGeneration
    || !Array.isArray(outcome.pendingSurfaces)
    || outcome.pendingSurfaces.length !== 0
  ) {
    throw new Error(`packed_targeted_install_not_committed:${JSON.stringify(outcome)}`);
  }
  return outcome as CommittedPluginInstallOutcome;
}

function requireAppliedInstalledGeneration(
  outcome: CommittedPluginInstallOutcome,
): string {
  if (outcome.appliedGeneration !== outcome.desiredGeneration) {
    throw new Error(`packed_targeted_install_not_applied:${JSON.stringify(outcome)}`);
  }
  return requireNonEmptyString(
    outcome.appliedGeneration,
    'packed_targeted_install_generation',
  );
}

async function forgetPluginTrust(params: Readonly<{
  daemon: StartedDaemon;
  pluginId: string;
}>): Promise<void> {
  const response = await daemonControlPostJson<Readonly<{
    kind?: unknown;
    pluginId?: unknown;
    desiredGeneration?: unknown;
    appliedGeneration?: unknown;
  }>>({
    port: params.daemon.state.httpPort,
    controlToken: params.daemon.state.controlToken,
    path: '/plugins/change/request',
    body: { kind: 'forgetTrust', pluginId: params.pluginId },
  });
  if (
    response.status !== 200
    || response.data.kind !== 'committed'
    || response.data.pluginId !== params.pluginId
    || typeof response.data.desiredGeneration !== 'string'
    || response.data.appliedGeneration !== null
  ) {
    throw new Error(`packed_targeted_forget_trust_failed:${JSON.stringify(response)}`);
  }
}

test.describe('packed candidate: targeted projection app-page client Action', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('packed-targeted-projection-suite');
  const storageScope = `e2e-packed-targeted-projection-${run.runId}`;
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let candidate: PreparedPackedUcxWebQa | null = null;
  let daemon: StartedDaemon | null = null;
  let triageGithubVoiceHandoff: TriageGithubVoiceQaHandoff | null = null;
  let normalTriageLocalAgentJourneyCompleted = false;
  let normalTriageLocalAgentJourneyLoadedModules: LoadedBrowserModuleAttestation | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };
    test.setTimeout(resolvePackedCandidateBrowserQaBeforeAllTimeoutMs({
      candidateManifestPath:
        candidateManifestPath ?? ucxWebSdkTarballPath,
      uiBeforeAllTimeoutMs: resolveUiWebBeforeAllTimeoutMs(uiWebEnv),
    }));
    const preparedCandidate = candidateManifestPath !== null
      ? await preparePackedUcxWebQa({
        artifactBasis: 'candidate_manifest',
        candidateManifestPath,
        materializationRoot: join(suiteDir, 'exact-candidate-cli'),
      })
      : await preparePackedUcxWebQa({
        artifactBasis: 'row_local_natural',
        sdkTarballPath: ucxWebSdkTarballPath
          ?? (() => { throw new Error('packed_candidate_browser_qa_row_local_artifacts_required'); })(),
        pluginUiTarballPath: ucxWebPluginUiTarballPath
          ?? (() => { throw new Error('packed_candidate_browser_qa_row_local_artifacts_required'); })(),
        cliTarballPath: ucxWebCliTarballPath
          ?? (() => { throw new Error('packed_candidate_browser_qa_row_local_artifacts_required'); })(),
        materializationRoot: join(suiteDir, 'exact-candidate-cli'),
      });
    candidate = preparedCandidate;
    if (triageGithubVoiceHandoffManifestPath !== null) {
      const triageGithubVoiceRunner = await import(
        new URL(
          '../../scripts/plugin-platform/run-packed-candidate-browser-qa.mjs',
          import.meta.url,
        ).href,
      ) as unknown as TriageGithubVoiceQaRunnerModule;
      const handoff = await triageGithubVoiceRunner.loadPackedTriageGithubVoiceQaHandoff({
        manifestPath: triageGithubVoiceHandoffManifestPath,
      });
      if (triageGithubVoiceMicrophoneFixturePath !== handoff.voice.microphoneFixturePath) {
        throw new Error(
          'packed_triage_github_voice_browser_qa_blocked_microphone_fixture_mismatch',
        );
      }
      triageGithubVoiceRunner.assertPackedTriageGithubVoiceQaCandidate({
        handoff,
        candidate: preparedCandidate.candidate,
      });
      if (triageGithubVoiceRunner.resolvePackedTriageGithubVoiceQaAdapter(handoff) !== triageGithubVoiceAdapter) {
        throw new Error('packed_triage_github_voice_browser_qa_blocked_handoff_adapter_mismatch');
      }
      triageGithubVoiceHandoff = handoff;
    }
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        HAPPIER_FEATURE_VOICE__ENABLED: '1',
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0',
      },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    daemon = null;
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => undefined);
    await ui?.stop().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await candidate?.cleanup();
    candidate = null;
  });

  if (triageGithubVoiceAdapter === 'external_realtime') {
    test('uses normal Triage, GitHub, and first-party Voice surfaces with the exact requested handoff', async ({ page, browser }) => {
      test.setTimeout(900_000);
      const handoff = triageGithubVoiceHandoff;
      if (!candidate || !server || !uiBaseUrl || !handoff || handoff.schemaVersion !== 1) {
        throw new Error('packed_triage_github_voice_browser_qa_not_ready');
      }

      const testDir = resolve(join(suiteDir, 'triage-github-voice'));
      const cliHomeDir = join(testDir, 'happier-home');
      const cliEnv = sanitizeDaemonEnvForSpawn(process.env);
      await mkdir(cliHomeDir, { recursive: true });
      const auth = await createTestAuth(server.baseUrl);
      await seedCliAuthForTestAccount({
        cliHome: cliHomeDir,
        serverUrl: server.baseUrl,
        auth,
        mode: 'dataKey',
      });
      const authBootstrap = buildAuthBootstrapStorageSnapshot({
        serverUrl: server.baseUrl,
        auth,
        mode: 'dataKey',
        storageScope,
      });
      await installAuthBootstrapStorageSnapshot(page, authBootstrap);
      const daemonEnv = {
        ...cliEnv,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
      };
      daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: daemonEnv,
      });
      expect(daemon.state.startedWithCliVersion).toBe(candidate.attestation.cliVersion);

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });

      const githubConnectedAccountPath =
        `/settings/connected-services/account?pluginId=${TRIAGE_GITHUB_PLUGIN_ID}`
        + `&localId=${TRIAGE_GITHUB_CONNECTED_ACCOUNT_LOCAL_ID}&happier_hmr=0`;
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, githubConnectedAccountPath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/connected-services/account',
        requiredTestIds: ['connected-account-mode:manual'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('connected-account-mode:manual').click();
      const githubToken = page.getByTestId('connected-account-manual:token');
      await expect(githubToken).toBeVisible({ timeout: 120_000 });
      await githubToken.fill(handoff.github.token);
      await page.getByTestId('connected-account-manual:submit').click();

      const githubTriageSourcesPath =
        `/settings/plugins/${TRIAGE_GITHUB_PLUGIN_ID}/triage-sources?happier_hmr=0`;
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, githubTriageSourcesPath),
        180_000,
      );
      const addGithubScope = page.getByRole('button', {
        name: `Add ${handoff.github.scopeTitle} to Happier`,
      });
      await expect(addGithubScope).toBeVisible({ timeout: 180_000 });
      await addGithubScope.click();
      await expect(page.getByText('Added to Happier.', { exact: true }))
        .toBeVisible({ timeout: 180_000 });

      const voiceProviderRowTestId =
        `settings.voice.provider.${encodeURIComponent(handoff.voice.providerId)}`
        + `.${encodeURIComponent(handoff.voice.optionId)}`;
      const voiceCredentialTestId =
        `settings.voice.externalCredential.${encodeURIComponent(handoff.voice.providerId)}`
        + `.${encodeURIComponent(handoff.voice.credentialSlotId)}`;
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/conversations?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/conversations',
        requiredTestIds: ['settings.voice.provider.off', voiceProviderRowTestId],
        timeoutMs: 180_000,
      });
      const voiceProviderRow = page.getByTestId(voiceProviderRowTestId);
      await voiceProviderRow.click();
      await expect(voiceProviderRow).toHaveAttribute('aria-checked', 'true', {
        timeout: 120_000,
      });
      await enterVoiceCredentialThroughUi({
        page,
        credentialTestId: voiceCredentialTestId,
        value: handoff.voice.credential,
      });

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/privacy?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/privacy',
        requiredTestIds: ['settings.voice.section.privacy'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('settings.voice.privacy.currentUiContextMode').click();
      await expect(page.getByTestId('dropdown-option-on_demand'))
        .toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('dropdown-option-on_demand').click();

      const triagePath = '/plugins/happier.triage/triage?happier_hmr=0';
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, triagePath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/plugins/happier.triage/triage',
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      const issueAOption = page.getByRole('option', {
        name: handoff.github.issueA.title,
        exact: true,
      });
      const issueBOption = page.getByRole('option', {
        name: handoff.github.issueB.title,
        exact: true,
      });
      await expect(issueAOption).toHaveCount(1, { timeout: 180_000 });
      await expect(issueBOption).toHaveCount(1, { timeout: 180_000 });
      await issueAOption.click();
      await expect(issueAOption).toHaveAttribute('aria-selected', 'true', {
        timeout: 120_000,
      });
      await expect(issueBOption).toHaveAttribute('aria-selected', 'false', {
        timeout: 120_000,
      });

      let secondContext: BrowserContext | null = null;
      try {
        // The Voice attempt is bound to the primary client. This independently
        // authenticated client begins on A to falsify cross-client navigation.
        secondContext = await browser.newContext();
        const secondPage = await secondContext.newPage();
        await installAuthBootstrapStorageSnapshot(secondPage, authBootstrap);
        await gotoDomContentLoadedWithRetries(
          secondPage,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
          180_000,
        );
        await waitForAuthenticatedHomeUi({ page: secondPage, timeoutMs: 180_000 });
        await gotoDomContentLoadedWithRetries(
          secondPage,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, triagePath),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page: secondPage,
          expectedPathname: '/plugins/happier.triage/triage',
          requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
          timeoutMs: 180_000,
        });
        const secondIssueAOption = secondPage.getByRole('option', {
          name: handoff.github.issueA.title,
          exact: true,
        });
        const secondIssueBOption = secondPage.getByRole('option', {
          name: handoff.github.issueB.title,
          exact: true,
        });
        await expect(secondIssueAOption).toHaveCount(1, { timeout: 180_000 });
        await expect(secondIssueBOption).toHaveCount(1, { timeout: 180_000 });
        await secondIssueAOption.click();
        await expect(secondIssueAOption).toHaveAttribute('aria-selected', 'true', {
          timeout: 120_000,
        });
        await expect(secondIssueBOption).toHaveAttribute('aria-selected', 'false', {
          timeout: 120_000,
        });

        await page.getByTestId('voice-surface-toggle:sidebar').click();
        await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
          .toHaveCount(1, { timeout: 120_000 });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'true', {
          timeout: 240_000,
        });
        await expect(issueAOption).toHaveAttribute('aria-selected', 'false', {
          timeout: 120_000,
        });
        await expect(secondIssueAOption).toHaveAttribute('aria-selected', 'true', {
          timeout: 120_000,
        });
        await expect(secondIssueBOption).toHaveAttribute('aria-selected', 'false', {
          timeout: 120_000,
        });

        // The semantic open-B command must retain ordinary browser history.
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: '/plugins/happier.triage/triage',
          requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
          timeoutMs: 180_000,
        });
        await expect(issueAOption).toHaveAttribute('aria-selected', 'true', {
          timeout: 120_000,
        });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'false', {
          timeout: 120_000,
        });
        await expect(secondIssueAOption).toHaveAttribute('aria-selected', 'true', {
          timeout: 120_000,
        });
        await expect(secondIssueBOption).toHaveAttribute('aria-selected', 'false', {
          timeout: 120_000,
        });
      } finally {
        await secondContext?.close().catch(() => undefined);
      }
    });
  }

  if (triageGithubVoiceAdapter === 'local_agent') {
    test('uses normal Triage Local Agent Voice surfaces with real STT and fake-Claude provider boundaries', async ({ page, browser }) => {
      test.setTimeout(900_000);
      const handoff = triageGithubVoiceHandoff;
      if (!candidate || !server || !uiBaseUrl || !handoff || handoff.schemaVersion !== 2) {
        throw new Error('packed_triage_github_local_agent_browser_qa_not_ready');
      }

      const testDir = resolve(join(suiteDir, 'triage-github-local-agent-voice'));
      const cliHomeDir = join(testDir, 'happier-home');
      const fakeClaudeLogPath = join(testDir, 'fake-claude.jsonl');
      const delayedCurrentUiReleaseFile = join(testDir, 'release-delayed-current-ui-command');
      const cliEnv = sanitizeDaemonEnvForSpawn(process.env);
      let boundary: VoiceQaBoundaryServer | null = null;
      let secondContext: BrowserContext | null = null;
      normalTriageLocalAgentJourneyLoadedModules = null;
      const normalTriageLocalAgentJourneyModuleResponses =
        observeLoadedBrowserModuleResponses(page);
      try {
        boundary = await startVoiceQaBoundaryServer({
          // This is a fixed construction-time response sequence. Each normal
          // microphone capture crosses the same real STT boundary; no route can
          // mutate the next transcript while a Voice attempt is live.
          transcriptionTexts: [
            'UCX_VOICE_READ_A',
            'UCX_VOICE_OFF',
            'UCX_VOICE_READ_A',
            'UCX_VOICE_OPEN_B',
            'UCX_VOICE_DELAYED_STALE_A',
            'UCX_VOICE_AUTOMATIC_READY',
          ],
        });
        await mkdir(cliHomeDir, { recursive: true });
        const auth = await createTestAuth(server.baseUrl);
        const seeded = await seedCliAuthForTestAccount({
          cliHome: cliHomeDir,
          serverUrl: server.baseUrl,
          auth,
          mode: 'dataKey',
        });
        await installLocalAgentVoiceSettings({
          authToken: auth.token,
          baseUrl: server.baseUrl,
          machineId: seeded.machineId,
          accountSettingsMaterial: { type: 'dataKey', machineKey: auth.accountMachineKey },
          sttBaseUrl: `${boundary.baseUrl}/v1`,
        });
        const authBootstrap = buildAuthBootstrapStorageSnapshot({
          serverUrl: server.baseUrl,
          auth,
          mode: 'dataKey',
          storageScope,
        });
        await installAuthBootstrapStorageSnapshot(page, authBootstrap);
        const daemonEnv = {
          ...cliEnv,
          CI: '1',
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'voice-current-ui-triage',
          HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE:
            delayedCurrentUiReleaseFile,
        };
        daemon = await startTestDaemon({
          testDir,
          happyHomeDir: cliHomeDir,
          cliLaunchSpec: candidate.cliLaunchSpec,
          env: daemonEnv,
        });
        expect(daemon.state.startedWithCliVersion).toBe(candidate.attestation.cliVersion);

        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
          180_000,
        );
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });

        const githubConnectedAccountPath =
          `/settings/connected-services/account?pluginId=${TRIAGE_GITHUB_PLUGIN_ID}`
          + `&localId=${TRIAGE_GITHUB_CONNECTED_ACCOUNT_LOCAL_ID}&happier_hmr=0`;
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, githubConnectedAccountPath),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: '/settings/connected-services/account',
          requiredTestIds: ['connected-account-mode:manual'],
          timeoutMs: 180_000,
        });
        await page.getByTestId('connected-account-mode:manual').click();
        const githubToken = page.getByTestId('connected-account-manual:token');
        await expect(githubToken).toBeVisible({ timeout: 120_000 });
        await githubToken.fill(handoff.github.token);
        await page.getByTestId('connected-account-manual:submit').click();

        const githubTriageSourcesPath =
          `/settings/plugins/${TRIAGE_GITHUB_PLUGIN_ID}/triage-sources?happier_hmr=0`;
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, githubTriageSourcesPath),
          180_000,
        );
        const addGithubScope = page.getByRole('button', {
          name: `Add ${handoff.github.scopeTitle} to Happier`,
        });
        await expect(addGithubScope).toBeVisible({ timeout: 180_000 });
        await addGithubScope.click();
        await expect(page.getByText('Added to Happier.', { exact: true }))
          .toBeVisible({ timeout: 180_000 });

        const privateSessionPrompt = `UCX private Session ${run.runId}`;
        const privateSessionId = await createSessionFromNewSessionComposer({
          page,
          uiBaseUrl,
          machineId: seeded.machineId,
          prompt: privateSessionPrompt,
        });
        await setSessionSummaryPrivacy({
          page,
          serverBaseUrl: server.baseUrl,
          uiBaseUrl,
          enabled: false,
        });
        await setCurrentUiContextPrivacyMode({
          page,
          serverBaseUrl: server.baseUrl,
          uiBaseUrl,
          mode: 'on_demand',
        });
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(
            uiBaseUrl,
            server.baseUrl,
            `/session/${privateSessionId}?happier_hmr=0`,
          ),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: `/session/${privateSessionId}`,
          requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
          timeoutMs: 180_000,
        });
        await sendNormalLocalAgentVoiceTurn({ page, boundary });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the privacy-gated Session current-UI read result',
          matches: (row) => (
            asRecord(readFakeClaudeCurrentUiResult(row)?.navigation)?.area
              === 'session'
          ),
        });
        const privateSessionCurrentUiResult = (await readFakeClaudeLogRows(
          fakeClaudeLogPath,
        ))
          .map(readFakeClaudeCurrentUiResult)
          .find((result) => asRecord(result?.navigation)?.area === 'session');
        if (!privateSessionCurrentUiResult) {
          throw new Error('packed_triage_github_voice_browser_qa_session_context_missing');
        }
        const privateSessionNavigation = requireRecord(
          privateSessionCurrentUiResult.navigation,
          'packed_triage_github_voice_browser_qa_session_navigation',
        );
        expect(privateSessionNavigation).toMatchObject({ area: 'session' });
        expect(Object.hasOwn(privateSessionNavigation, 'title')).toBe(false);
        expect(JSON.stringify(privateSessionCurrentUiResult))
          .not.toContain(privateSessionPrompt);
        await stopNormalLocalAgentVoiceSession(page);

        const triagePath = '/plugins/happier.triage/triage?happier_hmr=0';
        const triageUiBaseUrl = uiBaseUrl;
        const triageServerBaseUrl = server.baseUrl;
        const openTriage = async () => {
          await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(
              triageUiBaseUrl,
              triageServerBaseUrl,
              triagePath,
            ),
            180_000,
          );
          await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/plugins/happier.triage/triage',
            requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
            timeoutMs: 180_000,
          });
          const issueAOption = page.getByRole('option', {
            name: handoff.github.issueA.title,
            exact: true,
          });
          const issueBOption = page.getByRole('option', {
            name: handoff.github.issueB.title,
            exact: true,
          });
          await expect(issueAOption).toHaveCount(1, { timeout: 180_000 });
          await expect(issueBOption).toHaveCount(1, { timeout: 180_000 });
          return { issueAOption, issueBOption };
        };

        await setCurrentUiContextPrivacyMode({
          page,
          serverBaseUrl: server.baseUrl,
          uiBaseUrl,
          mode: 'off',
        });
        let { issueAOption, issueBOption } = await openTriage();
        await issueAOption.click();
        await expect(issueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await sendNormalLocalAgentVoiceTurn({ page, boundary });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the privacy-off Voice turn',
          matches: (row) => row.type === 'sdk_stdin'
            && typeof row.userText === 'string'
            && row.userText.includes('UCX_VOICE_OFF'),
        });
        const offPrompts = fakeClaudeProviderPrompts(await readFakeClaudeLogRows(fakeClaudeLogPath));
        const offPrompt = offPrompts.find((prompt) => prompt.includes('UCX_VOICE_OFF'));
        expect(offPrompt).toBeDefined();
        expect(offPrompt).not.toContain('readCurrentUiContext');
        expect(offPrompt).not.toContain('invokeCurrentUiCommand');
        await stopNormalLocalAgentVoiceSession(page);

        await setCurrentUiContextPrivacyMode({
          page,
          serverBaseUrl: server.baseUrl,
          uiBaseUrl,
          mode: 'on_demand',
        });
        ({ issueAOption, issueBOption } = await openTriage());
        await issueAOption.click();
        await expect(issueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });

        secondContext = await browser.newContext();
        const secondPage = await secondContext.newPage();
        await installAuthBootstrapStorageSnapshot(secondPage, authBootstrap);
        await gotoDomContentLoadedWithRetries(
          secondPage,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
          180_000,
        );
        await waitForAuthenticatedHomeUi({ page: secondPage, timeoutMs: 180_000 });
        await gotoDomContentLoadedWithRetries(
          secondPage,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, triagePath),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page: secondPage,
          expectedPathname: '/plugins/happier.triage/triage',
          requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
          timeoutMs: 180_000,
        });
        const secondIssueAOption = secondPage.getByRole('option', {
          name: handoff.github.issueA.title,
          exact: true,
        });
        const secondIssueBOption = secondPage.getByRole('option', {
          name: handoff.github.issueB.title,
          exact: true,
        });
        await expect(secondIssueAOption).toHaveCount(1, { timeout: 180_000 });
        await expect(secondIssueBOption).toHaveCount(1, { timeout: 180_000 });
        await secondIssueAOption.click();
        await expect(secondIssueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(secondIssueBOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });

        await sendNormalLocalAgentVoiceTurn({ page, boundary });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the current-UI read action result',
          matches: (row) => row.type === 'sdk_stdin'
            && typeof row.userText === 'string'
            && row.userText.includes('VOICE_TOOL_RESULTS_JSON')
            && row.userText.includes('readCurrentUiContext')
            && row.userText.includes(handoff.github.issueA.title),
        });
        await expect(issueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });
        await stopNormalLocalAgentVoiceSession(page);

        await sendNormalLocalAgentVoiceTurn({ page, boundary });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'true', { timeout: 180_000 });
        await expect(issueAOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the successful current-UI command result',
          matches: (row) => row.type === 'sdk_stdin'
            && typeof row.userText === 'string'
            && row.userText.includes('VOICE_TOOL_RESULTS_JSON')
            && row.userText.includes('invokeCurrentUiCommand')
            && row.userText.includes('"ok":true'),
        });
        await expect(secondIssueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(secondIssueBOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });
        await stopNormalLocalAgentVoiceSession(page);

        await page.goBack({ waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: '/plugins/happier.triage/triage',
          requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
          timeoutMs: 180_000,
        });
        issueAOption = page.getByRole('option', { name: handoff.github.issueA.title, exact: true });
        issueBOption = page.getByRole('option', { name: handoff.github.issueB.title, exact: true });
        await expect(issueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });

        await sendNormalLocalAgentVoiceTurn({ page, boundary });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the delayed stale current-UI command',
          matches: (row) => row.type === 'triage_current_ui_delayed_command_ready',
        });
        await issueBOption.click();
        await expect(issueBOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await writeFile(delayedCurrentUiReleaseFile, 'release\n', 'utf8');
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the stale current-UI command result',
          matches: (row) => row.type === 'sdk_stdin'
            && typeof row.userText === 'string'
            && row.userText.includes('VOICE_TOOL_RESULTS_JSON')
            && row.userText.includes('invokeCurrentUiCommand')
            && row.userText.includes('"errorCode":"stale_surface"'),
        });
        await expect(issueBOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(secondIssueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(secondIssueBOption).toHaveAttribute('aria-selected', 'false', { timeout: 120_000 });
        await stopNormalLocalAgentVoiceSession(page);

        await setCurrentUiContextPrivacyMode({
          page,
          serverBaseUrl: server.baseUrl,
          uiBaseUrl,
          mode: 'automatic',
        });
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
          180_000,
        );
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
        await sendNormalLocalAgentVoiceTurn({ page, boundary });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'the automatic-mode Voice turn',
          matches: (row) => row.type === 'sdk_stdin'
            && typeof row.userText === 'string'
            && row.userText.includes('UCX_VOICE_AUTOMATIC_READY'),
        });
        await expect(page.getByTestId('voice-surface-mode:sidebar:idle'))
          .toHaveCount(1, { timeout: 120_000 });

        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice?happier_hmr=0'),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: '/settings/voice',
          requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
          timeoutMs: 180_000,
        });
        ({ issueAOption, issueBOption } = await openTriage());
        await issueAOption.click();
        await expect(issueAOption).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await waitForFakeClaudeLogRow({
          logPath: fakeClaudeLogPath,
          description: 'automatic current-UI metadata',
          matches: (row) => row.type === 'triage_current_ui_automatic_update_received',
        });
        const automaticPrompts = fakeClaudeProviderPrompts(await readFakeClaudeLogRows(fakeClaudeLogPath))
          .filter((prompt) => prompt.includes('CURRENT UI CONTEXT'));
        expect(automaticPrompts.length).toBeGreaterThan(0);
        for (const prompt of automaticPrompts) {
          expect(prompt).not.toContain(handoff.github.issueA.title);
          expect(prompt).not.toContain(handoff.github.issueB.title);
          expect(prompt).not.toContain('commands');
        }
        await stopNormalLocalAgentVoiceSession(page);
        normalTriageLocalAgentJourneyLoadedModules = await attestLoadedBrowserModules(
          page,
          await normalTriageLocalAgentJourneyModuleResponses.observedResponses(),
        );
        normalTriageLocalAgentJourneyCompleted = true;
      } finally {
        normalTriageLocalAgentJourneyModuleResponses.dispose();
        await secondContext?.close().catch(() => undefined);
        await boundary?.stop().catch(() => undefined);
      }
    });
  }

  test('packs, trusts, loads, replaces, disables, and uninstalls the public app-page Action fixture', async ({ page, browser }) => {
    test.setTimeout(900_000);
    if (!candidate || !server || !uiBaseUrl) {
      throw new Error('packed_targeted_browser_suite_not_ready');
    }
    const serverForTest = server;
    const uiBaseUrlForTest = uiBaseUrl;

    const testDir = resolve(join(suiteDir, 'consumed-vertical'));
    const cliHomeDir = join(testDir, 'happier-home');
    const cliEnv = sanitizeDaemonEnvForSpawn(process.env);
    let secondContext: BrowserContext | null = null;
    let contributorDisabledAndRetired = false;
    let contributorTrustRevokedAndReinstalled = false;
    let contributorUninstalledAndRetired = false;
    await mkdir(cliHomeDir, { recursive: true });
    const auth = await createTestAuth(server.baseUrl);
    await seedCliAuthForTestAccount({
      cliHome: cliHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    const authBootstrap = buildAuthBootstrapStorageSnapshot({
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
      storageScope,
    });
    await installAuthBootstrapStorageSnapshot(page, authBootstrap);
    const daemonEnv = {
      ...cliEnv,
      CI: '1',
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: uiBaseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    };

    const archives = await authorPackedTargetedArchives({
      candidate,
      cliHomeDir,
      env: cliEnv,
      serverUrl: server.baseUrl,
      testDir,
      uiBaseUrl,
    });
    const [ucxContributorV1ArchiveSha256, ucxContributorV2ArchiveSha256] =
      await Promise.all([
        sha256File(archives.contributorV1ArchivePath),
        sha256File(archives.contributorV2ArchivePath),
      ]);
    const rowLoadedModuleResponses = observeLoadedBrowserModuleResponses(page);
    try {
      daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: daemonEnv,
      });
      expect(daemon.state.startedWithCliVersion).toBe(candidate.attestation.cliVersion);

      const targetInstall = await installReviewedArchive({
        archivePath: archives.targetArchivePath,
        cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: cliEnv,
        expectedPluginId: TARGET_PLUGIN_ID,
        serverUrl: server.baseUrl,
        testDir,
        uiBaseUrl,
      });
      expect(targetInstall.appliedGeneration).toBeNull();
      const contributorV1Generation = requireAppliedInstalledGeneration(await installReviewedArchive({
        archivePath: archives.contributorV1ArchivePath,
        cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: cliEnv,
        expectedPluginId: CONTRIBUTOR_PLUGIN_ID,
        serverUrl: server.baseUrl,
        testDir,
        uiBaseUrl,
      }));

      const contributorPagePathname = `/plugins/${CONTRIBUTOR_PLUGIN_ID}/${APP_PAGE_ID}`;
      const pagePath = `${contributorPagePathname}?happier_hmr=0`;
      const localEffectPath = `${contributorPagePathname}/local-effect`;
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/conversations?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/conversations',
        requiredTestIds: ['settings.voice.provider.off'],
        timeoutMs: 180_000,
      });
      const voiceProviderRow = page.getByTestId(VOICE_PROVIDER_ROW_TEST_ID);
      await expect(voiceProviderRow).toHaveCount(1, { timeout: 180_000 });
      await voiceProviderRow.click();
      await expect(voiceProviderRow).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/advanced?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/advanced',
        requiredTestIds: ['settings.voice.ui.activityFeedEnabled'],
        timeoutMs: 180_000,
      });
      const activityFeedEnabled = page.getByTestId('settings.voice.ui.activityFeedEnabled');
      await expect(activityFeedEnabled).toHaveCount(1, { timeout: 120_000 });
      if (await activityFeedEnabled.getAttribute('aria-checked') !== 'true') {
        await activityFeedEnabled.click();
      }
      await expect(activityFeedEnabled).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, pagePath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: `/plugins/${CONTRIBUTOR_PLUGIN_ID}/${APP_PAGE_ID}`,
        requiredTestIds: [
          'plugin-app-page-host',
          'packed-targeted-provider-title',
          'packed-targeted-context-action',
          'packed-targeted-stale-context-action',
          'packed-targeted-context-invocation-count',
          'packed-targeted-web-only-context-action',
          'packed-targeted-writes-local-action',
        ],
        timeoutMs: 180_000,
      });
      await expect(page.getByTestId('packed-targeted-provider-title'))
        .toHaveText('Packed provider detail 1.0.0');
      await expect(page.getByRole('button', {
        name: 'Inspect packed provider context',
      })).toBeVisible();
      await expect(page.getByTestId('packed-targeted-context-result')).toHaveText('not-invoked');
      await expect(page.getByTestId('packed-targeted-context-invocation-count')).toHaveText('0');

      secondContext = await browser.newContext();
      const secondPage = await secondContext.newPage();
      const secondClientDistinctPath = '/settings/voice/privacy?happier_hmr=0';
      await installAuthBootstrapStorageSnapshot(secondPage, authBootstrap);
      await gotoDomContentLoadedWithRetries(
        secondPage,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedHomeUi({ page: secondPage, timeoutMs: 180_000 });
      await gotoDomContentLoadedWithRetries(
        secondPage,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, secondClientDistinctPath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page: secondPage,
        expectedPathname: '/settings/voice/privacy',
        requiredTestIds: ['settings.voice.section.privacy'],
        timeoutMs: 180_000,
      });
      const assertSecondClientPrivacyBaseline = async () => {
        const secondClientUrl = new URL(secondPage.url());
        expect(secondClientUrl.pathname).toBe('/settings/voice/privacy');
        expect(secondClientUrl.searchParams.get('happier_hmr')).toBe('0');
        await expect(secondPage.getByTestId('settings.voice.section.privacy'))
          .toBeVisible({ timeout: 120_000 });
      };
      await assertSecondClientPrivacyBaseline();

      const waitForLiveContributor = async () => {
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrlForTest, serverForTest.baseUrl, pagePath),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: contributorPagePathname,
          requiredTestIds: [
            'plugin-app-page-host',
            'packed-targeted-provider-title',
            'packed-targeted-context-action',
            'packed-targeted-context-result',
            'voice-surface-toggle:sidebar',
          ],
          timeoutMs: 180_000,
        });
      };

      const exerciseLiveContributor = async () => {
        await waitForLiveContributor();
        await page.getByTestId('packed-targeted-context-action').click();
        await expect(page.getByTestId('packed-targeted-context-result'))
          .toHaveText('page:ui', { timeout: 120_000 });
        const currentVoiceToggle = page.getByTestId('voice-surface-toggle:sidebar');
        await currentVoiceToggle.click();
        await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
          .toHaveCount(1, { timeout: 120_000 });
        const currentVoiceActivityToggle = page.getByTestId('voice-surface-activity-toggle:sidebar');
        await expect(currentVoiceActivityToggle).toHaveCount(1, { timeout: 120_000 });
        if (await currentVoiceActivityToggle.getAttribute('aria-expanded') !== 'true') {
          await currentVoiceActivityToggle.click();
        }
        await expect(page.getByText(PACKED_VOICE_COMPLETION_TEXT, { exact: true }))
          .toBeVisible({ timeout: 120_000 });
      };

      const assertContributorRetirement = async () => {
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(uiBaseUrlForTest, serverForTest.baseUrl, pagePath),
          180_000,
        );
        await expect(page.getByTestId('plugin-app-page-unavailable'))
          .toBeVisible({ timeout: 180_000 });
        await expect(page.getByTestId('packed-targeted-context-action'))
          .toHaveCount(0, { timeout: 180_000 });
        await expect(page.getByTestId('packed-targeted-context-result'))
          .toHaveCount(0, { timeout: 180_000 });
        await expect(page.getByTestId('voice-surface-status:sidebar:disconnected'))
          .toHaveCount(1, { timeout: 180_000 });
        await gotoDomContentLoadedWithRetries(
          page,
          buildServerScopedUiUrl(
            uiBaseUrlForTest,
            serverForTest.baseUrl,
            '/settings/voice/conversations?happier_hmr=0',
          ),
          180_000,
        );
        await waitForAuthenticatedRouteUi({
          page,
          expectedPathname: '/settings/voice/conversations',
          requiredTestIds: ['settings.voice.provider.off'],
          timeoutMs: 180_000,
        });
        await expect(page.getByTestId(VOICE_PROVIDER_ROW_TEST_ID))
          .toHaveCount(0, { timeout: 180_000 });
      };

      await page.getByTestId('packed-targeted-context-action').click();
      await expect(page.getByTestId('packed-targeted-context-result'))
        .toHaveText('page:ui', { timeout: 120_000 });
      await expect(page.getByTestId('packed-targeted-context-invocation-count')).toHaveText('1');
      await assertSecondClientPrivacyBaseline();

      await page.getByTestId('packed-targeted-web-only-context-action').click();
      await expect(page.getByTestId('packed-targeted-web-only-context-result'))
        .toHaveText(/:ui$/u, { timeout: 120_000 });
      await assertSecondClientPrivacyBaseline();

      await page.getByTestId('packed-targeted-writes-local-action').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('web-modal-cancel').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(0, { timeout: 120_000 });
      await page.getByTestId('packed-targeted-writes-local-action').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('web-modal-confirm').click();
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: localEffectPath,
        requiredTestIds: ['plugin-app-page-host', 'packed-targeted-provider-title'],
        timeoutMs: 120_000,
      });
      await assertSecondClientPrivacyBaseline();
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: contributorPagePathname,
        requiredTestIds: ['plugin-app-page-host', 'packed-targeted-provider-title'],
        timeoutMs: 120_000,
      });
      await assertSecondClientPrivacyBaseline();

      const exactCandidateDaemon = daemon;
      if (!exactCandidateDaemon) throw new Error('packed_targeted_candidate_daemon_missing');
      await exactCandidateDaemon.stop();
      daemon = null;
      await page.getByTestId('packed-targeted-context-action').click();
      await expect(page.getByTestId('packed-targeted-context-result'))
        .toHaveText(/:ui$/u, { timeout: 120_000 });
      await expect(page.getByTestId('packed-targeted-context-invocation-count')).toHaveText('2');

      daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: daemonEnv,
      });
      expect(daemon.state.startedWithCliVersion).toBe(candidate.attestation.cliVersion);

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/privacy?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/privacy',
        requiredTestIds: ['settings.voice.section.privacy'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('settings.voice.privacy.currentUiContextMode').click();
      await expect(page.getByTestId('dropdown-option-off')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('dropdown-option-off').click();

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, pagePath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: `/plugins/${CONTRIBUTOR_PLUGIN_ID}/${APP_PAGE_ID}`,
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      const voiceToggle = page.getByTestId('voice-surface-toggle:sidebar');
      await expect(voiceToggle).toBeEnabled({ timeout: 120_000 });
      await voiceToggle.click();
      await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
        .toHaveCount(1, { timeout: 120_000 });
      const offVoiceActivityToggle = page.getByTestId('voice-surface-activity-toggle:sidebar');
      await expect(offVoiceActivityToggle).toHaveCount(1, { timeout: 120_000 });
      if (await offVoiceActivityToggle.getAttribute('aria-expanded') !== 'true') {
        await offVoiceActivityToggle.click();
      }
      await expect(page.getByText(PACKED_VOICE_CURRENT_UI_TOOLS_OFF_TEXT, { exact: true }))
        .toBeVisible({ timeout: 120_000 });
      await expect(page.getByText(PACKED_VOICE_COMPLETION_TEXT, { exact: true })).toHaveCount(0);
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice',
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
        .toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByText(PACKED_VOICE_AUTOMATIC_METADATA_TEXT, { exact: false }))
        .toHaveCount(0);
      await page.getByTestId('voice-surface-toggle:sidebar').click();
      await expect(page.getByTestId('voice-surface-status:sidebar:disconnected'))
        .toHaveCount(1, { timeout: 120_000 });

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/privacy?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/privacy',
        requiredTestIds: ['settings.voice.section.privacy'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('settings.voice.privacy.currentUiContextMode').click();
      await expect(page.getByTestId('dropdown-option-on_demand')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('dropdown-option-on_demand').click();

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, pagePath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: `/plugins/${CONTRIBUTOR_PLUGIN_ID}/${APP_PAGE_ID}`,
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('voice-surface-toggle:sidebar').click();
      await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
        .toHaveCount(1, { timeout: 120_000 });
      const voiceActivityToggle = page.getByTestId('voice-surface-activity-toggle:sidebar');
      await expect(voiceActivityToggle).toHaveCount(1, { timeout: 120_000 });
      if (await voiceActivityToggle.getAttribute('aria-expanded') !== 'true') {
        await voiceActivityToggle.click();
      }
      await expect(page.getByText(PACKED_VOICE_CURRENT_UI_TOOLS_AVAILABLE_TEXT, { exact: true }))
        .toBeVisible({ timeout: 120_000 });
      await expect(page.getByText(PACKED_VOICE_COMPLETION_TEXT, { exact: true }))
        .toBeVisible({ timeout: 120_000 });
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice',
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
        .toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByText(PACKED_VOICE_AUTOMATIC_METADATA_TEXT, { exact: false }))
        .toHaveCount(0);
      await page.getByTestId('voice-surface-toggle:sidebar').click();
      await expect(page.getByTestId('voice-surface-status:sidebar:disconnected'))
        .toHaveCount(1, { timeout: 120_000 });

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/privacy?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice/privacy',
        requiredTestIds: ['settings.voice.section.privacy'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('settings.voice.privacy.currentUiContextMode').click();
      await expect(page.getByTestId('dropdown-option-automatic')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('dropdown-option-automatic').click();

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, pagePath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: `/plugins/${CONTRIBUTOR_PLUGIN_ID}/${APP_PAGE_ID}`,
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      await expect(page.getByText(PACKED_VOICE_AUTOMATIC_METADATA_TEXT, { exact: true })).toHaveCount(0);
      await page.getByTestId('voice-surface-toggle:sidebar').click();
      await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
        .toHaveCount(1, { timeout: 120_000 });
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/voice',
        requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
        timeoutMs: 180_000,
      });
      await expect(page.getByTestId('voice-surface-status:sidebar:connected'))
        .toHaveCount(1, { timeout: 120_000 });
      const automaticMetadataActivityToggle = page.getByTestId('voice-surface-activity-toggle:sidebar');
      await expect(automaticMetadataActivityToggle).toHaveCount(1, { timeout: 120_000 });
      if (await automaticMetadataActivityToggle.getAttribute('aria-expanded') !== 'true') {
        await automaticMetadataActivityToggle.click();
      }
      await expect(page.getByText(PACKED_VOICE_CURRENT_UI_TOOLS_AVAILABLE_TEXT, { exact: true }))
        .toBeVisible({ timeout: 120_000 });
      const automaticMetadataTranscript = page
        .getByText(PACKED_VOICE_AUTOMATIC_METADATA_TEXT, { exact: false })
        .last();
      await expect(automaticMetadataTranscript).toBeVisible({ timeout: 120_000 });
      await expect(automaticMetadataTranscript).not.toContainText('Packed targeted provider');
      await expect(automaticMetadataTranscript).not.toContainText('Inspect packed provider context');
      await expect(automaticMetadataTranscript).not.toContainText('current-ui-command');

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, pagePath),
        180_000,
      );
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: `/plugins/${CONTRIBUTOR_PLUGIN_ID}/${APP_PAGE_ID}`,
        requiredTestIds: ['packed-targeted-stale-context-action'],
        timeoutMs: 180_000,
      });
      await page.getByTestId('packed-targeted-stale-context-action').click();
      await expect(page.getByTestId('packed-targeted-stale-context-action-spinner'))
        .toBeVisible({ timeout: 30_000 });

      const contributorV2Generation = requireAppliedInstalledGeneration(await installReviewedArchive({
        archivePath: archives.contributorV2ArchivePath,
        cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: cliEnv,
        expectedPluginId: CONTRIBUTOR_PLUGIN_ID,
        serverUrl: server.baseUrl,
        testDir,
        uiBaseUrl,
      }));
      expect(contributorV2Generation).not.toBe(contributorV1Generation);
      await expect(page.getByTestId('packed-targeted-context-result'))
        .toHaveText('retired', { timeout: 120_000 });
      await expect(page.getByTestId('voice-surface-status:sidebar:disconnected'))
        .toHaveCount(1, { timeout: 120_000 });

      // Re-enter only through the canonical page route. The new generation must
      // not inherit the retired Action's local result state.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await exerciseLiveContributor();
      await expect(page.getByTestId('packed-targeted-provider-title'))
        .toHaveText('Packed provider detail 1.0.1');

      const disableData = requireSuccessfulEnvelope(await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: cliEnv,
        cliLaunchSpec: candidate.cliLaunchSpec,
        label: 'disable-live-contributor',
        args: ['plugins', 'disable', CONTRIBUTOR_PLUGIN_ID, '--json'],
        timeoutMs: 180_000,
      }), 'plugins_disable');
      expect(disableData.enabled).toBe(false);
      await assertContributorRetirement();
      contributorDisabledAndRetired = true;

      const enableData = requireSuccessfulEnvelope(await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: cliEnv,
        cliLaunchSpec: candidate.cliLaunchSpec,
        label: 'enable-live-contributor',
        args: ['plugins', 'enable', CONTRIBUTOR_PLUGIN_ID, '--json'],
        timeoutMs: 180_000,
      }), 'plugins_enable');
      expect(enableData.enabled).toBe(true);
      await exerciseLiveContributor();

      const liveContributorDaemon = daemon;
      if (!liveContributorDaemon) throw new Error('packed_targeted_live_daemon_missing');
      await forgetPluginTrust({
        daemon: liveContributorDaemon,
        pluginId: CONTRIBUTOR_PLUGIN_ID,
      });
      await assertContributorRetirement();

      const reinstalledContributorV2Generation = requireAppliedInstalledGeneration(await installReviewedArchive({
        archivePath: archives.contributorV2ArchivePath,
        cliHomeDir,
        cliLaunchSpec: candidate.cliLaunchSpec,
        env: cliEnv,
        expectedPluginId: CONTRIBUTOR_PLUGIN_ID,
        serverUrl: server.baseUrl,
        testDir,
        uiBaseUrl,
      }));
      expect(reinstalledContributorV2Generation).toBeTruthy();
      await exerciseLiveContributor();
      contributorTrustRevokedAndReinstalled = true;

      const uninstallData = requireSuccessfulEnvelope(await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: cliEnv,
        cliLaunchSpec: candidate.cliLaunchSpec,
        label: 'uninstall-contributor',
        args: ['plugins', 'uninstall', CONTRIBUTOR_PLUGIN_ID, '--json'],
        timeoutMs: 180_000,
      }), 'plugins_uninstall');
      expect(uninstallData.pluginId).toBe(CONTRIBUTOR_PLUGIN_ID);
      expect(uninstallData.desiredGeneration).toBeNull();
      expect(uninstallData.appliedGeneration).toBeNull();
      await assertContributorRetirement();
      contributorUninstalledAndRetired = true;
      if (triageGithubVoiceAdapter === 'local_agent') {
        const loadedModules = await attestLoadedBrowserModules(
          page,
          await rowLoadedModuleResponses.observedResponses(),
        );
        await writeRedactedResultArtifact({
          testDir,
          artifactName: 'packed-targeted-projection.result.json',
          label: 'packed-targeted-projection',
          outcome: buildPackedCandidateBrowserQaRunOutcome({
            attestation: candidate.attestation,
            loadedModules,
            normalTriageLocalAgentJourneyLoadedModules,
            ucxContributor: {
              v1: {
                archiveSha256: ucxContributorV1ArchiveSha256,
                appliedGeneration: contributorV1Generation,
              },
              v2: {
                archiveSha256: ucxContributorV2ArchiveSha256,
                appliedGeneration: contributorV2Generation,
              },
            },
            completion: {
              normalTriageLocalAgentJourneyCompleted:
                normalTriageLocalAgentJourneyCompleted,
              contributorDisabledAndRetired: contributorDisabledAndRetired,
              contributorTrustRevokedAndReinstalled:
                contributorTrustRevokedAndReinstalled,
              contributorUninstalledAndRetired:
                contributorUninstalledAndRetired,
            },
          }),
        });
      }
    } finally {
      rowLoadedModuleResponses.dispose();
      await secondContext?.close().catch(() => undefined);
      await archives.closeRegistry().catch(() => undefined);
    }
  });
});
