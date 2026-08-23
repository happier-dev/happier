import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol';
import {
  decideDaemonPluginChange,
  readDaemonPluginCatalog,
  requestDaemonPluginActionExecution,
  requestDaemonPluginChange,
  type DaemonControlRequestOptions,
} from '@/daemon/controlClient';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import { sanitizeDaemonSpawnEnv } from '@happier-dev/cli-common/process';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import type {
  PluginChangeDecisionResult,
  PluginChangeRequestResult,
} from '@/plugins/daemon/changeContract';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { resolveArchiveExpectedIntegrity } from '@/plugins/distribution/archive/integrity';
import {
  packLocalPlugin,
  type PackLocalPluginResult,
} from '@/plugins/packaging/pack';
import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import {
  PLUGIN_CATALOG_READ_PATH,
} from '@/plugins/daemon/controlRoutes';
import {
  PACKED_TEST_TARGETED_ADMISSION_READ_PATH,
  PackedTestTargetedAdmissionReadResponseSchema,
} from '@/plugins/daemon/packedTestTargetedAdmissions';
import type { PackedTestDaemonReady } from '@/plugins/daemon/packedTestHost';

export type PackedPluginTestDiagnostic = Readonly<{
  code: string;
  message: string;
}>;

type PackedPluginTestInvocation = Readonly<{
  actionId: string;
  result: unknown;
}>;

type PackedPluginTestPrerequisite = Readonly<{
  pluginId: string;
  archiveDigest: string | null;
}>;

type PackedPlugin = Extract<PackLocalPluginResult, { ok: true }>;

export type PackedPluginTestParticipant = Readonly<{
  source: Readonly<{
    kind: 'project' | 'archive';
    locator: string;
  }>;
  plugin: Readonly<{
    id: string;
    version: string;
    packageIdentity: Readonly<{
      name: string | null;
      version: string;
    }>;
  }>;
  archive: Readonly<{
    digest: string | null;
    integrity: string | null;
  }>;
  admission: Readonly<{
    decision: 'installAndTrust';
    desiredGeneration: string;
    appliedGeneration: string | null;
  }>;
}>;

export type PackedPluginTestTargetedAdmission = Readonly<{
  target: Readonly<{
    pluginId: string;
    pointId: string;
    immutableGenerationId: string;
  }>;
  protocol: Readonly<{
    id: string;
    version: number;
  }>;
  contributor: Readonly<{
    pluginId: string;
    contributionId: string;
    immutableGenerationId: string;
  }>;
}>;

export type PackedPluginTestAdmittedContributor = PackedPluginTestParticipant & Readonly<{
  targetedAdmissions: readonly PackedPluginTestTargetedAdmission[];
}>;

export type PackedPluginTestResult =
  | Readonly<{
      ok: true;
      mode: 'packed';
      projectRoot: string;
      pluginId: string;
      archiveDigest: string;
      prerequisitePlugins?: readonly PackedPluginTestPrerequisite[];
      target: PackedPluginTestParticipant;
      /** Every installed `--with-plugin` input, regardless of target admission. */
      prerequisites: readonly PackedPluginTestParticipant[];
      /** Only prerequisites present in the canonical target-owned admission snapshot. */
      contributors: readonly PackedPluginTestAdmittedContributor[];
      initialInvocation: PackedPluginTestInvocation | null;
      invocation: PackedPluginTestInvocation | null;
      publicationRemovalReadd?: Readonly<{
        removed: true;
        readded: true;
        target: PackedPluginTestParticipant;
        invocation: PackedPluginTestInvocation;
      }>;
      daemon: Readonly<{
        authenticatedControl: true;
        initialPid: number;
        restartedPid: number;
        initialIncarnationId: string;
        restartedIncarnationId: string;
        staleIncarnationRejected: true;
      }>;
    }>
  | Readonly<{
      ok: false;
      mode: 'packed';
      projectRoot: string;
      diagnostics: readonly PackedPluginTestDiagnostic[];
    }>;

function failure(
  projectRoot: string,
  code: string,
  message: string,
): Extract<PackedPluginTestResult, { ok: false }> {
  return Object.freeze({
    ok: false,
    mode: 'packed',
    projectRoot,
    diagnostics: Object.freeze([Object.freeze({ code, message })]),
  });
}

function describePackedDaemonChangeResult(result: unknown): string {
  if (!result || typeof result !== 'object') return 'invalid_response';
  const record = result as Readonly<Record<string, unknown>>;
  const kind = typeof record.kind === 'string' && record.kind.trim()
    ? record.kind.trim()
    : 'unknown';
  const details = [kind];
  if (typeof record.code === 'string' && record.code.trim()) {
    details.push(record.code.trim());
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    details.push(projectPluginFailureText(new Error(record.message)));
  }
  if (kind === 'committed') {
    details.push(`desired=${String(record.desiredGeneration)}`);
    details.push(`applied=${String(record.appliedGeneration)}`);
  }
  return details.join(':');
}

function describePackedActionFailure(result: Readonly<{
  errorCode: string;
  error: string;
}>): string {
  return `${result.errorCode}: ${result.error}`;
}

function describePackedThrownFailure(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return projectPluginFailureText(new Error(String(error)));
  }
  const record = error as Readonly<Record<string, unknown>>;
  const code = typeof record.code === 'string' && record.code.trim()
    ? record.code.trim()
    : null;
  const message = typeof record.message === 'string' && record.message.trim()
    ? record.message.trim()
    : null;
  return projectPluginFailureText(new Error(
    code && message ? `${code}: ${message}` : message ?? String(error),
  ));
}

function projectPackDiagnostics(
  diagnostics: Extract<PackLocalPluginResult, { ok: false }>['diagnostics'],
): readonly PackedPluginTestDiagnostic[] {
  return Object.freeze(diagnostics.map((diagnostic) => {
    const message = 'message' in diagnostic && typeof diagnostic.message === 'string'
      ? diagnostic.message.trim()
      : '';
    return Object.freeze({
      code: diagnostic.code,
      message: message || `Plugin pack failed (${diagnostic.code})`,
    });
  }));
}

function selectEmptyInputCliAction(
  manifest: CanonicalPluginManifest,
): string | null {
  for (const action of manifest.contributes.actions) {
    if (action.dangerLevel !== 'safe' || !action.surfaces.includes('cli')) continue;
    if (!action.inputSchema) return action.id;
    const validate = compilePluginJsonSchema(action.inputSchema);
    if (isValidPluginJsonSchemaValue(validate, {})) return action.id;
  }
  return null;
}

type DisposableDaemon = Readonly<{
  ready: PackedTestDaemonReady;
  target: NonNullable<DaemonControlRequestOptions['target']>;
  stop: () => Promise<void>;
}>;

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', () => resolveExit()));
}

async function stopDisposableDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 12_000)),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  const forced = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!forced) throw new Error(`Disposable plugin daemon ${child.pid ?? 'unknown'} did not stop`);
}

function parseReady(raw: string): PackedTestDaemonReady | null {
  try {
    const value = JSON.parse(raw) as Partial<PackedTestDaemonReady>;
    if (value.kind !== 'happier_packed_test_daemon_ready_v1'
      || !Number.isInteger(value.pid)
      || !Number.isInteger(value.httpPort)
      || typeof value.controlToken !== 'string'
      || !value.controlToken
      || typeof value.incarnationId !== 'string'
      || !value.incarnationId) {
      return null;
    }
    return value as PackedTestDaemonReady;
  } catch {
    return null;
  }
}

/**
 * The disposable daemon must run the SAME Happier CLI implementation as the
 * process that starts it, otherwise a packed journey silently proves whatever
 * prebuilt artifact happens to sit in the checkout instead of the code under
 * test. A packaged CLI already satisfies that: its packaged entrypoint is the
 * implementation currently executing. A source-run CLI does not, because
 * `resolvePackagedRuntimeEntrypoint` returns any `package-dist`/`dist` build
 * that exists next to the sources, no matter how old.
 *
 * This module's own execution form is the authority for which implementation
 * is live: a TypeScript module means the checkout sources are executing, so the
 * daemon is pinned to the source runtime. An explicit caller pin
 * (`HAPPIER_CLI_SUBPROCESS_ENTRYPOINT`) always wins.
 */
export function resolveDisposableDaemonEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  runtimeModuleUrl: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnv,
    HAPPIER_CLI_UPDATE_CHECK: '0',
    HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
  };
  const pinnedEntrypoint = typeof environment.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT === 'string'
    ? environment.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT.trim()
    : '';
  if (pinnedEntrypoint) return environment;
  const runtimeModulePath = runtimeModuleUrl.split('?')[0] ?? runtimeModuleUrl;
  if (!/\.[cm]?tsx?$/.test(runtimeModulePath)) return environment;
  environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '1';
  return environment;
}

async function startDisposableDaemon(params: Readonly<{
  operationRoot: string;
  happyHomeDir: string;
  projectRoot: string;
  connectedAccountsFixturePluginId?: string;
}>): Promise<DisposableDaemon> {
  const readyFile = join(params.operationRoot, `daemon-ready-${randomUUID()}.json`);
  const daemonEnvironment = resolveDisposableDaemonEnvironment(process.env, import.meta.url);
  const launchSpec = buildHappyCliSubprocessLaunchSpec([
    'daemon',
    'plugin-packed-test-host',
    '--home',
    params.happyHomeDir,
    '--ready-file',
    readyFile,
    '--parent-pid',
    String(process.pid),
    ...(params.connectedAccountsFixturePluginId ? [
      '--connected-accounts-fixture-plugin-id',
      params.connectedAccountsFixturePluginId,
    ] : []),
  ], { environment: daemonEnvironment });
  const child = spawn(launchSpec.filePath, launchSpec.args, {
    cwd: params.projectRoot,
    env: sanitizeDaemonSpawnEnv({
      ...daemonEnvironment,
      ...(launchSpec.env ?? {}),
      HAPPIER_HOME_DIR: params.happyHomeDir,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  // A cold source-mode daemon imports the complete production registry. Under
  // concurrent workspace builds that can legitimately cross one minute before
  // the restricted host writes readiness, while packaged invocations remain
  // much faster.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Disposable plugin daemon exited before readiness${stderr ? `: ${stderr.trim()}` : ''}`);
    }
    const ready = await readFile(readyFile, 'utf8').then(parseReady).catch(() => null);
    if (ready) {
      if (ready.pid !== child.pid) {
        await stopDisposableDaemon(child);
        throw new Error('Disposable plugin daemon readiness PID did not match its child process');
      }
      return Object.freeze({
        ready,
        target: Object.freeze({
          pid: ready.pid,
          httpPort: ready.httpPort,
          controlToken: ready.controlToken,
        }),
        stop: async () => await stopDisposableDaemon(child),
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  await stopDisposableDaemon(child);
  throw new Error(`Disposable plugin daemon readiness timed out${stderr ? `: ${stderr.trim()}` : ''}`);
}

async function verifyAuthenticatedControlBoundary(daemon: DisposableDaemon): Promise<boolean> {
  const response = await fetch(
    `http://127.0.0.1:${daemon.ready.httpPort}${PLUGIN_CATALOG_READ_PATH}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3_000),
    },
  );
  return response.status === 401;
}

type PackedTargetedAdmissionReadResult =
  | Readonly<{
      ok: true;
      admissions: readonly PackedPluginTestTargetedAdmission[];
    }>
  | Readonly<{
      ok: false;
      code: string;
      message: string;
    }>;

type PackedTargetedAdmissionProjectionResult =
  | Readonly<{
      ok: true;
      contributors: readonly PackedPluginTestAdmittedContributor[];
    }>
  | Readonly<{
      ok: false;
      code: string;
      message: string;
    }>;

function declaredTargetedAdmissionRequests(manifest: CanonicalPluginManifest): readonly Readonly<{
  pointId: string;
  protocol: Readonly<{ id: string; version: number }>;
}>[] {
  return Object.freeze(manifest.contributes.pluginContributionPoints.flatMap((point) => (
    point.protocols.map((protocol) => Object.freeze({
      pointId: point.id,
      protocol: Object.freeze({ id: protocol.id, version: protocol.version }),
    }))
  )));
}

/**
 * The target's packed manifest only selects exact declared points. The
 * disposable daemon then delegates all admission and normalization to its
 * current runtime registry; this never scans a plugin tree or recomputes
 * compatibility from manifests.
 */
async function readPackedTargetedAdmissions(params: Readonly<{
  daemon: DisposableDaemon;
  target: PackedPluginTestParticipant;
  manifest: CanonicalPluginManifest;
}>): Promise<PackedTargetedAdmissionReadResult> {
  const requests = declaredTargetedAdmissionRequests(params.manifest);
  if (requests.length === 0) {
    return Object.freeze({ ok: true, admissions: Object.freeze([]) });
  }
  const targetAppliedGeneration = params.target.admission.appliedGeneration;
  if (targetAppliedGeneration === null) {
    return Object.freeze({
      ok: false,
      code: 'plugin_packed_targeted_admission_target_not_applied',
      message: `Disposable daemon did not apply target '${params.target.plugin.id}' before target-owned admission`,
    });
  }
  const admissions: PackedPluginTestTargetedAdmission[] = [];
  for (const request of requests) {
    let response: Response;
    try {
      response = await fetch(
        `http://127.0.0.1:${params.daemon.ready.httpPort}${PACKED_TEST_TARGETED_ADMISSION_READ_PATH}`,
        {
          method: 'POST',
          headers: buildDaemonControlHttpHeaders(params.daemon.ready.controlToken),
          body: JSON.stringify({
            targetPluginId: params.target.plugin.id,
            pointId: request.pointId,
            protocol: request.protocol,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      return Object.freeze({
        ok: false,
        code: 'plugin_packed_targeted_admission_unavailable',
        message: `Disposable daemon could not read target admission for '${params.target.plugin.id}/${request.pointId}' (${describePackedThrownFailure(error)})`,
      });
    }
    const raw = await response.json().catch(() => null);
    const parsed = PackedTestTargetedAdmissionReadResponseSchema.safeParse(raw);
    if (!response.ok || !parsed.success || parsed.data.kind !== 'available') {
      const code = parsed.success && parsed.data.kind === 'unavailable'
        ? parsed.data.code
        : `http_${response.status}`;
      return Object.freeze({
        ok: false,
        code: 'plugin_packed_targeted_admission_unavailable',
        message: `Disposable daemon could not provide canonical target admission for '${params.target.plugin.id}/${request.pointId}' (${code})`,
      });
    }
    const snapshot = parsed.data;
    if (
      snapshot.target.pluginId !== params.target.plugin.id
      || snapshot.target.pointId !== request.pointId
      || snapshot.target.immutableGenerationId !== targetAppliedGeneration
      || snapshot.protocol.id !== request.protocol.id
      || snapshot.protocol.version !== request.protocol.version
    ) {
      return Object.freeze({
        ok: false,
        code: 'plugin_packed_targeted_admission_mismatch',
        message: `Disposable daemon returned a non-current targeted admission snapshot for '${params.target.plugin.id}/${request.pointId}'`,
      });
    }
    admissions.push(...snapshot.contributors.map((contributor) => Object.freeze({
      target: Object.freeze({ ...snapshot.target }),
      protocol: Object.freeze({ ...snapshot.protocol }),
      contributor: Object.freeze({ ...contributor }),
    })));
  }
  return Object.freeze({ ok: true, admissions: Object.freeze(admissions) });
}

export function projectPackedAdmittedContributors(params: Readonly<{
  prerequisites: readonly PackedPluginTestParticipant[];
  admissions: readonly PackedPluginTestTargetedAdmission[];
}>): PackedTargetedAdmissionProjectionResult {
  const prerequisitesByPluginAndGeneration = new Map<string, PackedPluginTestParticipant>();
  const prerequisitePluginIds = new Set<string>();
  for (const prerequisite of params.prerequisites) {
    prerequisitePluginIds.add(prerequisite.plugin.id);
    if (prerequisite.admission.appliedGeneration === null) continue;
    prerequisitesByPluginAndGeneration.set(
      `${prerequisite.plugin.id}\u0000${prerequisite.admission.appliedGeneration}`,
      prerequisite,
    );
  }

  const admissionsByPrerequisite = new Map<
    PackedPluginTestParticipant,
    PackedPluginTestTargetedAdmission[]
  >();
  for (const admission of params.admissions) {
    if (!prerequisitePluginIds.has(admission.contributor.pluginId)) {
      return Object.freeze({
        ok: false,
        code: 'plugin_packed_targeted_admission_unattributed',
        message: `Disposable daemon admitted '${admission.contributor.pluginId}' to the packed target without a requested --with-plugin participant`,
      });
    }
    const prerequisite = prerequisitesByPluginAndGeneration.get(
      `${admission.contributor.pluginId}\u0000${admission.contributor.immutableGenerationId}`,
    );
    if (!prerequisite) {
      return Object.freeze({
        ok: false,
        code: 'plugin_packed_targeted_admission_generation_mismatch',
        message: `Disposable daemon admitted '${admission.contributor.pluginId}' at immutable generation '${admission.contributor.immutableGenerationId}', not its current applied prerequisite generation`,
      });
    }
    const existing = admissionsByPrerequisite.get(prerequisite) ?? [];
    existing.push(admission);
    admissionsByPrerequisite.set(prerequisite, existing);
  }
  return Object.freeze({
    ok: true,
    contributors: Object.freeze(params.prerequisites.flatMap((participant) => {
      const targetedAdmissions = admissionsByPrerequisite.get(participant);
      return targetedAdmissions && targetedAdmissions.length > 0
        ? [Object.freeze({
            ...participant,
            targetedAdmissions: Object.freeze(targetedAdmissions),
          })]
        : [];
    })),
  });
}

async function invokeAction(params: Readonly<{
  daemon: DisposableDaemon;
  actionId: string;
}>): Promise<PluginActionExecutionAttempt> {
  return await requestDaemonPluginActionExecution({
    actionId: params.actionId,
    input: {},
    surface: 'cli',
  }, { target: params.daemon.target });
}

type PackedPluginInstallResult =
  | Readonly<{
      ok: true;
      participant: PackedPluginTestParticipant;
    }>
  | Readonly<{
      ok: false;
      code: string;
      message: string;
    }>;

type PackedPluginInstallCandidate = Readonly<{
  source: PackedPluginTestParticipant['source'];
  archivePath: string;
  archiveDigest: string | null;
  archiveIntegrity: string | null;
  expectedPlugin?: Readonly<{
    id: string;
    version: string;
  }>;
}>;

function isArchiveLocator(locator: string): boolean {
  const pathname = (() => {
    try {
      return new URL(locator).pathname;
    } catch {
      return locator;
    }
  })().toLowerCase();
  return ['.tar.gz', '.tgz', '.tar.xz', '.zip'].some((suffix) => pathname.endsWith(suffix));
}

function createPackedProjectInstallCandidate(
  packed: PackedPlugin,
  locator: string,
): PackedPluginInstallCandidate {
  return Object.freeze({
    source: Object.freeze({ kind: 'project', locator }),
    archivePath: packed.archivePath,
    archiveDigest: packed.archiveDigest,
    archiveIntegrity: packed.archiveIntegrity,
    expectedPlugin: Object.freeze({
      id: packed.pluginId,
      version: packed.version,
    }),
  });
}

async function installPackedPlugin(params: Readonly<{
  daemon: DisposableDaemon;
  candidate: PackedPluginInstallCandidate;
}>): Promise<PackedPluginInstallResult> {
  const requested: PluginChangeRequestResult | Readonly<{ kind: 'unavailable'; code: string }> =
    await requestDaemonPluginChange(
      {
        kind: 'installArchive',
        locator: params.candidate.archivePath,
        ...(params.candidate.archiveIntegrity ? { expectedIntegrity: params.candidate.archiveIntegrity } : {}),
      },
      { target: params.daemon.target },
    );
  if (requested.kind !== 'reviewRequired') {
    return Object.freeze({
      ok: false,
      code: 'plugin_packed_install_review_missing',
      message: `Disposable daemon returned '${requested.kind}' before Install and trust for '${params.candidate.source.locator}' (${describePackedDaemonChangeResult(requested)})`,
    });
  }
  if (requested.review.source.kind !== 'archive') {
    return Object.freeze({
      ok: false,
      code: 'plugin_packed_install_source_mismatch',
      message: `Disposable daemon reviewed '${params.candidate.source.locator}' as '${requested.review.source.kind}' instead of an archive`,
    });
  }
  if (
    params.candidate.expectedPlugin
    && (
      requested.review.pluginId !== params.candidate.expectedPlugin.id
      || requested.review.version !== params.candidate.expectedPlugin.version
    )
  ) {
    return Object.freeze({
      ok: false,
      code: 'plugin_packed_install_identity_mismatch',
      message: `Packed project '${params.candidate.source.locator}' reviewed as '${requested.review.pluginId}@${requested.review.version}' instead of '${params.candidate.expectedPlugin.id}@${params.candidate.expectedPlugin.version}'`,
    });
  }

  const decided: PluginChangeDecisionResult | Readonly<{ kind: 'unavailable'; code: string }> =
    await decideDaemonPluginChange({
      pendingChangeId: requested.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: randomUUID(),
        occurredAtMs: Date.now(),
      },
      optionalSelections: requested.review.optionalHostAccess.map((access) => ({
        accessId: access.id,
        selected: false,
      })),
    }, { target: params.daemon.target });
  // The durable install transaction owns admission. `appliedGeneration` is a
  // separate executable-runtime projection, so an intentionally inert
  // prerequisite can be installed and catalog-visible without one. Action and
  // target-admission paths below still require their exact applied generation.
  if (decided.kind !== 'committed' || decided.desiredGeneration === null) {
    const decisionDetails = describePackedDaemonChangeResult(decided);
    return Object.freeze({
      ok: false,
      code: 'plugin_packed_install_failed',
      message: `Disposable daemon did not commit and admit '${requested.review.pluginId}' (${decisionDetails})`,
    });
  }

  const installedCatalog = await readDaemonPluginCatalog({ target: params.daemon.target });
  if (installedCatalog.kind !== 'available'
    || !installedCatalog.plugins.some((entry) => entry.pluginId === requested.review.pluginId && entry.enabled)) {
    const observed = installedCatalog.kind === 'available'
      ? installedCatalog.plugins.map((entry) => `${entry.pluginId}:${entry.enabled ? 'enabled' : 'disabled'}`).join(', ')
      : `unavailable:${installedCatalog.code}`;
    return Object.freeze({
      ok: false,
      code: 'plugin_packed_catalog_missing',
      message: `Committed plugin '${requested.review.pluginId}' was absent from the daemon-owned catalog (observed: ${observed || 'empty'})`,
    });
  }

  return Object.freeze({
    ok: true,
    participant: Object.freeze({
      source: params.candidate.source,
      plugin: Object.freeze({
        id: requested.review.pluginId,
        version: requested.review.version,
        packageIdentity: Object.freeze({
          name: requested.review.packageIdentity.name,
          version: requested.review.packageIdentity.version,
        }),
      }),
      archive: Object.freeze({
        digest: params.candidate.archiveDigest,
        integrity: requested.review.source.integrity ?? params.candidate.archiveIntegrity,
      }),
      admission: Object.freeze({
        decision: 'installAndTrust',
        desiredGeneration: decided.desiredGeneration,
        appliedGeneration: decided.appliedGeneration,
      }),
    }),
  });
}

export async function runPackedPluginTest(params: Readonly<{
  projectRoot: string;
  sdkRegistryOrigin?: string | null;
  prerequisiteLocators?: readonly string[];
  connectedAccountsFixturePluginId?: string;
  connectedAccountPurposeRemovalReaddActionLocalId?: string;
  expectedRedactedValues?: readonly string[];
}>): Promise<PackedPluginTestResult> {
  const projectRoot = resolve(params.projectRoot);
  const operationRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-packed-test-'));
  const happyHomeDir = join(operationRoot, 'home');
  const archivePath = join(operationRoot, 'plugin.happier-plugin.tgz');
  const prerequisiteCandidates: PackedPluginInstallCandidate[] = [];
  let daemon: DisposableDaemon | null = null;

  try {
    await mkdir(happyHomeDir, { recursive: true });
    for (const [index, rawPrerequisiteLocator] of (params.prerequisiteLocators ?? []).entries()) {
      const locator = rawPrerequisiteLocator.trim();
      if (isArchiveLocator(locator)) {
        const archiveIntegrity = await resolveArchiveExpectedIntegrity({ locator });
        prerequisiteCandidates.push(Object.freeze({
          source: Object.freeze({ kind: 'archive', locator }),
          archivePath: locator,
          archiveDigest: null,
          archiveIntegrity: archiveIntegrity ?? null,
        }));
        continue;
      }
      const prerequisite = await packLocalPlugin({
        locator: resolve(locator),
        outPath: join(operationRoot, `prerequisite-${index}.happier-plugin.tgz`),
        ...(params.sdkRegistryOrigin ? { sdkRegistryOrigin: params.sdkRegistryOrigin } : {}),
      });
      if (!prerequisite.ok) {
        return Object.freeze({
          ok: false,
          mode: 'packed',
          projectRoot,
          diagnostics: projectPackDiagnostics(prerequisite.diagnostics),
        });
      }
      prerequisiteCandidates.push(createPackedProjectInstallCandidate(prerequisite, resolve(locator)));
    }
    const packed = await packLocalPlugin({
      locator: projectRoot,
      outPath: archivePath,
      ...(params.sdkRegistryOrigin ? { sdkRegistryOrigin: params.sdkRegistryOrigin } : {}),
    });
    if (!packed.ok) {
      return Object.freeze({
        ok: false,
        mode: 'packed',
        projectRoot,
        diagnostics: projectPackDiagnostics(packed.diagnostics),
      });
    }

    daemon = await startDisposableDaemon({
      operationRoot,
      happyHomeDir,
      projectRoot,
      ...(params.connectedAccountsFixturePluginId ? {
        connectedAccountsFixturePluginId: params.connectedAccountsFixturePluginId,
      } : {}),
    });
    const authenticatedControl = await verifyAuthenticatedControlBoundary(daemon);
    if (!authenticatedControl) {
      return failure(projectRoot, 'plugin_packed_control_auth_missing', 'Disposable daemon accepted an unauthenticated control request');
    }
    const initialDaemon = daemon;
    const prerequisites: PackedPluginTestParticipant[] = [];
    for (const candidate of prerequisiteCandidates) {
      const prerequisiteInstall = await installPackedPlugin({ daemon, candidate });
      if (!prerequisiteInstall.ok) {
        return failure(projectRoot, prerequisiteInstall.code, prerequisiteInstall.message);
      }
      prerequisites.push(prerequisiteInstall.participant);
    }
    const packedInstall = await installPackedPlugin({
      daemon,
      candidate: createPackedProjectInstallCandidate(packed, projectRoot),
    });
    if (!packedInstall.ok) {
      return failure(projectRoot, packedInstall.code, packedInstall.message);
    }
    let target = packedInstall.participant;

    const actionLocalId = selectEmptyInputCliAction(packed.manifest);
    let initialInvocation: Extract<PackedPluginTestResult, { ok: true }>['initialInvocation'] = null;
    let invocation: Extract<PackedPluginTestResult, { ok: true }>['invocation'] = null;
    let publicationRemovalReadd:
      Extract<PackedPluginTestResult, { ok: true }>['publicationRemovalReadd'];
    if (actionLocalId) {
      const actionId = `${packed.pluginId}/${actionLocalId}`;
      const initialAttempt = await invokeAction({ daemon, actionId });
      if (!initialAttempt.matched) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          `Packed action '${actionId}' was unavailable`,
        );
      }
      if (!initialAttempt.result.ok) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          describePackedActionFailure(initialAttempt.result),
        );
      }
      initialInvocation = Object.freeze({
        actionId,
        result: initialAttempt.result.result,
      });
    }

    await daemon.stop();
    daemon = null;
    const staleCatalog = await readDaemonPluginCatalog({ target: initialDaemon.target });
    if (staleCatalog.kind !== 'unavailable') {
      return failure(projectRoot, 'plugin_packed_stale_incarnation_accepted', 'Stopped daemon incarnation remained addressable');
    }

    daemon = await startDisposableDaemon({
      operationRoot,
      happyHomeDir,
      projectRoot,
      ...(params.connectedAccountsFixturePluginId ? {
        connectedAccountsFixturePluginId: params.connectedAccountsFixturePluginId,
      } : {}),
    });
    if (daemon.ready.incarnationId === initialDaemon.ready.incarnationId || daemon.ready.pid === initialDaemon.ready.pid) {
      return failure(projectRoot, 'plugin_packed_daemon_restart_failed', 'Disposable daemon did not start a fresh incarnation');
    }
    const restartedCatalog = await readDaemonPluginCatalog({ target: daemon.target });
    const expectedInstalledPluginIds = [
      ...prerequisites.map((prerequisite) => prerequisite.plugin.id),
      target.plugin.id,
    ];
    if (restartedCatalog.kind !== 'available'
      || !expectedInstalledPluginIds.every((pluginId) => (
        restartedCatalog.plugins.some((entry) => entry.pluginId === pluginId && entry.enabled)
      ))) {
      const observed = restartedCatalog.kind === 'available'
        ? restartedCatalog.plugins.map((entry) => `${entry.pluginId}:${entry.enabled ? 'enabled' : 'disabled'}`).join(', ')
        : `unavailable:${restartedCatalog.code}`;
      return failure(
        projectRoot,
        'plugin_packed_restart_currentness_failed',
        `Packed plugin set was not current after daemon restart (observed: ${observed || 'empty'})`,
      );
    }

    if (actionLocalId) {
      const actionId = `${packed.pluginId}/${actionLocalId}`;
      const attempt = await invokeAction({ daemon, actionId });
      if (!attempt.matched) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          `Packed action '${actionId}' was not available through the daemon`,
        );
      }
      const actionResult = attempt.result;
      if (!actionResult.ok) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          describePackedActionFailure(actionResult),
        );
      }
      invocation = Object.freeze({
        actionId,
        result: actionResult.result,
      });
    }

    if (params.connectedAccountPurposeRemovalReaddActionLocalId) {
      const removed = await requestDaemonPluginChange({
        kind: 'uninstall',
        pluginId: packed.pluginId,
      }, { target: daemon.target });
      if (
        removed.kind !== 'committed'
        || removed.desiredGeneration !== null
        || removed.appliedGeneration !== null
      ) {
        return failure(
          projectRoot,
          'plugin_packed_removal_failed',
          `Disposable daemon did not commit and publish plugin removal (${describePackedDaemonChangeResult(removed)})`,
        );
      }
      const removedCatalog = await readDaemonPluginCatalog({ target: daemon.target });
      if (
        removedCatalog.kind !== 'available'
        || removedCatalog.plugins.some((entry) => entry.pluginId === packed.pluginId)
      ) {
        const observed = removedCatalog.kind === 'available'
          ? removedCatalog.plugins.map((entry) => entry.pluginId).join(', ')
          : `unavailable:${removedCatalog.code}`;
        return failure(
          projectRoot,
          'plugin_packed_removal_currentness_failed',
          `Removed plugin remained present in the daemon-owned catalog (observed: ${observed || 'empty'})`,
        );
      }

      const readdedInstall = await installPackedPlugin({
        daemon,
        candidate: createPackedProjectInstallCandidate(packed, projectRoot),
      });
      if (!readdedInstall.ok) {
        return failure(
          projectRoot,
          'plugin_packed_readd_failed',
          readdedInstall.message,
        );
      }
      target = readdedInstall.participant;

      const actionId =
        `${packed.pluginId}/${params.connectedAccountPurposeRemovalReaddActionLocalId}`;
      const readdAttempt = await invokeAction({ daemon, actionId });
      if (!readdAttempt.matched) {
        return failure(
          projectRoot,
          'plugin_packed_readd_invocation_failed',
          `Re-added packed action '${actionId}' was unavailable`,
        );
      }
      if (!readdAttempt.result.ok) {
        return failure(
          projectRoot,
          'plugin_packed_readd_invocation_failed',
          describePackedActionFailure(readdAttempt.result),
        );
      }
      publicationRemovalReadd = Object.freeze({
        removed: true,
        readded: true,
        target,
        invocation: Object.freeze({
          actionId,
          result: readdAttempt.result.result,
        }),
      });
    }

    // Project the terminal live state, after every optional mutation. This is
    // deliberately a fresh authenticated current-registry read rather than a
    // carried-forward installation or pre-reload admission result.
    const targetedAdmission = await readPackedTargetedAdmissions({
      daemon,
      target,
      manifest: packed.manifest,
    });
    if (!targetedAdmission.ok) {
      return failure(projectRoot, targetedAdmission.code, targetedAdmission.message);
    }
    const admittedContributors = projectPackedAdmittedContributors({
      prerequisites,
      admissions: targetedAdmission.admissions,
    });
    if (!admittedContributors.ok) {
      return failure(projectRoot, admittedContributors.code, admittedContributors.message);
    }

    const restartedReady = daemon.ready;
    if ((params.expectedRedactedValues?.length ?? 0) > 0) {
      await daemon.stop();
      daemon = null;
      const logsDir = join(happyHomeDir, 'logs');
      const logNames = await readdir(logsDir).catch(() => []);
      const logText = (
        await Promise.all(logNames.map(async (name) => (
          await readFile(join(logsDir, name), 'utf8').catch(() => '')
        )))
      ).join('\n');
      const leakedValue = params.expectedRedactedValues?.find((value) => logText.includes(value));
      if (leakedValue) {
        return failure(
          projectRoot,
          'plugin_packed_secret_redaction_failed',
          'A Connected Accounts materialization value remained visible in plugin invocation logs',
        );
      }
      if (!logText.includes('[REDACTED]')) {
        return failure(
          projectRoot,
          'plugin_packed_secret_redaction_missing',
          'Packed Connected Accounts invocation logs did not contain a redacted materialization value',
        );
      }
    }

    return Object.freeze({
      ok: true,
      mode: 'packed',
      projectRoot,
      // Retain the established compact fields as projections of the richer
      // participant record for existing programmatic consumers.
      pluginId: target.plugin.id,
      archiveDigest: target.archive.digest ?? packed.archiveDigest,
      ...(prerequisites.length > 0 ? {
        prerequisitePlugins: Object.freeze(prerequisites.map((prerequisite) => Object.freeze({
          pluginId: prerequisite.plugin.id,
          archiveDigest: prerequisite.archive.digest,
        }))),
      } : {}),
      target,
      prerequisites: Object.freeze(prerequisites),
      contributors: admittedContributors.contributors,
      initialInvocation,
      invocation,
      ...(publicationRemovalReadd ? { publicationRemovalReadd } : {}),
      daemon: Object.freeze({
        authenticatedControl: true,
        initialPid: initialDaemon.ready.pid,
        restartedPid: restartedReady.pid,
        initialIncarnationId: initialDaemon.ready.incarnationId,
        restartedIncarnationId: restartedReady.incarnationId,
        staleIncarnationRejected: true,
      }),
    });
  } catch (error) {
    return failure(
      projectRoot,
      'plugin_packed_test_failed',
      describePackedThrownFailure(error),
    );
  } finally {
    await daemon?.stop();
    await rm(operationRoot, { recursive: true, force: true });
  }
}
