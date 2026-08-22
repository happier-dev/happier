import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import tweetnacl from 'tweetnacl';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    parseJsonEnvelope,
    runPackedReviewedPluginInstall,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import {
    resolveCliTestLaunchSpec,
    type CliTestLaunchSpec,
} from '../../src/testkit/process/cliLaunchSpec';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
    resolveUiWebBeforeAllTimeoutMs,
    startExistingUiWebExport,
    startUiWeb,
    type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import {
    attestPackedInspectorArtifacts,
    preparePackedCandidateBrowserQa,
    resolvePackedCandidateBrowserQaMaterializationRoot,
    type PackedInspectorArtifactAttestation,
    type PreparedPackedCandidateBrowserQa,
} from '../../src/testkit/pluginPlatform/packedCandidateBrowserQa';
import { parseRnwArtifactDeliveryProjectionDescribeResponse } from '../../src/testkit/pluginPlatform/rnwArtifactDeliveryProjectionResponse';
import { decideAuthenticatedPluginInstallReview } from '../../src/testkit/pluginPlatform/authenticatedInstallReview';
import { repoRootDir } from '../../src/testkit/paths';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { runCliJson, writeRedactedResultArtifact } from '../../src/testkit/uiE2e/cliJson';
import {
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedHomeUi,
    waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { buildVoiceBrowserQaRouteFeatureEnv } from '../../src/testkit/uiE2e/voiceBrowserQaRouteProfile';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';

const execFileAsync = promisify(execFile);
const run = createRunDirs({ runLabel: 'ui-e2e-plugin-rnw-artifact' });
const PLUGIN_ID = 'acme.current-rnw-artifact';
const RENDERER_ID = 'inspector-renderer';
const ARTIFACT_ID = 'inspector-app-native';
const VIEW_ID = 'inspector-app';

type RouteProfile = 'direct' | 'relay';

type CliProcessResult = Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}>;

type RuntimeAttestation = Readonly<{
    generation: number;
    artifactDigest: string;
    cacheKey: string;
    runtimeState: 'loadable';
    runtimeDecision: 'load';
}>;

type PeerTrafficObservation = Readonly<{
    directStages: Array<Readonly<{
        method: string;
        pathname: string;
        status: number | null;
        failure: string | null;
    }>>;
    sentSocketFrames: string[];
}>;

function requireRouteProfile(env: NodeJS.ProcessEnv): RouteProfile {
    const value = env.HAPPIER_E2E_PLUGIN_UI_ARTIFACT_ROUTE_PROFILE?.trim();
    if (value === 'direct' || value === 'relay') return value;
    throw new Error('HAPPIER_E2E_PLUGIN_UI_ARTIFACT_ROUTE_PROFILE must be direct or relay');
}

function resolveDistEntrypointFromLaunchSpec(launchSpec: CliTestLaunchSpec): string {
    for (let index = launchSpec.args.length - 1; index >= 0; index -= 1) {
        const value = launchSpec.args[index];
        if (value?.endsWith('/dist/index.mjs') || value?.endsWith('\\dist\\index.mjs')) {
            return resolve(value);
        }
    }
    throw new Error('RNW current-source QA did not launch an isolated CLI dist snapshot');
}

async function digestDirectory(rootDir: string): Promise<string> {
    const paths: string[] = [];
    const visit = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                await visit(path);
            } else if (entry.isFile()) {
                paths.push(path);
            }
        }
    };
    await visit(rootDir);
    const digest = createHash('sha256');
    for (const path of paths) {
        const pathFromRoot = relative(rootDir, path).replaceAll('\\', '/');
        const bytes = await readFile(path);
        digest.update(`${pathFromRoot}\0${bytes.byteLength}\0`);
        digest.update(bytes);
        digest.update('\0');
    }
    return digest.digest('hex');
}

async function attestLoadedUiExport(page: Page): Promise<Readonly<{
    digest: string;
    scriptPaths: readonly string[];
}>> {
    const scriptUrls = await page.locator('script[src]').evaluateAll((scripts) =>
        Array.from(new Set(scripts
            .map((script) => (script as HTMLScriptElement).src)
            .filter((src) => src.startsWith('http://') || src.startsWith('https://'))))
            .sort(),
    );
    if (scriptUrls.length === 0) {
        throw new Error('RNW browser runtime did not expose a loaded export script');
    }
    const digest = createHash('sha256');
    const scriptPaths: string[] = [];
    for (const scriptUrl of scriptUrls) {
        const response = await page.request.get(scriptUrl);
        if (!response.ok()) {
            throw new Error(`RNW browser runtime script attestation failed: ${response.status()}`);
        }
        const bytes = await response.body();
        const path = new URL(scriptUrl).pathname;
        scriptPaths.push(path);
        digest.update(`${path}\0${bytes.byteLength}\0`);
        digest.update(bytes);
        digest.update('\0');
    }
    return Object.freeze({
        digest: digest.digest('hex'),
        scriptPaths: Object.freeze(scriptPaths),
    });
}

function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string): string {
    const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
    url.searchParams.set('server', serverBaseUrl);
    return url.toString();
}

async function runCliLaunchAllowFailure(input: Readonly<{
    cliLaunchSpec: CliTestLaunchSpec;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
}>): Promise<CliProcessResult> {
    try {
        const result = await execFileAsync(
            input.cliLaunchSpec.command,
            [...input.cliLaunchSpec.args, ...input.args],
            {
                cwd: input.cliLaunchSpec.cwd ?? input.cwd,
                env: {
                    ...input.env,
                    ...(input.cliLaunchSpec.env ?? {}),
                },
                timeout: input.timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
                encoding: 'utf8',
            },
        );
        return {
            code: 0,
            signal: null,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    } catch (error) {
        const failed = error as Readonly<{
            code?: unknown;
            signal?: unknown;
            stdout?: unknown;
            stderr?: unknown;
        }>;
        if (typeof failed.code !== 'number') throw error;
        return {
            code: failed.code,
            signal: typeof failed.signal === 'string'
                ? failed.signal as NodeJS.Signals
                : null,
            stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
            stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
        };
    }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function recordAt(value: unknown, path: readonly string[]): Readonly<Record<string, unknown>> | null {
    let current = asRecord(value);
    for (const key of path) {
        current = asRecord(current?.[key]);
        if (!current) return null;
    }
    return current;
}

function observePeerTraffic(page: Page): PeerTrafficObservation {
    const directStages: PeerTrafficObservation['directStages'][number][] = [];
    const sentSocketFrames: string[] = [];
    const isDirectRequest = (rawUrl: string): boolean => {
        const pathname = new URL(rawUrl).pathname;
        return pathname === '/v1/machines/peer/mediation/route-grants'
            || pathname.startsWith('/peer-mediation/');
    };
    page.on('response', (response) => {
        if (!isDirectRequest(response.url())) return;
        const url = new URL(response.url());
        directStages.push({
            method: response.request().method(),
            pathname: url.pathname,
            status: response.status(),
            failure: null,
        });
    });
    page.on('requestfailed', (request) => {
        if (!isDirectRequest(request.url())) return;
        const url = new URL(request.url());
        directStages.push({
            method: request.method(),
            pathname: url.pathname,
            status: null,
            failure: request.failure()?.errorText ?? 'request_failed',
        });
    });
    page.on('websocket', (websocket) => {
        websocket.on('framesent', ({ payload }) => {
            if (typeof payload === 'string') {
                sentSocketFrames.push(payload.slice(0, 16_384));
            }
        });
    });
    return { directStages, sentSocketFrames };
}

function externalInspectorManifest(version: string): Readonly<Record<string, unknown>> {
    return {
        schemaVersion: 2,
        id: PLUGIN_ID,
        version,
        displayName: 'Current RNW artifact fixture',
        description: 'Current generated Inspector bytes installed as an external RNW artifact fixture.',
        engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' },
        hostAccess: { required: [], optional: [] },
        contributes: {
            // The copied Inspector daemon entry registers this action during
            // activation. Keep the external fixture's admitted manifest
            // truthful so final-policy activation can apply the generation.
            actions: [{
                id: 'self-check',
                title: 'Run Inspector self-check',
                description: 'Verify the Inspector action bridge.',
                scopes: ['global'],
                surfaces: ['ui'],
                placementBindings: ['toolbar'],
                dangerLevel: 'safe',
                execution: { target: 'daemon' },
                resultSchema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok'],
                },
            }],
            ui: {
                views: [{
                    id: VIEW_ID,
                    container: 'rightSidebarTab',
                    target: { kind: 'app' },
                    renderer: RENDERER_ID,
                    title: 'Current RNW artifact',
                }],
                renderers: [{
                    id: RENDERER_ID,
                    kind: 'reactNative',
                    artifact: ARTIFACT_ID,
                    requiredHostMethods: ['executeAction'],
                }],
                translations: [],
            },
        },
    };
}

async function createExternalInspectorArchive(input: Readonly<{
    packedInspectorRoot: string;
    targetRoot: string;
    archivePath: string;
    version: string;
    tamperWebEntry?: boolean;
}>): Promise<Readonly<{ webByteSize: number }>> {
    await mkdir(input.targetRoot, { recursive: true });
    await cp(join(input.packedInspectorRoot, 'dist'), join(input.targetRoot, 'dist'), {
        recursive: true,
    });
    const sourcePackage = JSON.parse(
        await readFile(join(input.packedInspectorRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(join(input.targetRoot, 'package.json'), `${JSON.stringify({
        ...sourcePackage,
        name: '@acme/current-rnw-artifact',
        version: input.version,
        private: false,
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['dist', '.happier-plugin/plugin.json', 'package.json'],
    }, null, 2)}\n`, 'utf8');
    await mkdir(join(input.targetRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
        join(input.targetRoot, '.happier-plugin', 'plugin.json'),
        `${JSON.stringify(externalInspectorManifest(input.version), null, 2)}\n`,
        'utf8',
    );

    const artifactRoot = join(input.targetRoot, 'dist', 'happier-plugin-ui');
    const graph = JSON.parse(
        await readFile(join(artifactRoot, 'ui-artifacts.json'), 'utf8'),
    ) as {
        entries?: Array<{
            contributionId?: unknown;
            platform?: unknown;
            entry?: unknown;
            files?: Array<{ byteSize?: unknown }>;
        }>;
    };
    const webEntry = graph.entries?.find((entry) =>
        entry.contributionId === ARTIFACT_ID && entry.platform === 'web');
    if (!webEntry || typeof webEntry.entry !== 'string' || !Array.isArray(webEntry.files)) {
        throw new Error('packed Inspector web artifact graph is incomplete');
    }
    const webByteSize = webEntry.files.reduce(
        (total, file) => total + (typeof file.byteSize === 'number' ? file.byteSize : 0),
        0,
    );
    if (input.tamperWebEntry) {
        await appendFile(join(artifactRoot, webEntry.entry), '\n/* tampered after generation */\n');
    }
    await execFileAsync('tar', [
        '-czf',
        input.archivePath,
        '-C',
        dirname(input.targetRoot),
        basename(input.targetRoot),
    ], {
        env: {
            ...process.env,
            COPYFILE_DISABLE: '1',
        },
    });
    return { webByteSize };
}

function attestExternalInspectorRuntime(projectionResponse: unknown): RuntimeAttestation {
    const projection = recordAt(projectionResponse, ['projection']);
    const generation = projection?.generation;
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
        throw new Error(
            `external Inspector projection generation is missing: ${JSON.stringify(projectionResponse)}`,
        );
    }
    const entries = recordAt(projection, ['familiesById', 'pluginUi', 'entriesById']);
    const bundle = asRecord(entries?.[`reactNativeBundle:${PLUGIN_ID}:${RENDERER_ID}`]);
    const graph = recordAt(bundle, ['artifactGraph']);
    const runtime = recordAt(bundle, ['runtime']);
    const decision = recordAt(runtime, ['decision']);
    const identity = recordAt(runtime, ['cacheIdentity']);
    const loadPolicy = recordAt(runtime, ['loadPolicy']);
    if (
        graph?.contributionId !== ARTIFACT_ID
        || graph.platform !== 'web'
        || typeof graph.digest !== 'string'
        || runtime?.state !== 'loadable'
        || decision?.state !== 'load'
        || loadPolicy?.source !== 'installedArtifact'
        || identity?.artifactDigest !== graph.digest
        || identity.projectionGeneration !== generation
        || typeof runtime.cacheKey !== 'string'
    ) {
        throw new Error('external Inspector RNW runtime is not loadable from the installed artifact');
    }
    return {
        generation,
        artifactDigest: graph.digest,
        cacheKey: runtime.cacheKey,
        runtimeState: 'loadable',
        runtimeDecision: 'load',
    };
}

test.describe('plugin UI: current generated RNW artifact delivery', () => {
    test.describe.configure({ mode: 'serial' });

    const routeProfile = requireRouteProfile(process.env);
    const suiteDir = run.testDir(`plugin-rnw-artifact-${routeProfile}`);
    const cliHomeDir = join(suiteDir, 'cli-home');
    const storageScope = `e2e-plugin-rnw-${routeProfile}-${run.runId}`;
    const uiWebMode = String(process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'export').trim();

    let candidate: PreparedPackedCandidateBrowserQa | null = null;
    let inspectorAttestation: PackedInspectorArtifactAttestation | null = null;
    let inspectorPackageRoot: string | null = null;
    let runtimeBasis: Readonly<Record<string, unknown>> | null = null;
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;
    let currentCliLaunchSpec: CliTestLaunchSpec | null = null;
    let uiBaseUrl: string | null = null;
    let directPeerBindPort = 0;

    test.beforeAll(async () => {
        test.setTimeout(Math.max(resolveUiWebBeforeAllTimeoutMs(process.env), 900_000));
        await mkdir(cliHomeDir, { recursive: true });
        const candidateManifestPath =
            process.env.HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST?.trim() || null;
        if (candidateManifestPath) {
            candidate = await preparePackedCandidateBrowserQa({
                candidateManifestPath: resolve(candidateManifestPath),
                materializationRoot: resolvePackedCandidateBrowserQaMaterializationRoot({
                    env: process.env,
                    defaultRoot: join(suiteDir, 'packed-candidate-cli'),
                }),
            });
            const cliPackageRoot = resolve(dirname(candidate.attestation.cliEntrypoint), '..');
            inspectorPackageRoot = join(
                cliPackageRoot,
                'node_modules',
                '@happier-dev',
                'plugins-inspector',
            );
            inspectorAttestation = await attestPackedInspectorArtifacts({
                cliEntrypoint: candidate.attestation.cliEntrypoint,
            });
            runtimeBasis = Object.freeze({
                mode: 'packedCandidate',
                candidateRunId: candidate.attestation.runId,
                cliVersion: candidate.attestation.cliVersion,
                cliIntegrity: candidate.attestation.cliIntegrity,
                cliEntrypoint: candidate.attestation.cliEntrypoint,
            });
        } else {
            const root = repoRootDir();
            const cliPackage = JSON.parse(
                await readFile(join(root, 'apps', 'cli', 'package.json'), 'utf8'),
            ) as { version?: unknown };
            runtimeBasis = Object.freeze({
                mode: 'currentDistSnapshot',
                cliVersion: typeof cliPackage.version === 'string' ? cliPackage.version : null,
            });
        }
        directPeerBindPort = await reserveAvailablePort();
        const signingKeys = tweetnacl.sign.keyPair();
        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                NODE_ENV: process.env.NODE_ENV ?? 'test',
                ...buildVoiceBrowserQaRouteFeatureEnv(routeProfile, directPeerBindPort),
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'plugin-rnw-route-key',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY:
                    Buffer.from(signingKeys.secretKey).toString('base64url'),
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY:
                    Buffer.from(signingKeys.publicKey).toString('base64url'),
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT:
                    String(Date.now() + 60 * 60 * 1000),
            },
        });
        const uiEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
            HAPPIER_E2E_UI_WEB_MODE: uiWebMode,
            EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        };
        const existingUiDistDir = process.env.HAPPIER_E2E_UI_WEB_EXISTING_DIST_DIR?.trim() ?? '';
        ui = existingUiDistDir
            ? await startExistingUiWebExport({
                testDir: suiteDir,
                env: uiEnv,
                distDir: existingUiDistDir,
            })
            : await startUiWeb({
                testDir: suiteDir,
                env: uiEnv,
            });
        if (!candidate) {
            currentCliLaunchSpec = await resolveCliTestLaunchSpec(
                {
                    testDir: suiteDir,
                    env: process.env,
                },
                {
                    snapshotDir: join(suiteDir, 'cli-runtime'),
                    skipDistIntegrityCheck: false,
                    skipSourceFreshnessCheck: false,
                },
            );
            const cliEntrypoint = resolveDistEntrypointFromLaunchSpec(currentCliLaunchSpec);
            const cliSnapshotRoot = resolve(dirname(cliEntrypoint), '..');
            inspectorPackageRoot = join(
                cliSnapshotRoot,
                'node_modules',
                '@happier-dev',
                'plugins-inspector',
            );
            inspectorAttestation = await attestPackedInspectorArtifacts({ cliEntrypoint });
            runtimeBasis = Object.freeze({
                ...runtimeBasis,
                cliEntrypoint,
                cliDistDigest: await digestDirectory(dirname(cliEntrypoint)),
                inspectorGraphPath: join(
                    inspectorPackageRoot,
                    'dist',
                    'happier-plugin-ui',
                    'ui-artifacts.json',
                ),
                uiMode: ui.mode,
            });
        }
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterEach(async () => {
        await daemon?.stop().catch(() => {});
        daemon = null;
    });

    test.afterAll(async () => {
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
        await candidate?.cleanup();
        candidate = null;
    });

    test(`installs, ${routeProfile}-retrieves, replaces, rejects tamper, recovers, and uninstalls`, async ({ page }, testInfo) => {
        test.setTimeout(900_000);
        if (
            !runtimeBasis
            || !server
            || !uiBaseUrl
            || !inspectorAttestation
            || !inspectorPackageRoot
        ) {
            throw new Error('plugin RNW live stack was not prepared');
        }

        const testDir = join(suiteDir, 'lifecycle');
        await mkdir(testDir, { recursive: true });
        const archives = {
            v1: join(testDir, 'plugin-v1.tgz'),
            v2: join(testDir, 'plugin-v2.tgz'),
            bad: join(testDir, 'plugin-bad.tgz'),
            v3: join(testDir, 'plugin-v3.tgz'),
        };
        const v1Fixture = await createExternalInspectorArchive({
            packedInspectorRoot: inspectorPackageRoot,
            targetRoot: join(testDir, 'fixture-v1', 'package'),
            archivePath: archives.v1,
            version: '0.1.0',
        });
        await createExternalInspectorArchive({
            packedInspectorRoot: inspectorPackageRoot,
            targetRoot: join(testDir, 'fixture-v2', 'package'),
            archivePath: archives.v2,
            version: '0.2.0',
        });
        await createExternalInspectorArchive({
            packedInspectorRoot: inspectorPackageRoot,
            targetRoot: join(testDir, 'fixture-bad', 'package'),
            archivePath: archives.bad,
            version: '0.2.1',
            tamperWebEntry: true,
        });
        await createExternalInspectorArchive({
            packedInspectorRoot: inspectorPackageRoot,
            targetRoot: join(testDir, 'fixture-v3', 'package'),
            archivePath: archives.v3,
            version: '0.3.0',
        });

        const auth = await createTestAuth(server.baseUrl);
        const machineKey = auth.accountMachineKey;
        const seeded = await seedCliAuthForTestAccount({
            cliHome: cliHomeDir,
            serverUrl: server.baseUrl,
            auth,
            mode: 'dataKey',
        });
        await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
            serverUrl: server.baseUrl,
            auth,
            mode: 'dataKey',
            storageScope,
        }));
        const daemonEnv: NodeJS.ProcessEnv = {
            ...process.env,
            CI: '1',
            HAPPIER_HOME_DIR: cliHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: uiBaseUrl,
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
            HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT: String(directPeerBindPort),
        };
        const cliLaunchSpec = candidate?.cliLaunchSpec ?? currentCliLaunchSpec;
        if (!cliLaunchSpec) throw new Error('RNW current CLI dist snapshot was not prepared');
        const activeRuntimeBasis = runtimeBasis;
        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: cliHomeDir,
            cliLaunchSpec,
            env: daemonEnv,
        });
        const cliParams = {
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: daemonEnv,
            cliLaunchSpec,
        } as const;
        const runReviewCli = async (input: Readonly<{
            cwd?: string;
            env?: NodeJS.ProcessEnv;
            args: readonly string[];
        }>): Promise<CliProcessResult> => await runCliLaunchAllowFailure({
            cliLaunchSpec,
            args: input.args,
            cwd: input.cwd ?? repoRootDir(),
            env: input.env ?? daemonEnv,
            timeoutMs: 240_000,
        });
        const decideInstallReview = async (input: Readonly<{
            happyHomeDir: string;
            pendingChangeId: string;
            review: unknown;
        }>) => {
            const review = asRecord(input.review);
            if (
                input.happyHomeDir !== cliHomeDir
                || review?.pluginId !== PLUGIN_ID
                || typeof review.displayName !== 'string'
                || review.displayName.trim().length === 0
                || typeof review.version !== 'string'
                || review.version.trim().length === 0
                || !Array.isArray(review.optionalHostAccess)
            ) {
                throw new Error('RNW install review did not present the exact current plugin facts');
            }
            const optionalSelections = review.optionalHostAccess.map((value) => {
                const access = asRecord(value);
                if (typeof access?.id !== 'string' || access.id.trim().length === 0) {
                    throw new Error('RNW install review contained an invalid optional access identity');
                }
                return { accessId: access.id, selected: false };
            });
            const outcome = await decideAuthenticatedPluginInstallReview({
                cliHomeDir,
                serverUrl: server!.baseUrl,
                pendingChangeId: input.pendingChangeId,
                optionalSelections,
                confirmPresentUser: async () => true,
            });
            if (
                outcome.kind !== 'committed'
                || outcome.pluginId !== PLUGIN_ID
                || typeof outcome.desiredGeneration !== 'string'
                || outcome.desiredGeneration.length === 0
                || typeof outcome.appliedGeneration !== 'string'
                || outcome.appliedGeneration !== outcome.desiredGeneration
                || !Array.isArray(outcome.pendingSurfaces)
            ) {
                throw new Error(`RNW reviewed install did not commit and apply: ${JSON.stringify(outcome)}`);
            }
            return outcome;
        };
        const installReviewed = async (
            archivePath: string,
        ): Promise<Readonly<{ ok: true; kind: 'plugins_install'; data: unknown }>> => {
            const reviewed = await runPackedReviewedPluginInstall({
                cliEntrypoint: activeRuntimeBasis.mode === 'packedCandidate'
                    ? String(activeRuntimeBasis.cliEntrypoint)
                    : String(activeRuntimeBasis.cliEntrypoint),
                cwd: repoRootDir(),
                env: daemonEnv,
                args: ['plugins', 'install', archivePath, '--json'],
                decideInstallReview,
                runCli: runReviewCli,
            });
            return { ok: true, kind: 'plugins_install', data: reviewed.change };
        };
        const installRejected = async (archivePath: string): Promise<Record<string, unknown>> => {
            const result = await runReviewCli({
                cwd: repoRootDir(),
                env: daemonEnv,
                args: ['plugins', 'install', archivePath, '--json'],
            });
            if (result.code === 0 || result.signal !== null) {
                throw new Error('Tampered RNW archive unexpectedly installed');
            }
            return parseJsonEnvelope(result.stdout, 'tampered_rnw_plugin_install');
        };
        const describeProjection = async (): Promise<unknown> => {
            const socket = createUserScopedSocketCollector(server!.baseUrl, auth.token, {
                captureEvents: false,
            });
            socket.connect();
            try {
                await waitFor(() => socket.isConnected(), {
                    timeoutMs: 20_000,
                    context: 'external Inspector projection socket',
                });
                return parseRnwArtifactDeliveryProjectionDescribeResponse(
                    unwrapDataKeyRpcResult(await createDataKeyRpcClient(socket, machineKey).call(
                    `${seeded.machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
                    {
                        machineId: seeded.machineId,
                        reactNativeWebLoaderCapability: {
                            integrated: true,
                            installedArtifactLoaderAvailable: true,
                        },
                    },
                    60_000,
                ), 'external Inspector contribution projection'),
                );
            } finally {
                socket.close();
            }
        };

        expect(await installReviewed(archives.v1)).toMatchObject({
            ok: true,
            kind: 'plugins_install',
        });
        const runtimeV1 = attestExternalInspectorRuntime(await describeProjection());
        expect(runtimeV1.artifactDigest).toBe(inspectorAttestation.webArtifactDigest);

        const traffic = observePeerTraffic(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        const mountStartedAt = Date.now();
        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins/panels?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins/panels',
            requiredTestIds: ['settings.plugins.appPanels.host'],
            timeoutMs: 180_000,
        });
        const loadedUiRuntime = await attestLoadedUiExport(page);
        const externalTab = page.getByTestId(
            `app-scope-right-sidebar-tab:plugin:${PLUGIN_ID}:${VIEW_ID}`,
        );
        const directRpcStages = () => traffic.directStages.filter((entry) =>
            entry.pathname === '/peer-mediation/v2/rpc'
            || entry.pathname === '/peer-mediation/v1/rpc');
        const relayArtifactFrames = () => traffic.sentSocketFrames.filter((frame) =>
            frame.includes(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ));
        await expect(externalTab).toHaveRole('tab');
        await expect(externalTab).toHaveAccessibleName('Current RNW artifact');
        await externalTab.focus();
        await expect(externalTab).toBeFocused();
        const transportCountBeforeExternalMount = routeProfile === 'direct'
            ? directRpcStages().filter((entry) => entry.status === 200).length
            : relayArtifactFrames().length;
        await page.keyboard.press('Enter');
        await expect(externalTab).toHaveAttribute('aria-selected', 'true');
        const targetBox = await externalTab.boundingBox();
        expect(targetBox?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(targetBox?.height ?? 0).toBeGreaterThanOrEqual(44);
        const inspectorSurface = page.getByTestId('inspector-surface');
        await expect(inspectorSurface).toBeVisible({ timeout: 180_000 });
        const inspectorPlugin = page.getByTestId(`inspector-plugin-${PLUGIN_ID}`);
        await expect(inspectorPlugin).toBeVisible();
        const interactionBoundary = page.getByTestId(
            `plugin-surface-interaction-boundary:surfacePlacement:${PLUGIN_ID}:${VIEW_ID}`,
        );
        await expect(interactionBoundary).toHaveAttribute(
            'data-plugin-interaction-state',
            'enabled',
        );
        const initialMountLatencyMs = Date.now() - mountStartedAt;
        await inspectorPlugin.click();
        const reloadSelected = page.getByTestId(`inspector-reload-selected-${PLUGIN_ID}`);
        await expect(reloadSelected).toBeVisible();
        await reloadSelected.focus();
        await expect(reloadSelected).toBeFocused();
        await expect(page.getByTestId('inspector-last-reload')).toHaveCount(0);
        await page.waitForTimeout(1_000);

        if (routeProfile === 'direct') {
            await expect.poll(() => directRpcStages().filter((entry) => entry.status === 200).length, {
                timeout: 60_000,
            }).toBeGreaterThan(transportCountBeforeExternalMount);
            expect(relayArtifactFrames()).toHaveLength(0);
        } else {
            await expect.poll(() => relayArtifactFrames().length, {
                timeout: 60_000,
            }).toBeGreaterThan(transportCountBeforeExternalMount);
            expect(directRpcStages()).toHaveLength(0);
        }

        expect(await installReviewed(archives.v2)).toMatchObject({
            ok: true,
            kind: 'plugins_install',
        });
        const runtimeV2 = attestExternalInspectorRuntime(await describeProjection());
        expect(runtimeV2.generation).not.toBe(runtimeV1.generation);
        expect(runtimeV2.artifactDigest).toBe(runtimeV1.artifactDigest);
        expect(runtimeV2.cacheKey).not.toBe(runtimeV1.cacheKey);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins/panels',
            requiredTestIds: ['settings.plugins.appPanels.host'],
            timeoutMs: 180_000,
        });
        await page.getByTestId(
            `app-scope-right-sidebar-tab:plugin:${PLUGIN_ID}:${VIEW_ID}`,
        ).click();
        await expect(page.getByTestId('inspector-surface')).toBeVisible({ timeout: 180_000 });

        const rejected = await installRejected(archives.bad);
        expect(rejected.ok).toBe(false);
        const runtimeAfterRejectedTamper = attestExternalInspectorRuntime(await describeProjection());
        expect(runtimeAfterRejectedTamper).toEqual(runtimeV2);
        await expect(page.getByTestId('inspector-surface')).toBeVisible();

        expect(await installReviewed(archives.v3)).toMatchObject({
            ok: true,
            kind: 'plugins_install',
        });
        const runtimeV3 = attestExternalInspectorRuntime(await describeProjection());
        expect(runtimeV3.generation).not.toBe(runtimeV2.generation);
        expect(runtimeV3.cacheKey).not.toBe(runtimeV2.cacheKey);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins/panels',
            requiredTestIds: ['settings.plugins.appPanels.host'],
            timeoutMs: 180_000,
        });
        await page.getByTestId(
            `app-scope-right-sidebar-tab:plugin:${PLUGIN_ID}:${VIEW_ID}`,
        ).click();
        await expect(page.getByTestId('inspector-surface')).toBeVisible({ timeout: 180_000 });

        const reconnectedInteractionBoundary = page.getByTestId(
            `plugin-surface-interaction-boundary:surfacePlacement:${PLUGIN_ID}:${VIEW_ID}`,
        );
        const reconnectedPlugin = page.getByTestId(`inspector-plugin-${PLUGIN_ID}`);
        await expect(reconnectedPlugin).toBeVisible();
        await reconnectedPlugin.click();
        const reconnectedReloadSelected = page.getByTestId(
            `inspector-reload-selected-${PLUGIN_ID}`,
        );
        await expect(reconnectedReloadSelected).toBeVisible();
        const lastReloadSummary = page.getByTestId('inspector-last-reload');
        await reconnectedReloadSelected.focus();
        await expect(reconnectedReloadSelected).toBeFocused();
        await page.context().setOffline(true);
        await expect(page.getByTestId('inspector-surface')).toBeVisible();
        await expect(reconnectedInteractionBoundary).toHaveAttribute(
            'data-plugin-interaction-state',
            'offline-snapshot',
            { timeout: 180_000 },
        );
        await expect(reconnectedInteractionBoundary).toHaveAttribute('inert', '');
        await expect(reconnectedInteractionBoundary).toHaveAttribute('aria-hidden', 'true');
        await expect(reconnectedReloadSelected).not.toBeFocused();
        await expect(lastReloadSummary).toHaveCount(0);
        await reconnectedReloadSelected.dispatchEvent('click');
        await reconnectedReloadSelected.focus();
        await page.keyboard.press('Enter');
        await expect(reconnectedReloadSelected).not.toBeFocused();
        await expect(lastReloadSummary).toHaveCount(0);

        await page.context().setOffline(false);
        await expect(reconnectedInteractionBoundary).toHaveAttribute(
            'data-plugin-interaction-state',
            'enabled',
            { timeout: 180_000 },
        );
        await expect(reconnectedInteractionBoundary).not.toHaveAttribute('inert');
        await expect(reconnectedInteractionBoundary).not.toHaveAttribute('aria-hidden', 'true');
        await expect(reconnectedReloadSelected).toBeFocused();
        await expect(reconnectedReloadSelected).toBeVisible();
        expect(attestExternalInspectorRuntime(await describeProjection())).toEqual(runtimeV3);
        await page.keyboard.press('Enter');
        await expect(lastReloadSummary).toContainText(
            'Last reload succeeded',
            { timeout: 180_000 },
        );

        await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
        await page.evaluate(() => {
            document.documentElement.dir = 'rtl';
            document.documentElement.style.zoom = '2';
        });
        await expect(page.getByTestId('inspector-surface')).toBeVisible();
        await externalTab.focus().catch(() => {});
        await page.screenshot({
            path: join(testDir, `plugin-rnw-${routeProfile}.png`),
            fullPage: true,
        });
        await page.evaluate(() => {
            document.documentElement.dir = 'ltr';
            document.documentElement.style.zoom = '1';
        });
        await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });

        expect(await runCliJson({
            ...cliParams,
            label: 'rnw-uninstall',
            args: ['plugins', 'uninstall', PLUGIN_ID, '--json'],
            timeoutMs: 180_000,
        })).toMatchObject({ ok: true, kind: 'plugins_uninstall' });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins/panels',
            requiredTestIds: ['settings.plugins.appPanels.host'],
            timeoutMs: 180_000,
        });
        await expect(page.getByTestId(
            `app-scope-right-sidebar-tab:plugin:${PLUGIN_ID}:${VIEW_ID}`,
        )).toHaveCount(0, { timeout: 180_000 });

        const transportEvidence = {
            routeProfile,
            directStages: traffic.directStages,
            relayArtifactFrameCount: relayArtifactFrames().length,
        };
        await testInfo.attach(`plugin-rnw-${routeProfile}-transport.json`, {
            body: Buffer.from(JSON.stringify(transportEvidence, null, 2)),
            contentType: 'application/json',
        });
        await writeRedactedResultArtifact({
            testDir,
            artifactName: `plugin-rnw-${routeProfile}.result.json`,
            label: `plugin-rnw-${routeProfile}`,
            outcome: {
                routeProfile,
                runtimeBasisJson: JSON.stringify(runtimeBasis),
                loadedUiRuntimeJson: JSON.stringify(loadedUiRuntime),
                daemonPid: daemon.state.pid,
                daemonStartedWithCliVersion: daemon.state.startedWithCliVersion ?? null,
                inspectorWebArtifactDigest: runtimeV3.artifactDigest,
                inspectorIosArtifactDigest: inspectorAttestation.iosArtifactDigest,
                inspectorAndroidArtifactDigest: inspectorAttestation.androidArtifactDigest,
                inspectorRepackContainerName: inspectorAttestation.repackContainerName,
                inspectorRepackModulePath: inspectorAttestation.repackModulePath,
                inspectorRepackExportName: inspectorAttestation.repackExportName,
                graphByteSize: v1Fixture.webByteSize,
                initialMountLatencyMs,
                initialProjectionGeneration: runtimeV1.generation,
                initialCacheKey: runtimeV1.cacheKey,
                replacedProjectionGeneration: runtimeV2.generation,
                replacedCacheKey: runtimeV2.cacheKey,
                recoveredProjectionGeneration: runtimeV3.generation,
                recoveredCacheKey: runtimeV3.cacheKey,
                directRpcCount: directRpcStages().length,
                relayArtifactFrameCount: relayArtifactFrames().length,
                hostCallSucceeded: true,
                tamperedUpdateRejected: true,
                previousGenerationPreserved: true,
                cacheIdentityReplaced: true,
                recovered: true,
                offlineMountedSurfacePreserved: true,
                offlinePointerActivationBlocked: true,
                offlineKeyboardActivationBlocked: true,
                offlineAccessibilityInteractionBlocked: true,
                reconnectFocusRestored: true,
                reconnectReloadRecovered: true,
                uninstalled: true,
                keyboardFocusVerified: true,
                targetSizeVerified: true,
                reducedMotionVerified: true,
                highContrastVerified: true,
                rtlVerified: true,
                zoom200Verified: true,
            },
        });
    });
});
