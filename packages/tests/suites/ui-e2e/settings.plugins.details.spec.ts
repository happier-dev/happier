import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import {
    renderPrismaCompatibleSqliteDatabaseUrl,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
    resolveUiWebBeforeAllTimeoutMs,
    startUiWeb,
    type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import { resolveUiWebSourceFingerprint } from '../../src/testkit/process/uiWebSourceFingerprint';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { writeRuntimeProjectionPluginFixture } from '../../src/testkit/extensions/localPackageFixture';
import { repoRootDir } from '../../src/testkit/paths';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import {
    createSessionScopedSocketCollector,
    createUserScopedSocketCollector,
    type SocketCollector,
} from '../../src/testkit/socketClient';
import { fetchJson } from '../../src/testkit/http';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { runCliJson, writeRedactedResultArtifact, type JsonEnvelope } from '../../src/testkit/uiE2e/cliJson';
import {
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedHomeUi,
    waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import {
    attestCandidateInspectorRuntime,
    attestPackedPublicAuthoringHostedWebRuntime,
    preparePackedCandidateBrowserQa,
    preparePackedNovelConnectedAccountBrowserQa,
    resolvePackedCandidateBrowserQaBeforeAllTimeoutMs,
    resolvePackedCandidateBrowserQaMaterializationRoot,
    type PreparedPackedCandidateBrowserQa,
    type PreparedPackedNovelConnectedAccountBrowserQa,
} from '../../src/testkit/pluginPlatform/packedCandidateBrowserQa';
import {
    decideAuthenticatedPluginInstallReview,
    readPluginInstallReviewRequiredEnvelope,
} from '../../src/testkit/pluginPlatform/authenticatedInstallReview';
import {
    startPackedNovelConnectedAccountProvider,
    type StartedPackedNovelConnectedAccountProvider,
} from '../../src/testkit/pluginPlatform/packedNovelConnectedAccountProvider';
import {
    findSensitiveArtifactFiles,
} from '../../src/testkit/pluginPlatform/sensitiveArtifactScan';

const run = createRunDirs({ runLabel: 'ui-e2e' });

type StartedPluginCatalogServer = Readonly<{
    catalogUrl: string;
    setRelease: (release: Readonly<{ version: string; archivePath: string }>) => void;
    close: () => Promise<void>;
}>;

type PackedVoiceProviderRequest = Readonly<{
    method: string;
    pathname: string;
    authorizationMatched: boolean;
    contentType: string;
    bodyByteLength: number;
    body: unknown;
    clientAuthArtifact: Readonly<{
        kind: 'bearer_token';
        value: string;
        expiresAtMs: number;
        placement: 'authorization_header';
    }> | null;
}>;

type StartedPackedVoiceProviderServer = Readonly<{
    origin: string;
    caCertificatePath: string;
    requests: readonly PackedVoiceProviderRequest[];
    close: () => Promise<void>;
}>;

const execFileAsync = promisify(execFile);
const PACKED_VOICE_PLUGIN_ID = 'acme.packed-voice';
const PACKED_VOICE_PROVIDER_LOCAL_ID = 'conversation-mediated';
const PACKED_VOICE_PROVIDER_ID = `${PACKED_VOICE_PLUGIN_ID}/${PACKED_VOICE_PROVIDER_LOCAL_ID}`;
const PACKED_VOICE_PROVIDER_TITLE = 'Packed Conversation';
const PACKED_VOICE_FIXTURE_EVENTS_KEY = '__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__';
const PACKED_VOICE_PROVIDER_ROW_TEST_ID = `settings.voice.provider.${encodeURIComponent(PACKED_VOICE_PROVIDER_ID)}.default`;
const PACKED_VOICE_CREDENTIAL_TEST_ID = `settings.voice.externalCredential.${encodeURIComponent(PACKED_VOICE_PROVIDER_ID)}.api_key`;
const PACKED_VOICE_PROVISIONING_SETTING_TEST_ID =
    `settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.settings.${PACKED_VOICE_PROVIDER_ID}.enableProvisioning`;
const PACKED_VOICE_CANONICAL_ORIGIN = 'https://voice.example.test';
const PACKED_CONNECTED_ACCOUNT_COLLISION_FIXTURES = [{
    pluginId: 'acme.connected-accounts-conformance-producer',
    localId: 'vault',
    sourceDirectory: 'connectedAccountsConformanceProducer',
    serviceTitle: 'Acme Vault conformance account',
}, {
    pluginId: 'acme.connected-accounts-collision-peer',
    localId: 'vault',
    sourceDirectory: 'connectedAccountsCollisionPeer',
    serviceTitle: 'Collision Peer Vault account',
}] as const;

function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string = '/'): string {
    const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
    url.searchParams.set('server', serverBaseUrl);
    return url.toString();
}

async function createPluginArchive(params: Readonly<{
    pluginRoot: string;
    archivePath: string;
}>): Promise<void> {
    await execFileAsync('tar', [
        '-czf',
        params.archivePath,
        '-C',
        dirname(params.pluginRoot),
        basename(params.pluginRoot),
    ]);
}

async function createPackedVoiceFixtureForOrigin(params: Readonly<{
    sourceRoot: string;
    targetRoot: string;
    origin: string;
}>): Promise<void> {
    await cp(params.sourceRoot, params.targetRoot, { recursive: true });
    const rewrittenFiles = [
        join(params.targetRoot, '.happier-plugin', 'plugin.json'),
    ];
    for (const path of rewrittenFiles) {
        const before = await readFile(path, 'utf8');
        if (!before.includes(PACKED_VOICE_CANONICAL_ORIGIN)) {
            throw new Error(`packed_voice_fixture_origin_missing:${path}`);
        }
        await writeFile(
            path,
            before.replaceAll(PACKED_VOICE_CANONICAL_ORIGIN, params.origin),
            'utf8',
        );
    }
}

async function startPackedVoiceProviderServer(params: Readonly<{
    rootPath: string;
    expectedSecret: string;
}>): Promise<StartedPackedVoiceProviderServer> {
    const caCertificatePath = join(params.rootPath, 'provider-ca.pem');
    const keyPath = join(params.rootPath, 'provider-key.pem');
    await execFileAsync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        caCertificatePath,
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
    ]);
    const [key, cert] = await Promise.all([
        readFile(keyPath),
        readFile(caCertificatePath),
    ]);
    const requests: PackedVoiceProviderRequest[] = [];
    let origin = 'https://127.0.0.1';
    const server = createHttpsServer({ key, cert }, (request, response) => {
        const chunks: Buffer[] = [];
        let bodyByteLength = 0;
        let rejected = false;
        request.on('data', (chunk: Buffer) => {
            bodyByteLength += chunk.byteLength;
            if (bodyByteLength > 1_024) {
                rejected = true;
                request.destroy();
                return;
            }
            chunks.push(Buffer.from(chunk));
        });
        request.on('end', () => {
            if (rejected) return;
            const requestUrl = new URL(request.url ?? '/', origin);
            const method = request.method ?? '';
            const pathname = requestUrl.pathname;
            const contentType = String(request.headers['content-type'] ?? '');
            const authorizationMatched = request.headers.authorization === `Bearer ${params.expectedSecret}`;
            let body: unknown = null;
            if (bodyByteLength > 0) {
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'invalid_json' }));
                    return;
                }
            }
            const clientAuthArtifact = method === 'POST' && pathname === '/v1/session'
                ? {
                kind: 'bearer_token' as const,
                value: `packed-short-lived-${randomBytes(18).toString('base64url')}`,
                expiresAtMs: Date.now() + 60_000,
                placement: 'authorization_header' as const,
                }
                : null;
            requests.push({
                method,
                pathname,
                authorizationMatched,
                contentType,
                bodyByteLength,
                body,
                clientAuthArtifact,
            });
            const isCatalogRequest = (
                method === 'GET'
                && pathname === '/v1/voices'
                && requestUrl.search === ''
                && authorizationMatched
                && contentType === ''
                && bodyByteLength === 0
            );
            const isClientAuthRequest = (
                method === 'POST'
                && pathname === '/v1/session'
                && requestUrl.search === ''
                && authorizationMatched
                && contentType === 'application/json'
                && JSON.stringify(body) === JSON.stringify({
                    audience: 'realtime',
                    voiceId: 'packed-voice-primary',
                })
                && clientAuthArtifact !== null
            );
            const isProvisioningRequest = (
                method === 'PATCH'
                && pathname === '/v1/voices/packed-voice-primary'
                && requestUrl.search === ''
                && authorizationMatched
                && contentType === 'application/json'
                && JSON.stringify(body) === JSON.stringify({ profile: 'balanced' })
            );
            if (!isCatalogRequest && !isProvisioningRequest && !isClientAuthRequest) {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'request_contract_mismatch' }));
                return;
            }
            const providerResponse = isCatalogRequest
                ? {
                    voices: [{
                        voice_id: 'packed-voice-primary',
                        name: 'Packed primary',
                        language: 'en',
                        provider_internal_id: 'must-not-project',
                    }],
                    provider_request_id: 'must-not-project',
                }
                : isProvisioningRequest
                  ? {
                    provisioned_voice_id: 'packed-voice-primary',
                    profile: 'balanced',
                    provider_request_id: 'must-not-project',
                  }
                  : {
                    client_secret: {
                        value: clientAuthArtifact?.value,
                        expires_at_ms: clientAuthArtifact?.expiresAtMs,
                        provider_internal_id: 'must-not-project',
                    },
                    provider_request_id: 'must-not-project',
                };
            const bytes = Buffer.from(JSON.stringify(providerResponse));
            response.writeHead(200, {
                'content-type': 'application/json',
                'content-length': String(bytes.byteLength),
                'cache-control': 'no-store',
            });
            response.end(bytes);
        });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('packed_voice_provider_server_address_missing');
    }
    origin = `https://127.0.0.1:${(address as AddressInfo).port}`;
    let closed = false;
    return {
        origin,
        caCertificatePath,
        requests,
        close: async () => {
            if (closed) return;
            closed = true;
            await new Promise<void>((resolveClose, rejectClose) => {
                server.close((error) => error ? rejectClose(error) : resolveClose());
                server.closeAllConnections();
            });
        },
    };
}

async function startPluginCatalogServer(params: Readonly<{
    pluginId: string;
    archivePath: string;
}>): Promise<StartedPluginCatalogServer> {
    let release = {
        version: '1.0.0',
        archivePath: params.archivePath,
    };
    const server = createHttpServer((request, response) => {
        if (request.method === 'GET' && request.url === '/catalog.json') {
            const address = server.address();
            if (!address || typeof address === 'string') {
                response.statusCode = 500;
                response.end('missing-address');
                return;
            }

            const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
            const catalogUrl = `${baseUrl}/catalog.json`;
            const archiveUrl = `${baseUrl}/plugins/${params.pluginId}.tar.gz`;
            response.statusCode = 200;
            response.setHeader('access-control-allow-origin', '*');
            response.setHeader('cache-control', 'no-store');
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: catalogUrl,
                title: 'UI E2E Plugin Catalog',
                description: 'Serves an archive-backed plugin fixture for browser + daemon install flows',
                entries: [
                    {
                        id: `marketplace.${params.pluginId}`,
                        manifestId: params.pluginId,
                        title: 'UI E2E Settings Plugin',
                        description: 'Catalog entry for the plugin details UI flow',
                        version: release.version,
                        sourceUrl: `${baseUrl}/entries/${params.pluginId}.json`,
                        packageUrl: archiveUrl,
                        categories: ['plugins'],
                    },
                ],
            }));
            return;
        }

        if (request.method === 'GET' && request.url === `/plugins/${params.pluginId}.tar.gz`) {
            void (async () => {
                try {
                    const archiveBytes = await readFile(release.archivePath);
                    response.statusCode = 200;
                    response.setHeader('access-control-allow-origin', '*');
                    response.setHeader('cache-control', 'no-store');
                    response.setHeader('content-type', 'application/gzip');
                    response.setHeader('content-length', String(archiveBytes.byteLength));
                    response.end(archiveBytes);
                } catch {
                    response.statusCode = 500;
                    response.end('archive-read-failed');
                }
            })();
            return;
        }

        response.statusCode = 404;
        response.end();
    });

    await new Promise<void>((resolveListen, rejectListen) => {
        server.listen(0, '127.0.0.1', () => resolveListen());
        server.once('error', rejectListen);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('plugin_catalog_server_address_missing');
    }

    return {
        catalogUrl: `http://127.0.0.1:${(address as AddressInfo).port}/catalog.json`,
        setRelease: (nextRelease) => {
            release = {
                version: nextRelease.version,
                archivePath: nextRelease.archivePath,
            };
        },
        close: async () => {
            await new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
            });
        },
    };
}

async function dismissSuccessAlert(page: Page): Promise<void> {
    const confirmByTestId = page.getByTestId('web-modal-confirm');
    try {
        await expect(confirmByTestId).toHaveCount(1, { timeout: 5_000 });
        await confirmByTestId.click();
        return;
    } catch {
        const okButton = page.getByRole('button', { name: 'OK' });
        await expect(okButton).toHaveCount(1, { timeout: 120_000 });
        await okButton.click();
    }
}

function readEnvelopeNestedString(envelope: JsonEnvelope, parentKey: string, key: string): string | null {
    if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return null;
    const parent = Reflect.get(envelope.data, parentKey);
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return null;
    const value = Reflect.get(parent, key);
    return typeof value === 'string' ? value : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readRecordPath(value: unknown, path: readonly string[]): Readonly<Record<string, unknown>> | null {
    let current = readRecord(value);
    for (const key of path) {
        current = readRecord(current?.[key]);
        if (!current) return null;
    }
    return current;
}

async function readPackedVoiceFixtureEvents(page: Page): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return await page.evaluate((eventsKey) => {
        const events = Reflect.get(globalThis, eventsKey);
        if (!Array.isArray(events)) return [];
        return events.flatMap((event) => (
            event && typeof event === 'object' && !Array.isArray(event)
                ? [Object.fromEntries(Object.entries(event))]
                : []
        ));
    }, PACKED_VOICE_FIXTURE_EVENTS_KEY);
}

async function readVoiceQaMediaSnapshot(page: Page): Promise<Readonly<Record<string, unknown>>> {
    const raw = await page.getByTestId('voiceQa.media.snapshot').textContent();
    return readRecord(JSON.parse(raw ?? '{}')) ?? {};
}

async function readPluginGenerationLabel(page: Page, pluginId: string): Promise<string> {
    const summary = page.getByTestId(`settings.plugins.detail.${pluginId}.summary`);
    await expect(summary).toHaveCount(1, { timeout: 120_000 });
    const text = (await summary.textContent())?.trim() ?? '';
    const match = text.match(/Generation\s*([0-9A-Za-z._-]+)/i);
    if (!match?.[1]) {
        throw new Error(`missing_generation_in_summary:${pluginId}:${text}`);
    }
    return match[1];
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

async function deleteVoiceCredentialThroughUi(params: Readonly<{
    page: Page;
    credentialTestId: string;
}>): Promise<void> {
    await params.page.getByTestId(params.credentialTestId).click();
    const input = params.page.getByTestId('web-prompt-input');
    await expect(input).toHaveCount(1, { timeout: 30_000 });
    await input.fill('');
    await params.page.getByTestId('web-prompt-confirm').click();
    await expect(input).toHaveCount(0, { timeout: 30_000 });
    const remove = params.page.getByTestId('web-modal-confirm');
    await expect(remove).toBeEnabled({ timeout: 30_000 });
    await remove.click();
    await expect(remove).toHaveCount(0, { timeout: 30_000 });
}

test.describe('ui e2e: plugin settings reload', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-plugins-details-suite');
    const uiWebMode = String(process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'metro').trim().toLowerCase() === 'metro'
        ? 'metro'
        : 'export';

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;
    let packedVoiceProviderServer: StartedPackedVoiceProviderServer | null = null;
    let packedNovelConnectedAccountProviderServer:
        StartedPackedNovelConnectedAccountProvider | null = null;
    let conversationSessionSocket: SocketCollector | null = null;
    let uiBaseUrl: string | null = null;
    let uiSourceFingerprint: string | null = null;
    let packedCandidate: PreparedPackedCandidateBrowserQa | null = null;
    let packedNovelConnectedAccount:
        PreparedPackedNovelConnectedAccountBrowserQa | null = null;

    test.beforeAll(async () => {
        const candidateManifestPath =
            process.env.HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST?.trim() || null;
        const packedNovelHandoffManifestPath =
            process.env.HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST?.trim() || null;
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-plugins-details-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: uiWebMode,
        };
        test.setTimeout(resolvePackedCandidateBrowserQaBeforeAllTimeoutMs({
            candidateManifestPath,
            uiBeforeAllTimeoutMs: resolveUiWebBeforeAllTimeoutMs(uiWebEnv),
        }));
        if (candidateManifestPath) {
            packedCandidate = await preparePackedCandidateBrowserQa({
                candidateManifestPath,
                materializationRoot: resolvePackedCandidateBrowserQaMaterializationRoot({
                    env: process.env,
                    defaultRoot: join(suiteDir, 'packed-candidate-cli'),
                }),
            });
            if (!packedNovelHandoffManifestPath) {
                throw new Error(
                    'packed_candidate_browser_qa_novel_handoff_required',
                );
            }
            packedNovelConnectedAccount =
                await preparePackedNovelConnectedAccountBrowserQa({
                    candidate: packedCandidate.candidate,
                    handoffManifestPath: packedNovelHandoffManifestPath,
                });
        } else if (packedNovelHandoffManifestPath) {
            throw new Error(
                'packed_novel_browser_qa_requires_exact_candidate',
            );
        }

        try {
            server = await startServerLight({
                testDir: suiteDir,
                dbProvider: 'sqlite',
                extraEnv: {
                    NODE_ENV: process.env.NODE_ENV ?? 'test',
                    HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                    HAPPIER_FEATURE_VOICE__ENABLED: '1',
                    HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0',
                    HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
                    HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
                    HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
                    ...(packedNovelConnectedAccount ? {
                        DATABASE_URL:
                            renderPrismaCompatibleSqliteDatabaseUrl({
                                dbPath:
                                    packedNovelConnectedAccount
                                        .isolation.databasePath,
                                platform: process.platform,
                                sqlite: { connectionLimit: 4 },
                            }),
                    } : {}),
                },
            });

            const uiSourceFingerprintBeforeStart = resolveUiWebSourceFingerprint();
            ui = await startUiWeb({
                testDir: suiteDir,
                env: {
                    ...uiWebEnv,
                    EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                },
            });
            uiSourceFingerprint = resolveUiWebSourceFingerprint();
            if (uiSourceFingerprint !== uiSourceFingerprintBeforeStart) {
                throw new Error('ui_source_changed_during_browser_runtime_bootstrap');
            }

            uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
        } catch (error) {
            await packedNovelConnectedAccount?.authorization.close()
                .catch(() => undefined);
            packedNovelConnectedAccount = null;
            throw error;
        }
    });

    test.afterEach(async () => {
        conversationSessionSocket?.close();
        conversationSessionSocket = null;
        await daemon?.stop().catch(() => {});
        daemon = null;
        await packedVoiceProviderServer?.close().catch(() => {});
        packedVoiceProviderServer = null;
        await packedNovelConnectedAccountProviderServer?.close()
            .catch(() => {});
        packedNovelConnectedAccountProviderServer = null;
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        conversationSessionSocket?.close();
        await packedVoiceProviderServer?.close().catch(() => {});
        await packedNovelConnectedAccountProviderServer?.close()
            .catch(() => {});
        packedNovelConnectedAccountProviderServer = null;
        await packedNovelConnectedAccount?.authorization.close()
            .catch(() => {});
        packedNovelConnectedAccount = null;
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
        await packedCandidate?.cleanup();
        packedCandidate = null;
    });

    test('installs an archive-backed plugin through the real daemon capability, suppresses mismatched-source updates, and reloads it from the detail route', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) {
            throw new Error('missing server/ui fixtures');
        }

        const testDir = resolve(join(suiteDir, 't1-plugin-details-install'));
        const cliHomeDir = resolve(join(testDir, 'cli-home'));
        const pluginRoot = resolve(join(testDir, 'plugin-root'));
        const updatedPluginRoot = resolve(join(testDir, 'plugin-root-v1.1.0'));
        const pluginId = 'ui-e2e-settings-plugin';
        const pluginArchivePath = resolve(join(testDir, `${pluginId}.tar.gz`));
        const updatedPluginArchivePath = resolve(join(testDir, `${pluginId}-v1.1.0.tar.gz`));
        const unrelatedCatalogUrl = `${uiBaseUrl}/plugin-update-mismatch.json`;

        await mkdir(testDir, { recursive: true });
        await mkdir(cliHomeDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });
        await writeRuntimeProjectionPluginFixture({
            pluginRoot,
            pluginId,
        });
        await createPluginArchive({
            pluginRoot,
            archivePath: pluginArchivePath,
        });
        await writeRuntimeProjectionPluginFixture({
            pluginRoot: updatedPluginRoot,
            pluginId,
        });
        const updatedManifestPath = join(updatedPluginRoot, '.happier-plugin', 'plugin.json');
        const updatedManifest = JSON.parse(await readFile(updatedManifestPath, 'utf8')) as Record<string, unknown>;
        updatedManifest.version = '1.1.0';
        await writeFile(updatedManifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, 'utf8');
        await createPluginArchive({
            pluginRoot: updatedPluginRoot,
            archivePath: updatedPluginArchivePath,
        });

        const catalogServer = await startPluginCatalogServer({
            pluginId,
            archivePath: pluginArchivePath,
        });

        try {
            const auth = await createTestAuth(server.baseUrl);
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
                storageScope: `e2e-settings-plugins-details-${run.runId}`,
            }));

            const daemonServerUrl = server.baseUrl;
            const daemonWebappUrl = uiBaseUrl;
            const startSettingsPluginDaemon = () => startTestDaemon({
                testDir,
                happyHomeDir: cliHomeDir,
                snapshotDir: join(testDir, 'cli-dist'),
                ...(packedCandidate ? { cliLaunchSpec: packedCandidate.cliLaunchSpec } : {}),
                env: {
                    ...process.env,
                    CI: '1',
                    HAPPIER_HOME_DIR: cliHomeDir,
                    HAPPIER_SERVER_URL: daemonServerUrl,
                    HAPPIER_WEBAPP_URL: daemonWebappUrl,
                    HAPPIER_DISABLE_CAFFEINATE: '1',
                    HAPPIER_VARIANT: 'dev',
                    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                    HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
                },
            });
            daemon = await startSettingsPluginDaemon();

            await gotoDomContentLoadedWithRetries(
                page,
                buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
                180_000,
            );
            await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
            await gotoDomContentLoadedWithRetries(
                page,
                buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins?happier_hmr=0'),
                180_000,
            );
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: '/settings/plugins',
                requiredTestIds: [
                    'settings.plugins.marketplace.catalogUrl',
                    'settings.plugins.marketplace.loadCatalog',
                ],
                timeoutMs: 120_000,
            });

            await page.route(unrelatedCatalogUrl, async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: {
                        'access-control-allow-origin': '*',
                        'cache-control': 'no-store',
                    },
                    body: JSON.stringify({
                        t: 'happier_plugin_marketplace_catalog_v1',
                        schemaVersion: 1,
                        sourceUrl: unrelatedCatalogUrl,
                        title: 'Mismatched update source',
                        description: 'Same plugin id from a different catalog origin',
                        entries: [
                            {
                                id: pluginId,
                                manifestId: pluginId,
                                title: 'UI E2E Settings Plugin',
                                description: 'Mismatched-source catalog entry',
                                version: '9.9.9',
                                sourceUrl: `${unrelatedCatalogUrl}#${pluginId}`,
                                packageUrl: `${unrelatedCatalogUrl.replace(/\\.json$/, '')}/${pluginId}.tar.gz`,
                                categories: ['plugins'],
                            },
                        ],
                    }),
                });
            });

            await page.getByTestId('settings.plugins.marketplace.catalogUrl').fill(catalogServer.catalogUrl);
            await expect(page.getByTestId('settings.plugins.marketplace.loadCatalog')).toBeEnabled({ timeout: 60_000 });
            await page.getByTestId('settings.plugins.marketplace.loadCatalog').click();

            await expect(page.getByTestId(`settings.plugins.marketplace.entry.${pluginId}`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.marketplace.action.install.${pluginId}`)).toBeEnabled({ timeout: 120_000 });
            await page.getByTestId(`settings.plugins.marketplace.action.install.${pluginId}`).click();

            await dismissSuccessAlert(page);

            await expect(page.getByTestId(`settings.plugins.marketplace.installed.${pluginId}`)).toHaveCount(1, { timeout: 120_000 });
            await page.getByTestId('settings.plugins.marketplace.catalogUrl').fill(unrelatedCatalogUrl);
            await expect(page.getByTestId('settings.plugins.marketplace.loadCatalog')).toBeEnabled({ timeout: 60_000 });
            await page.getByTestId('settings.plugins.marketplace.loadCatalog').click();
            await expect(page.getByTestId(`settings.plugins.marketplace.entry.${pluginId}`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.marketplace.action.update.${pluginId}`)).toHaveCount(0, { timeout: 60_000 });

            catalogServer.setRelease({
                version: '1.1.0',
                archivePath: updatedPluginArchivePath,
            });
            await page.getByTestId('settings.plugins.marketplace.catalogUrl').fill(catalogServer.catalogUrl);
            await page.getByTestId('settings.plugins.marketplace.loadCatalog').click();
            const updateAction = page.getByTestId(
                `settings.plugins.marketplace.action.update.${pluginId}`,
            );
            await expect(updateAction).toBeEnabled({ timeout: 120_000 });
            await updateAction.click();
            await dismissSuccessAlert(page);

            const installedRow = page.getByTestId(`settings.plugins.marketplace.installed.${pluginId}`);
            await installedRow.click({ position: { x: 40, y: 20 } });
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: `/settings/plugins/${pluginId}`,
                requiredTestIds: [
                    `settings.plugins.detail.${pluginId}.header`,
                    `settings.plugins.detail.${pluginId}.summary`,
                    `settings.plugins.detail.${pluginId}.action.reload`,
                ],
                timeoutMs: 120_000,
            });

            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.header`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.summary`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.diagnostic.plugin_trust_approval_required.0`)).toHaveCount(1, { timeout: 120_000 });
            const initialGeneration = await readPluginGenerationLabel(page, pluginId);

            await page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`).click();
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.header`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.summary`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.diagnostic.plugin_trust_approval_required.0`)).toHaveCount(1, { timeout: 120_000 });
            await dismissSuccessAlert(page);
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: `/settings/plugins/${pluginId}`,
                requiredTestIds: [
                    `settings.plugins.detail.${pluginId}.header`,
                    `settings.plugins.detail.${pluginId}.summary`,
                    `settings.plugins.detail.${pluginId}.action.reload`,
                ],
                timeoutMs: 120_000,
            });
            const reloadedGeneration = await readPluginGenerationLabel(page, pluginId);
            expect(initialGeneration.length).toBeGreaterThan(0);
            expect(reloadedGeneration.length).toBeGreaterThan(0);
            expect(reloadedGeneration).not.toEqual(initialGeneration);

            await daemon.stop();
            daemon = null;
            const readOnlySnapshot = page.getByTestId('settings.plugins.detail.readOnlySnapshot');
            const reloadAction = page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`);
            await expect(readOnlySnapshot).toHaveCount(1, { timeout: 120_000 });
            await expect(readOnlySnapshot).toHaveAttribute('aria-live', 'polite');
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.header`)).toHaveCount(1);
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.summary`)).toHaveCount(1);
            await expect(reloadAction).toBeDisabled();
            await page.screenshot({
                path: join(testDir, 'plugin-details-offline-read-only.png'),
                fullPage: true,
            });

            daemon = await startSettingsPluginDaemon();
            await expect(readOnlySnapshot).toHaveCount(0, { timeout: 120_000 });
            await expect(reloadAction).toBeEnabled({ timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.header`)).toHaveCount(1);
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.summary`)).toHaveCount(1);
            await expect(page.getByTestId('web-modal-confirm')).toHaveCount(0);
            await page.screenshot({
                path: join(testDir, 'plugin-details-reconnected.png'),
                fullPage: true,
            });

            await page.goBack();
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: '/settings/plugins',
                requiredTestIds: [
                    `settings.plugins.marketplace.installed.${pluginId}`,
                    'settings.plugins.marketplace.catalogUrl',
                ],
                timeoutMs: 120_000,
            });
        } finally {
            await catalogServer.close().catch(() => {});
        }
    });

    test('runs packed Voice catalog and client auth through the authenticated AppShell and revokes them on disable and uninstall', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
        const serverBaseUrl = server.baseUrl;

        const testDir = resolve(join(suiteDir, 't2-packed-voice-appshell'));
        const cliHomeDir = resolve(join(testDir, 'cli-home'));
        const archivePath = resolve(join(testDir, 'packed-external-voice-provider.tgz'));
        const sourceFixtureRoot = resolve(repoRootDir(), 'apps/cli/src/plugins/testkit/fixtures/packed-external-voice-provider');
        const fixtureRoot = resolve(join(testDir, 'packed-external-voice-provider'));
        const initialSourceSecret = `packed-source-initial-${randomBytes(18).toString('base64url')}`;
        const activeSourceSecret = `packed-source-active-${randomBytes(18).toString('base64url')}`;
        await mkdir(cliHomeDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });
        const voiceProviderServer = await startPackedVoiceProviderServer({
            rootPath: testDir,
            expectedSecret: activeSourceSecret,
        });
        packedVoiceProviderServer = voiceProviderServer;
        await createPackedVoiceFixtureForOrigin({
            sourceRoot: sourceFixtureRoot,
            targetRoot: fixtureRoot,
            origin: voiceProviderServer.origin,
        });

        const auth = await createTestAuth(server.baseUrl);
        const machineKey = auth.accountMachineKey;
        const accountPublicKey = deriveBoxPublicKeyFromSeed(machineKey);
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
            storageScope: `e2e-settings-plugins-details-${run.runId}`,
        }));

        const cliEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NODE_ENV: process.env.NODE_ENV ?? 'test',
            CI: '1',
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
            HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
            NODE_EXTRA_CA_CERTS: voiceProviderServer.caCertificatePath,
        };
        const cliLaunchOptions = {
            preferSourceEntrypoint: true,
            skipSourceFreshnessCheck: true,
            skipSharedDepsBuild: true,
        } as const;
        const packEnvelope = await runCliJson({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: cliEnv,
            label: 'packed-voice-pack',
            args: ['plugins', 'pack', fixtureRoot, '--out', archivePath, '--json'],
            timeoutMs: 240_000,
            ...(packedCandidate ? { cliLaunchSpec: packedCandidate.cliLaunchSpec } : {}),
            launchOptions: cliLaunchOptions,
        });
        expect(packEnvelope).toMatchObject({ ok: true, kind: 'plugins_pack' });
        const archiveDigest = `sha256:${createHash('sha256').update(await readFile(archivePath)).digest('hex')}`;
        expect(readEnvelopeNestedString(packEnvelope, 'package', 'archiveDigest')).toBe(archiveDigest);

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: cliHomeDir,
            snapshotDir: join(testDir, 'cli-dist'),
            ...(packedCandidate ? { cliLaunchSpec: packedCandidate.cliLaunchSpec } : {}),
            env: {
                ...cliEnv,
                HAPPIER_HOME_DIR: cliHomeDir,
                HAPPIER_SERVER_URL: server.baseUrl,
                HAPPIER_WEBAPP_URL: uiBaseUrl,
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });
        const installEnvelope = await runCliJson({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: cliEnv,
            label: 'packed-voice-install',
            args: ['plugins', 'install', archivePath, '--json'],
            timeoutMs: 240_000,
            ...(packedCandidate ? { cliLaunchSpec: packedCandidate.cliLaunchSpec } : {}),
            launchOptions: cliLaunchOptions,
        });
        const installReview = readPluginInstallReviewRequiredEnvelope(installEnvelope);
        expect(installReview.review.pluginId).toBe(PACKED_VOICE_PLUGIN_ID);
        const installOutcome = await decideAuthenticatedPluginInstallReview({
            cliHomeDir,
            serverUrl: server.baseUrl,
            pendingChangeId: installReview.pendingChangeId,
            optionalSelections: installReview.review.optionalHostAccess.map((entry) => ({
                accessId: entry.id,
                selected: false,
            })),
            confirmPresentUser: async () => true,
        });
        expect(installOutcome).toMatchObject({
            kind: 'committed',
            pluginId: PACKED_VOICE_PLUGIN_ID,
        });
        const showEnvelope = await runCliJson({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: cliEnv,
            label: 'packed-voice-show',
            args: ['plugins', 'show', PACKED_VOICE_PLUGIN_ID, '--json'],
            timeoutMs: 240_000,
            ...(packedCandidate ? { cliLaunchSpec: packedCandidate.cliLaunchSpec } : {}),
            launchOptions: cliLaunchOptions,
        });
        expect(showEnvelope).toMatchObject({ ok: true, kind: 'plugins_show' });
        expect(readEnvelopeNestedString(showEnvelope, 'plugin', 'pluginId')).toBe(PACKED_VOICE_PLUGIN_ID);
        const installedPluginPath = readRecordPath(showEnvelope.data, ['plugin', 'install'])?.installedPath;
        expect(typeof installedPluginPath).toBe('string');
        if (typeof installedPluginPath !== 'string') throw new Error('packed_voice_installed_path_missing');
        await expect(access(join(
            installedPluginPath,
            'dist',
            'happier-plugin-ui',
            'react-native',
            'voice-runtime-web',
            'index.js',
        ))).resolves.toBeUndefined();

        let packedVoiceProjectionJson = '';
        const projectionSocket = createUserScopedSocketCollector(server.baseUrl, auth.token, {
            captureEvents: false,
        });
        projectionSocket.connect();
        try {
            const projectionResponse = unwrapDataKeyRpcResult(await createDataKeyRpcClient(
                projectionSocket,
                machineKey,
            ).call(
                `${seeded.machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
                {
                    machineId: seeded.machineId,
                    reactNativeWebLoaderCapability: {
                        integrated: true,
                        installedArtifactLoaderAvailable: true,
                    },
                },
                60_000,
            ), 'packed Voice contribution projection');
            packedVoiceProjectionJson = JSON.stringify(projectionResponse);
            await writeFile(
                join(testDir, 'daemon.packed-voice-projection.json'),
                `${JSON.stringify(projectionResponse, null, 2)}\n`,
                'utf8',
            );
            const voiceEntry = readRecordPath(projectionResponse, [
                'projection', 'familiesById', 'voiceProviders', 'entriesById', PACKED_VOICE_PROVIDER_ID,
            ]);
            expect(voiceEntry).not.toBeNull();
            const bundleEntry = readRecordPath(projectionResponse, [
                'projection',
                'familiesById',
                'pluginUi',
                'entriesById',
                `reactNativeBundle:${PACKED_VOICE_PLUGIN_ID}:${PACKED_VOICE_PROVIDER_LOCAL_ID}`,
            ]);
            expect(bundleEntry).not.toBeNull();
            expect(readRecordPath(bundleEntry, ['runtime', 'decision'])?.state).toBe('load');
        } finally {
            projectionSocket.close();
        }

        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'), 180_000);
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/conversations?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/voice/conversations',
            requiredTestIds: ['settings.voice.provider.off'],
            timeoutMs: 180_000,
        });
        const providerRow = page.getByTestId(PACKED_VOICE_PROVIDER_ROW_TEST_ID);
        await expect(providerRow).toHaveCount(1, { timeout: 180_000 });
        await expect(providerRow).toHaveRole('radio');
        await expect(providerRow).toHaveAccessibleName(new RegExp(PACKED_VOICE_PROVIDER_TITLE, 'u'));
        await expect(providerRow).toBeEnabled();
        await providerRow.click();
        await expect(providerRow).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
        const provisioningSetting = page.getByTestId(PACKED_VOICE_PROVISIONING_SETTING_TEST_ID);
        const provisioningSwitch = provisioningSetting.getByRole('switch');
        await expect(provisioningSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
        await provisioningSetting.click();
        await expect(provisioningSwitch).toHaveAttribute('aria-checked', 'false', { timeout: 120_000 });
        await provisioningSetting.click();
        await expect(provisioningSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
        const credentialItem = page.getByTestId(PACKED_VOICE_CREDENTIAL_TEST_ID);
        await expect(credentialItem).toHaveCount(1, { timeout: 120_000 });
        const missingCredentialItemText = await credentialItem.textContent();
        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/advanced?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/voice/advanced',
            requiredTestIds: [
                'settings.voice.ui.activityFeedEnabled',
                'settings.voice.ui.surfaceLocation',
            ],
            timeoutMs: 180_000,
        });
        const activityFeedSwitch = page.getByTestId('settings.voice.ui.activityFeedEnabled');
        await expect(activityFeedSwitch).toHaveAttribute('aria-checked', 'false', { timeout: 120_000 });
        await activityFeedSwitch.click();
        await expect(activityFeedSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
        const surfaceLocationMenu = page.getByTestId('settings.voice.ui.surfaceLocation');
        await expect(surfaceLocationMenu).toHaveCount(1, { timeout: 120_000 });
        await surfaceLocationMenu.click();
        const sidebarSurfaceLocation = page.getByTestId('settings.voice.ui.surfaceLocation.sidebar');
        await expect(sidebarSurfaceLocation).toHaveCount(1, { timeout: 120_000 });
        await sidebarSurfaceLocation.click();

        const targetSessionDataKey = Uint8Array.from(randomBytes(32));
        const targetSessionDataKeyEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: targetSessionDataKey,
            recipientPublicKey: accountPublicKey,
            randomBytes: (length) => Uint8Array.from(randomBytes(length)),
        });
        const targetSession = await createSessionWithCiphertexts({
            baseUrl: server.baseUrl,
            token: auth.token,
            metadataCiphertextBase64: encryptDataKeyBase64({
                machineId: seeded.machineId,
                path: testDir,
            }, targetSessionDataKey),
            dataEncryptionKeyBase64: Buffer.from(targetSessionDataKeyEnvelope).toString('base64'),
        });
        const conversationSessionDataKey = Uint8Array.from(randomBytes(32));
        const conversationSessionDataKeyEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: conversationSessionDataKey,
            recipientPublicKey: accountPublicKey,
            randomBytes: (length) => Uint8Array.from(randomBytes(length)),
        });
        const conversationSession = await createSessionWithCiphertexts({
            baseUrl: server.baseUrl,
            token: auth.token,
            metadataCiphertextBase64: encryptDataKeyBase64({
                machineId: seeded.machineId,
                path: testDir,
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                voiceConversationScopeV1: {
                    v: 1,
                    kind: 'session_root',
                    sessionRootId: targetSession.sessionId,
                },
            }, conversationSessionDataKey),
            dataEncryptionKeyBase64: Buffer.from(conversationSessionDataKeyEnvelope).toString('base64'),
        });
        const accessKeyResponse = await fetchJson<{ success?: boolean; error?: string }>(
            `${server.baseUrl}/v1/access-keys/${encodeURIComponent(conversationSession.sessionId)}/${encodeURIComponent(seeded.machineId)}`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${auth.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data: `packed-voice-session:${conversationSession.sessionId}` }),
                timeoutMs: 15_000,
            },
        );
        expect([200, 409]).toContain(accessKeyResponse.status);
        conversationSessionSocket = createSessionScopedSocketCollector(
            server.baseUrl,
            auth.token,
            conversationSession.sessionId,
            seeded.machineId,
            { autoReconnect: false, captureEvents: false },
        );
        conversationSessionSocket.connect();
        await expect.poll(() => conversationSessionSocket?.isConnected() ?? false, { timeout: 30_000 }).toBe(true);
        conversationSessionSocket.emit('session-alive', {
            sid: conversationSession.sessionId,
            time: Date.now(),
            thinking: false,
        });
        await expect.poll(async () => (
            await fetchSessionV2(serverBaseUrl, auth.token, conversationSession.sessionId)
        ).active, { timeout: 30_000 }).toBe(true);
        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/dev/voice-qa?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/dev/voice-qa',
            requiredTestIds: ['voiceQa.sessionIdInput', 'voiceQa.promptInput', 'voiceQa.start', 'voiceQa.stop', 'voiceQa.send', 'voiceQa.media.snapshot'],
            timeoutMs: 180_000,
        });
        await expect.poll(async () => {
            try {
                const raw = await page.getByTestId('voiceQa.media.snapshot').textContent();
                return (JSON.parse(raw ?? '{}') as { configuredProviderId?: unknown }).configuredProviderId;
            } catch {
                return null;
            }
        }, { timeout: 180_000 }).toBe(PACKED_VOICE_PROVIDER_ID);
        await expect.poll(async () => page.evaluate((eventsKey) => (
            Object.hasOwn(globalThis, eventsKey)
        ), PACKED_VOICE_FIXTURE_EVENTS_KEY), { timeout: 120_000 }).toBe(true);

        expect(voiceProviderServer.requests).toHaveLength(0);
        expect(
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'connection_created'),
        ).toHaveLength(0);

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/conversations?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/voice/conversations',
            requiredTestIds: [
                PACKED_VOICE_PROVIDER_ROW_TEST_ID,
                PACKED_VOICE_CREDENTIAL_TEST_ID,
            ],
            timeoutMs: 180_000,
        });
        await enterVoiceCredentialThroughUi({
            page,
            credentialTestId: PACKED_VOICE_CREDENTIAL_TEST_ID,
            value: initialSourceSecret,
        });
        await expect.poll(async () => page.getByTestId(PACKED_VOICE_CREDENTIAL_TEST_ID).textContent(), {
            timeout: 120_000,
        }).not.toBe(missingCredentialItemText);
        await enterVoiceCredentialThroughUi({
            page,
            credentialTestId: PACKED_VOICE_CREDENTIAL_TEST_ID,
            value: activeSourceSecret,
        });

        const settingsActionRequestsBefore = voiceProviderServer.requests.length;
        const settingsAction = page.getByTestId('voice-settings-action-provision-voice');
        await expect(settingsAction).toBeEnabled({ timeout: 120_000 });
        await settingsAction.click();
        const settingsActionConfirm = page.getByTestId('web-modal-confirm');
        await expect(settingsActionConfirm).toBeEnabled({ timeout: 30_000 });
        await settingsActionConfirm.click();
        await expect.poll(() => voiceProviderServer.requests.length, { timeout: 120_000 })
            .toBe(settingsActionRequestsBefore + 1);
        expect(voiceProviderServer.requests.slice(settingsActionRequestsBefore)).toEqual([
            expect.objectContaining({
                method: 'PATCH',
                pathname: '/v1/voices/packed-voice-primary',
                authorizationMatched: true,
                body: { profile: 'balanced' },
            }),
        ]);
        await expect.poll(async () => (
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'provisioned')
        ), { timeout: 120_000 }).toEqual([
            expect.objectContaining({
                selectedVoiceId: 'packed-voice-primary',
                profile: 'balanced',
            }),
        ]);
        await expect(page.getByTestId('voice-realtime-field-profile'))
            .toContainText('expressive', { timeout: 120_000 });

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(
                uiBaseUrl,
                server.baseUrl,
                `/session/${encodeURIComponent(targetSession.sessionId)}?happier_hmr=0`,
            ),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: `/session/${targetSession.sessionId}`,
            requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
            timeoutMs: 180_000,
        });
        const normalUiRequestsBeforeStart = voiceProviderServer.requests.length;
        const normalUiVoiceToggle = page.getByTestId('voice-surface-toggle:sidebar');
        await expect(normalUiVoiceToggle).toBeEnabled({ timeout: 120_000 });
        await normalUiVoiceToggle.click();
        await expect.poll(() => voiceProviderServer.requests.length, { timeout: 120_000 })
            .toBe(normalUiRequestsBeforeStart + 1);
        expect(
            voiceProviderServer.requests
                .slice(normalUiRequestsBeforeStart)
                .map((request) => `${request.method} ${request.pathname}`),
        ).toEqual([
            'POST /v1/session',
        ]);
        await expect(page.getByTestId('voice-surface-status:sidebar:connected')).toHaveCount(1, {
            timeout: 120_000,
        });
        await expect(page.getByText('packed provider transcript', { exact: true })).toHaveCount(1, {
            timeout: 120_000,
        });
        const normalUiTranscriptObserved = await page
            .getByText('packed provider transcript', { exact: true })
            .count() === 1;
        const normalUiEventsBeforeCancel = await readPackedVoiceFixtureEvents(page);
        const normalUiClosedBeforeCancel = normalUiEventsBeforeCancel.filter((event) => event.kind === 'closed').length;
        const normalUiCancelBefore = normalUiEventsBeforeCancel.filter((event) => event.kind === 'fixture_cancel').length;
        const normalUiCancelControl = page.getByTestId('voice-surface-cancel:sidebar');
        await expect(normalUiCancelControl).toHaveCount(1, { timeout: 120_000 });
        await normalUiCancelControl.click();
        await expect.poll(async () => (
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'fixture_cancel').length
        ), { timeout: 120_000 }).toBe(normalUiCancelBefore + 1);
        expect(
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'closed'),
        ).toHaveLength(normalUiClosedBeforeCancel);
        await normalUiVoiceToggle.click();
        await expect.poll(async () => (
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'closed').length
        ), { timeout: 120_000 }).toBe(normalUiClosedBeforeCancel + 1);
        const normalUiFixtureEventsJson = JSON.stringify(await readPackedVoiceFixtureEvents(page));

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/dev/voice-qa?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/dev/voice-qa',
            requiredTestIds: ['voiceQa.sessionIdInput', 'voiceQa.promptInput', 'voiceQa.start', 'voiceQa.stop', 'voiceQa.send', 'voiceQa.media.snapshot'],
            timeoutMs: 180_000,
        });
        await page.getByTestId('voiceQa.sessionIdInput').fill(targetSession.sessionId);
        await page.getByTestId('voiceQa.promptInput').fill('exercise the credentialed packed provider controller');
        const qaRequestsBeforeStart = voiceProviderServer.requests.length;
        await page.getByTestId('voiceQa.start').click();
        await expect.poll(() => voiceProviderServer.requests.length, { timeout: 120_000 })
            .toBe(qaRequestsBeforeStart + 1);
        expect(
            voiceProviderServer.requests
                .slice(qaRequestsBeforeStart)
                .map((request) => `${request.method} ${request.pathname}`),
        ).toEqual([
            'POST /v1/session',
        ]);
        await expect.poll(async () => JSON.stringify(await readPackedVoiceFixtureEvents(page)), { timeout: 120_000 }).toContain('connected');
        await expect.poll(async () => {
            return (await readVoiceQaMediaSnapshot(page)).runtimeSessionId ?? null;
        }, { timeout: 120_000 }).toBe(conversationSession.sessionId);
        const qaProviderRequests = voiceProviderServer.requests.slice(qaRequestsBeforeStart);
        const providerRequest = qaProviderRequests.find((request) => request.pathname === '/v1/session');
        expect(providerRequest).toMatchObject({
            method: 'POST',
            pathname: '/v1/session',
            authorizationMatched: true,
            contentType: 'application/json',
            body: {
                audience: 'realtime',
                voiceId: 'packed-voice-primary',
            },
        });
        expect(providerRequest?.bodyByteLength).toBeGreaterThan(0);
        expect(providerRequest?.bodyByteLength).toBeLessThanOrEqual(1_024);
        const clientAuthEvent = (await readPackedVoiceFixtureEvents(page))
            .find((event) => event.kind === 'client_auth');
        const clientAuthArtifact = readRecord(clientAuthEvent?.artifact);
        const issuedClientAuthArtifact = readRecord(providerRequest?.clientAuthArtifact);
        expect(clientAuthArtifact).toEqual({
            kind: 'bearer_token',
            expiresAtMs: issuedClientAuthArtifact?.expiresAtMs,
            placement: 'authorization_header',
        });
        expect(issuedClientAuthArtifact?.value).not.toBe(initialSourceSecret);
        expect(issuedClientAuthArtifact?.value).not.toBe(activeSourceSecret);
        expect(typeof issuedClientAuthArtifact?.value).toBe('string');
        expect(String(issuedClientAuthArtifact?.value ?? '').length).toBeLessThanOrEqual(256);
        expect(Number(clientAuthArtifact?.expiresAtMs)).toBeGreaterThan(Date.now());
        expect(Number(clientAuthArtifact?.expiresAtMs) - Date.now()).toBeLessThanOrEqual(120_000);
        expect(JSON.stringify(await readPackedVoiceFixtureEvents(page)))
            .not.toContain(String(issuedClientAuthArtifact?.value));
        await expect(page.getByText('packed provider transcript', { exact: true })).toHaveCount(1, { timeout: 120_000 });
        await expect.poll(async () => JSON.stringify(await readPackedVoiceFixtureEvents(page)), { timeout: 120_000 }).toContain('fixture_tool_results');
        await expect.poll(async () => JSON.stringify(await readPackedVoiceFixtureEvents(page)), { timeout: 120_000 }).toContain('fixture_continue');
        await page.getByTestId('voiceQa.send').click();
        await expect.poll(async () => JSON.stringify(await readPackedVoiceFixtureEvents(page)), { timeout: 120_000 }).toContain('fixture_text');

        await expect(page.getByTestId('voice-surface:sidebar')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-status:sidebar:connected')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-mode:sidebar:speaking')).toHaveCount(1, { timeout: 120_000 });
        const cancelControl = page.getByTestId('voice-surface-cancel:sidebar');
        await expect(cancelControl).toHaveCount(1, { timeout: 120_000 });
        await cancelControl.click();
        await expect.poll(async () => JSON.stringify(await readPackedVoiceFixtureEvents(page)), { timeout: 120_000 }).toContain('fixture_cancel');
        expect(
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'closed'),
        ).toEqual([]);
        await page.getByTestId('voiceQa.stop').click();
        await expect.poll(async () => (
            (await readPackedVoiceFixtureEvents(page)).filter((event) => event.kind === 'closed')
        ), { timeout: 120_000 }).toEqual([{
            kind: 'closed',
            reason: { code: 'user_stop' },
        }]);
        const firstRunFixtureEventsJson = JSON.stringify(await readPackedVoiceFixtureEvents(page));
        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins',
            requiredTestIds: [`settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}`],
            timeoutMs: 180_000,
        });
        const installedPackedVoiceRow = page.getByTestId(`settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}`);
        await installedPackedVoiceRow.click({ position: { x: 40, y: 20 } });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: `/settings/plugins/${PACKED_VOICE_PLUGIN_ID}`,
            requiredTestIds: [
                `settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.header`,
                `settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.summary`,
                `settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.action.reload`,
            ],
            timeoutMs: 120_000,
        });
        const generationBeforeReload = await readPluginGenerationLabel(page, PACKED_VOICE_PLUGIN_ID);
        const reloadDocumentMarker = `packed-voice-reload-${randomBytes(16).toString('hex')}`;
        await page.evaluate((marker) => {
            Reflect.set(globalThis, '__HAPPIER_PACKED_VOICE_APPSHELL_DOCUMENT_MARKER__', marker);
        }, reloadDocumentMarker);
        await page.getByTestId(`settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.action.reload`).click();
        await dismissSuccessAlert(page);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: `/settings/plugins/${PACKED_VOICE_PLUGIN_ID}`,
            requiredTestIds: [
                `settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.summary`,
                `settings.plugins.detail.${PACKED_VOICE_PLUGIN_ID}.action.reload`,
            ],
            timeoutMs: 120_000,
        });
        const generationAfterReload = await readPluginGenerationLabel(page, PACKED_VOICE_PLUGIN_ID);
        expect(generationAfterReload).not.toBe(generationBeforeReload);
        expect(await page.evaluate(() => (
            Reflect.get(globalThis, '__HAPPIER_PACKED_VOICE_APPSHELL_DOCUMENT_MARKER__')
        ))).toBe(reloadDocumentMarker);

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/dev/voice-qa?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/dev/voice-qa',
            requiredTestIds: ['voiceQa.sessionIdInput', 'voiceQa.promptInput', 'voiceQa.start', 'voiceQa.stop', 'voiceQa.media.snapshot'],
            timeoutMs: 180_000,
        });
        await expect.poll(async () => (
            (await readVoiceQaMediaSnapshot(page)).configuredProviderId ?? null
        ), { timeout: 180_000 }).toBe(PACKED_VOICE_PROVIDER_ID);
        await page.getByTestId('voiceQa.sessionIdInput').fill(targetSession.sessionId);
        await page.getByTestId('voiceQa.promptInput').fill('exercise the reloaded packed provider controller');
        const reloadRequestsBeforeStart = voiceProviderServer.requests.length;
        await page.getByTestId('voiceQa.start').click();
        await expect.poll(() => voiceProviderServer.requests.length, { timeout: 120_000 })
            .toBe(reloadRequestsBeforeStart + 1);
        expect(
            voiceProviderServer.requests
                .slice(reloadRequestsBeforeStart)
                .map((request) => `${request.method} ${request.pathname}`),
        ).toEqual([
            'POST /v1/session',
        ]);
        await expect.poll(async () => JSON.stringify(await readPackedVoiceFixtureEvents(page)), { timeout: 120_000 }).toContain('connected');
        await page.getByTestId('voiceQa.stop').click();
        await expect.poll(async () => (
            (await readPackedVoiceFixtureEvents(page)).some((event) => event.kind === 'closed')
        ), { timeout: 120_000 }).toBe(true);
        const postReloadFixtureEventsJson = JSON.stringify(await readPackedVoiceFixtureEvents(page));

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/conversations?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/voice/conversations',
            requiredTestIds: [
                PACKED_VOICE_PROVIDER_ROW_TEST_ID,
                PACKED_VOICE_CREDENTIAL_TEST_ID,
                PACKED_VOICE_PROVISIONING_SETTING_TEST_ID,
            ],
            timeoutMs: 180_000,
        });
        await expect(
            page.getByTestId(PACKED_VOICE_PROVISIONING_SETTING_TEST_ID).getByRole('switch'),
        ).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
        await deleteVoiceCredentialThroughUi({
            page,
            credentialTestId: PACKED_VOICE_CREDENTIAL_TEST_ID,
        });
        const acceptedRequestsBeforeDeletedCredentialStart = voiceProviderServer.requests.length;
        const connectionCountBeforeDeletedCredentialStart = (await readPackedVoiceFixtureEvents(page))
            .filter((event) => event.kind === 'connection_created')
            .length;

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(
                uiBaseUrl,
                server.baseUrl,
                `/session/${encodeURIComponent(targetSession.sessionId)}?happier_hmr=0`,
            ),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: `/session/${targetSession.sessionId}`,
            requiredTestIds: ['voice-surface:sidebar', 'voice-surface-toggle:sidebar'],
            timeoutMs: 180_000,
        });
        await page.getByTestId('voice-surface-toggle:sidebar').click();
        const deletedCredentialRecovery = page.getByTestId('voice-surface-recovery:sidebar');
        await expect(deletedCredentialRecovery).toHaveCount(1, {
            timeout: 120_000,
        });
        await expect(page.getByTestId('voice-surface-toggle:sidebar')).toHaveCount(0);
        expect(voiceProviderServer.requests).toHaveLength(acceptedRequestsBeforeDeletedCredentialStart);
        expect(
            (await readPackedVoiceFixtureEvents(page))
                .filter((event) => event.kind === 'connection_created'),
        ).toHaveLength(connectionCountBeforeDeletedCredentialStart);
        await deletedCredentialRecovery.click();
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/voice/conversations',
            requiredTestIds: [
                PACKED_VOICE_PROVIDER_ROW_TEST_ID,
                PACKED_VOICE_CREDENTIAL_TEST_ID,
            ],
            timeoutMs: 120_000,
        });

        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins',
            requiredTestIds: [`settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}`],
            timeoutMs: 180_000,
        });
        const liveVoiceSurface = page.getByTestId('voice-surface:sidebar');
        await expect(liveVoiceSurface).toHaveCount(1, { timeout: 120_000 });
        const appShellDocumentMarker = `packed-voice-disable-${randomBytes(16).toString('hex')}`;
        await page.evaluate((marker) => {
            Reflect.set(globalThis, '__HAPPIER_PACKED_VOICE_APPSHELL_DOCUMENT_MARKER__', marker);
        }, appShellDocumentMarker);
        const disableAction = page.getByTestId(`settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}.action.disable`);
        await expect(disableAction).toBeEnabled({ timeout: 120_000 });
        await disableAction.click();
        await dismissSuccessAlert(page);
        await expect(liveVoiceSurface).toHaveCount(0, { timeout: 180_000 });
        expect(await page.evaluate(() => (
            Reflect.get(globalThis, '__HAPPIER_PACKED_VOICE_APPSHELL_DOCUMENT_MARKER__')
        ))).toBe(appShellDocumentMarker);
        const authorityRemovedBeforeReload = await liveVoiceSurface.count() === 0;
        expect(authorityRemovedBeforeReload).toBe(true);

        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/voice/conversations?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/voice/conversations',
            requiredTestIds: ['settings.voice.provider.off'],
            timeoutMs: 180_000,
        });
        await expect(page.getByTestId(PACKED_VOICE_PROVIDER_ROW_TEST_ID)).toHaveCount(0, { timeout: 180_000 });

        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins',
            requiredTestIds: [`settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}`],
            timeoutMs: 180_000,
        });
        const enableAction = page.getByTestId(
            `settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}.action.enable`,
        );
        await expect(enableAction).toBeEnabled({ timeout: 120_000 });
        await enableAction.click();
        await dismissSuccessAlert(page);
        await expect(liveVoiceSurface).toHaveCount(1, { timeout: 180_000 });
        const disableAgainAction = page.getByTestId(
            `settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}.action.disable`,
        );
        await expect(disableAgainAction).toBeEnabled({ timeout: 120_000 });
        await disableAgainAction.click();
        await dismissSuccessAlert(page);
        await expect(liveVoiceSurface).toHaveCount(0, { timeout: 180_000 });

        const uninstallEnvelope = await runCliJson({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: cliEnv,
            label: 'packed-voice-uninstall',
            args: ['plugins', 'uninstall', PACKED_VOICE_PLUGIN_ID, '--json'],
            timeoutMs: 180_000,
            ...(packedCandidate ? { cliLaunchSpec: packedCandidate.cliLaunchSpec } : {}),
            launchOptions: cliLaunchOptions,
        });
        expect(uninstallEnvelope).toMatchObject({ ok: true, kind: 'plugins_uninstall' });
        await expect(access(installedPluginPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins?happier_hmr=0'), 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins',
            requiredTestIds: ['settings.plugins.marketplace.catalogUrl'],
            timeoutMs: 180_000,
        });
        await expect(page.getByTestId(`settings.plugins.marketplace.installed.${PACKED_VOICE_PLUGIN_ID}`)).toHaveCount(0, { timeout: 180_000 });

        const daemonPid = daemon.state.pid;
        await daemon.stop();
        daemon = null;
        await voiceProviderServer.close();
        packedVoiceProviderServer = null;
        const sensitiveValues = [initialSourceSecret, activeSourceSecret];
        const sensitiveFiles = await findSensitiveArtifactFiles({
            rootPath: testDir,
            sensitiveValues,
        });
        expect(sensitiveFiles).toEqual([]);
        const publicArtifactTexts = await Promise.all([
            Promise.resolve(JSON.stringify(packEnvelope)),
            Promise.resolve(JSON.stringify(installEnvelope)),
            Promise.resolve(JSON.stringify(uninstallEnvelope)),
            Promise.resolve(packedVoiceProjectionJson),
            Promise.resolve(normalUiFixtureEventsJson),
            Promise.resolve(firstRunFixtureEventsJson),
            Promise.resolve(postReloadFixtureEventsJson),
            page.content(),
            readFile(server.proc.stdoutPath, 'utf8').catch(() => ''),
            readFile(server.proc.stderrPath, 'utf8').catch(() => ''),
            ui?.proc ? readFile(ui.proc.stdoutPath, 'utf8').catch(() => '') : Promise.resolve(''),
            ui?.proc ? readFile(ui.proc.stderrPath, 'utf8').catch(() => '') : Promise.resolve(''),
        ]);
        for (const sensitiveValue of sensitiveValues) {
            expect(publicArtifactTexts.some((text) => text.includes(sensitiveValue))).toBe(false);
        }

        await writeRedactedResultArtifact({
            testDir,
            artifactName: 'packed-voice-appshell.result.json',
            label: 'packed-voice-appshell',
            outcome: {
                archiveDigest,
                pluginId: PACKED_VOICE_PLUGIN_ID,
                providerId: PACKED_VOICE_PROVIDER_ID,
                targetSessionId: targetSession.sessionId,
                conversationSessionId: conversationSession.sessionId,
                providerSelected: true,
                initialCredentialMissing: true,
                credentialSaveChangeDeleteCompleted: true,
                settingsActionGestureConfirmed: true,
                settingsActionCasPatchApplied: true,
                providerRequestsObserved: voiceProviderServer.requests.length,
                catalogNormalized: firstRunFixtureEventsJson.includes('packed-voice-primary'),
                clientAuthArtifactBounded: true,
                normalUiActivityFeedEnabled: true,
                normalUiControllerConnected: normalUiFixtureEventsJson.includes('connected'),
                normalUiTranscriptObserved,
                normalUiCancelObserved: normalUiFixtureEventsJson.includes('fixture_cancel'),
                normalUiControllerClosed: normalUiFixtureEventsJson.includes('closed'),
                controllerConnected: firstRunFixtureEventsJson.includes('connected'),
                transcriptObserved: true,
                toolResultsObserved: firstRunFixtureEventsJson.includes('fixture_tool_results'),
                toolContinuationObserved: firstRunFixtureEventsJson.includes('fixture_continue'),
                cancelObserved: firstRunFixtureEventsJson.includes('fixture_cancel'),
                controllerClosed: firstRunFixtureEventsJson.includes('closed'),
                reloadGenerationChanged: generationAfterReload !== generationBeforeReload,
                reloadedControllerConnected: postReloadFixtureEventsJson.includes('connected'),
                deletedCredentialFailedClosed: true,
                sourceCredentialLeakScanPassed: true,
                authorityRemoved: authorityRemovedBeforeReload,
                pluginUninstalled: true,
                installedResourcesRemoved: true,
                serverPid: server.proc.child.pid ?? -1,
                uiPid: ui?.proc?.child.pid ?? -1,
                daemonPid,
                serverUrl: server.baseUrl,
                uiUrl: uiBaseUrl,
                cliRuntime: packedCandidate
                    ? `packed-candidate:${packedCandidate.attestation.cliVersion}:${packedCandidate.attestation.cliIntegrity}`
                    : 'current-source',
                uiRuntimeMode: ui?.mode ?? uiWebMode,
                uiRuntimeSourceFingerprint: uiSourceFingerprint,
            },
        });
        const resultArtifactText = await readFile(join(testDir, 'packed-voice-appshell.result.json'), 'utf8');
        for (const sensitiveValue of sensitiveValues) {
            expect(resultArtifactText).not.toContain(sensitiveValue);
        }
    });

    test('attests and mounts the exact packed-candidate Inspector RNW graph with deterministic accessibility modes', async ({ page }) => {
        test.setTimeout(600_000);
        test.skip(!packedCandidate, 'requires HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST');
        if (
            !server
            || !uiBaseUrl
            || !packedCandidate
            || !packedNovelConnectedAccount
        ) {
            throw new Error('missing packed candidate/server/ui fixtures');
        }
        expect(packedNovelConnectedAccount.service).toEqual({
            pluginId: 'acme.vertical-a',
            localId: 'novel-cloud',
        });
        expect(packedNovelConnectedAccount.authenticationModeIds).toEqual([
            'manual',
            'oauth',
            'device',
        ]);

        const testDir = resolve(join(suiteDir, 't3-packed-candidate-inspector-rnw'));
        const cliHomeDir =
            packedNovelConnectedAccount.isolation.happyHomeDir;
        const oauthClientSecret = randomBytes(32).toString('base64url');
        await mkdir(cliHomeDir, { recursive: true });
        packedNovelConnectedAccountProviderServer =
            await startPackedNovelConnectedAccountProvider();
        await page.setViewportSize({ width: 1440, height: 900 });

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
            storageScope: `e2e-settings-plugins-details-${run.runId}`,
        }));

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: cliHomeDir,
            cliLaunchSpec: packedCandidate.cliLaunchSpec,
            env: {
                ...process.env,
                CI: '1',
                NODE_EXTRA_CA_CERTS:
                    packedNovelConnectedAccount.authorization.caCertificatePath,
                HAPPIER_HOME_DIR: cliHomeDir,
                HAPPIER_SERVER_URL: server.baseUrl,
                HAPPIER_WEBAPP_URL: uiBaseUrl,
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });
        const candidateCliEnv: NodeJS.ProcessEnv = {
            ...process.env,
            CI: '1',
            NODE_EXTRA_CA_CERTS:
                packedNovelConnectedAccount.authorization.caCertificatePath,
        };
        const novelInstallEnvelope = await runCliJson({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: candidateCliEnv,
            label: 'packed-novel-connected-account-install',
            args: [
                'plugins',
                'install',
                packedNovelConnectedAccount.pluginArchivePath,
                '--json',
            ],
            timeoutMs: 240_000,
            cliLaunchSpec: packedCandidate.cliLaunchSpec,
        });
        const novelInstallReview =
            readPluginInstallReviewRequiredEnvelope(novelInstallEnvelope);
        expect(novelInstallReview.review.pluginId).toBe('acme.vertical-a');
        const novelInstallOutcome =
            await decideAuthenticatedPluginInstallReview({
                cliHomeDir,
                serverUrl: server.baseUrl,
                pendingChangeId: novelInstallReview.pendingChangeId,
                optionalSelections:
                    novelInstallReview.review.optionalHostAccess.map(
                        (entry) => ({
                            accessId: entry.id,
                            selected: false,
                        }),
                    ),
                confirmPresentUser: async () => true,
            });
        expect(novelInstallOutcome).toMatchObject({
            kind: 'committed',
            pluginId: 'acme.vertical-a',
        });

        const publicAuthoring = packedNovelConnectedAccount.publicAuthoring;
        expect(publicAuthoring).toMatchObject({
            pluginId: 'examples.public-sdk-review-assistant',
            version: '0.1.0',
            archive: {
                integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]+={0,2}$/u),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
            hostedWeb: {
                contributionId: 'review-web',
                digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            },
        });
        const publicAuthoringInstallEnvelope = await runCliJson({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: candidateCliEnv,
            label: 'packed-public-authoring-install',
            args: [
                'plugins',
                'install',
                publicAuthoring.archivePath,
                '--json',
            ],
            timeoutMs: 240_000,
            cliLaunchSpec: packedCandidate.cliLaunchSpec,
        });
        const publicAuthoringInstallReview =
            readPluginInstallReviewRequiredEnvelope(publicAuthoringInstallEnvelope);
        expect(publicAuthoringInstallReview.review.pluginId).toBe(
            publicAuthoring.pluginId,
        );
        const publicAuthoringInstallOutcome =
            await decideAuthenticatedPluginInstallReview({
                cliHomeDir,
                serverUrl: server.baseUrl,
                pendingChangeId: publicAuthoringInstallReview.pendingChangeId,
                optionalSelections:
                    publicAuthoringInstallReview.review.optionalHostAccess.map(
                        (entry) => ({
                            accessId: entry.id,
                            selected: false,
                        }),
                    ),
                confirmPresentUser: async () => true,
            });
        expect(publicAuthoringInstallOutcome).toMatchObject({
            kind: 'committed',
            pluginId: publicAuthoring.pluginId,
        });

        for (const fixture of PACKED_CONNECTED_ACCOUNT_COLLISION_FIXTURES) {
            const sourceRoot = resolve(
                repoRootDir(),
                'apps/cli/src/plugins/authoring/fixtures',
                fixture.sourceDirectory,
            );
            const archivePath = resolve(
                join(testDir, `${fixture.pluginId}.tgz`),
            );
            await runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                webappUrl: uiBaseUrl,
                env: candidateCliEnv,
                label: `${fixture.pluginId}-pack`,
                args: [
                    'plugins',
                    'pack',
                    sourceRoot,
                    '--out',
                    archivePath,
                    '--json',
                ],
                timeoutMs: 240_000,
                cliLaunchSpec: packedCandidate.cliLaunchSpec,
            });
            const installEnvelope = await runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                webappUrl: uiBaseUrl,
                env: candidateCliEnv,
                label: `${fixture.pluginId}-install`,
                args: ['plugins', 'install', archivePath, '--json'],
                timeoutMs: 240_000,
                cliLaunchSpec: packedCandidate.cliLaunchSpec,
            });
            const installReview =
                readPluginInstallReviewRequiredEnvelope(installEnvelope);
            expect(installReview.review.pluginId).toBe(fixture.pluginId);
            const installOutcome =
                await decideAuthenticatedPluginInstallReview({
                    cliHomeDir,
                    serverUrl: server.baseUrl,
                    pendingChangeId: installReview.pendingChangeId,
                    optionalSelections:
                        installReview.review.optionalHostAccess.map(
                            (entry) => ({
                                accessId: entry.id,
                                selected: false,
                            }),
                        ),
                    confirmPresentUser: async () => true,
                });
            expect(installOutcome).toMatchObject({
                kind: 'committed',
                pluginId: fixture.pluginId,
            });
        }

        const projectionSocket = createUserScopedSocketCollector(server.baseUrl, auth.token, {
            captureEvents: false,
        });
        projectionSocket.connect();
        let runtimeAttestation: ReturnType<typeof attestCandidateInspectorRuntime>;
        let publicAuthoringRuntimeAttestation:
            ReturnType<typeof attestPackedPublicAuthoringHostedWebRuntime>;
        try {
            const projectionResponse = unwrapDataKeyRpcResult(await createDataKeyRpcClient(
                projectionSocket,
                machineKey,
            ).call(
                `${seeded.machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
                {
                    machineId: seeded.machineId,
                    reactNativeWebLoaderCapability: {
                        integrated: true,
                        installedArtifactLoaderAvailable: true,
                    },
                },
                60_000,
            ), 'packed candidate Inspector contribution projection');
            runtimeAttestation = attestCandidateInspectorRuntime({
                expectedCliVersion: packedCandidate.attestation.cliVersion,
                expectedInspectorWebArtifactDigest:
                    packedCandidate.attestation.inspectorWebArtifactDigest,
                daemonState: daemon.state,
                projectionResponse,
            });
            publicAuthoringRuntimeAttestation =
                attestPackedPublicAuthoringHostedWebRuntime({
                    publicAuthoring,
                    projectionResponse,
                });
        } finally {
            projectionSocket.close();
        }

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
        const connectedAccountRoute = new URL(
            buildServerScopedUiUrl(
                uiBaseUrl,
                server.baseUrl,
                '/settings/connected-services/account?happier_hmr=0',
            ),
        );
        connectedAccountRoute.searchParams.set(
            'pluginId',
            packedNovelConnectedAccount.service.pluginId,
        );
        connectedAccountRoute.searchParams.set(
            'localId',
            packedNovelConnectedAccount.service.localId,
        );
        await gotoDomContentLoadedWithRetries(
            page,
            connectedAccountRoute.href,
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/connected-services/account',
            requiredTestIds: ['connected-account-mode:oauth'],
            timeoutMs: 180_000,
        });
        await page.getByTestId('connected-account-mode:oauth').click();
        await expect(
            page.getByTestId(
                'connected-account-configuration:authorization-origin',
            ),
        ).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('connected-account-configuration:api-origin')
            .fill(packedNovelConnectedAccountProviderServer.origin);
        await page.getByTestId(
            'connected-account-configuration:authorization-origin',
        ).fill(
            packedNovelConnectedAccount
                .authorizationOriginConfiguration['authorization-origin'],
        );
        await page.getByTestId('connected-account-configuration:tenant')
            .fill('packed-browser');
        await page.getByTestId(
            'connected-account-configuration:client-secret',
        ).fill(oauthClientSecret);
        await page.getByTestId(
            'connected-account-configuration:save',
        ).click();

        const oauthCallbackInput =
            page.getByTestId('connected-account-oauth:callback');
        await expect(oauthCallbackInput).toBeVisible({ timeout: 120_000 });
        const authorizationOrigin =
            packedNovelConnectedAccount.authorization.origin;
        const escapedAuthorizationOrigin = authorizationOrigin.replace(
            /[.*+?^${}()|[\]\\]/gu,
            '\\$&',
        );
        const pageText = await page.locator('body').innerText();
        const authorizationUrl = pageText.match(
            new RegExp(`${escapedAuthorizationOrigin}/authorize\\?[^\\s]+`, 'u'),
        )?.[0] ?? null;
        if (!authorizationUrl) {
            throw new Error(
                'packed_novel_browser_authorization_url_missing',
            );
        }
        const expectedOauthState =
            new URL(authorizationUrl).searchParams.get('state');
        if (!expectedOauthState) {
            throw new Error(
                'packed_novel_browser_authorization_state_missing',
            );
        }
        const expectedOauthCallbackUrl =
            packedNovelConnectedAccount.oauth.callbackUrl;
        const callbackRequestFailurePromise =
            page.context().waitForEvent('requestfailed', {
                predicate: (request) => {
                    const url = new URL(request.url());
                    return (
                        url.origin + url.pathname
                            === expectedOauthCallbackUrl
                        && url.searchParams.get('code') === 'oauth-account'
                        && url.searchParams.get('state') === expectedOauthState
                    );
                },
                timeout: 120_000,
            });
        const popupPromise = page.context().waitForEvent('page');
        await page.getByTestId('connected-account-oauth:open').click();
        const authorizationPage = await popupPromise;
        let callbackUrl = '';
        try {
            const failedCallbackRequest =
                await callbackRequestFailurePromise;
            expect(failedCallbackRequest.failure()?.errorText)
                .toBe('net::ERR_CONNECTION_REFUSED');
            callbackUrl = failedCallbackRequest.url();
        } finally {
            await authorizationPage.close().catch(() => undefined);
        }
        const parsedCallbackUrl = new URL(callbackUrl);
        expect(
            parsedCallbackUrl.origin + parsedCallbackUrl.pathname,
        ).toBe(expectedOauthCallbackUrl);
        expect(parsedCallbackUrl.searchParams.get('code'))
            .toBe('oauth-account');
        expect(parsedCallbackUrl.searchParams.get('state'))
            .toBe(expectedOauthState);
        await oauthCallbackInput.fill(callbackUrl);
        await page.getByTestId('connected-account-oauth:submit').click();
        await expect(page.getByTestId('connected-account:oauth-account'))
            .toBeVisible({ timeout: 120_000 });
        expect(
            packedNovelConnectedAccount.authorization.getRequestSummary(),
        ).toEqual({
            authorizationRedirects: 1,
            rejectedRequests: 0,
        });
        expect(
            packedNovelConnectedAccountProviderServer.requestCount(),
        ).toBeGreaterThanOrEqual(2);

        for (const account of [{
            token: 'token-a',
            accountId: 'account-a',
            label: 'Novel account-a',
        }, {
            token: 'token-b',
            accountId: 'account-b',
            label: 'Novel account-b',
        }]) {
            await page.getByTestId('connected-account-mode:manual').click();
            if (account.accountId === 'account-a') {
                const manualConfigurationOrigin = page.getByTestId(
                    'connected-account-configuration:api-origin',
                );
                await expect(manualConfigurationOrigin)
                    .toBeVisible({ timeout: 120_000 });
                await manualConfigurationOrigin.fill(
                    packedNovelConnectedAccountProviderServer.origin,
                );
                await page.getByTestId(
                    'connected-account-configuration:save',
                ).click();
            }
            const manualToken = page.getByTestId(
                'connected-account-manual:token',
            );
            await expect(manualToken).toBeVisible({ timeout: 120_000 });
            await manualToken.fill(account.token);
            await page.getByTestId('connected-account-manual:submit').click();
            await expect(page.getByTestId(`connected-account:${account.accountId}`))
                .toContainText(account.label, { timeout: 120_000 });
        }

        await page.getByTestId(
            'connected-services-detail-shell:segment:pools',
        ).click();
        await page.getByTestId('connected-services-pool-action:create').click();
        await page.getByTestId('web-prompt-input')
            .fill('Packed fallback accounts');
        await page.getByTestId('web-prompt-confirm').click();
        await expect(page.getByTestId('connected-services-pool-detail'))
            .toBeVisible({ timeout: 120_000 });
        const membersSelect = page.getByTestId(
            'connected-services-pool-detail:members-select',
        );
        await membersSelect.click();
        await page.getByTestId(
            'qualified-connected-account-group:members:option:account-a',
        ).click();
        await page.getByTestId(
            'qualified-connected-account-group:members:option:account-b',
        ).click();
        await membersSelect.click();
        await expect(page.getByTestId(
            'connected-services-pool-detail:member:account-a',
        )).toContainText('Novel account-a', { timeout: 120_000 });
        await expect(page.getByTestId(
            'connected-services-pool-detail:member:account-b',
        )).toContainText('Novel account-b', { timeout: 120_000 });

        const connectedServicesIndexUrl = buildServerScopedUiUrl(
            uiBaseUrl,
            server.baseUrl,
            '/settings/connected-services?happier_hmr=0',
        );
        await gotoDomContentLoadedWithRetries(
            page,
            connectedServicesIndexUrl,
            180_000,
        );
        for (const fixture of PACKED_CONNECTED_ACCOUNT_COLLISION_FIXTURES) {
            await expect(page.getByText(fixture.serviceTitle, { exact: true }).first())
                .toBeVisible({ timeout: 120_000 });
        }
        for (const fixture of PACKED_CONNECTED_ACCOUNT_COLLISION_FIXTURES) {
            await page.getByText(fixture.serviceTitle, { exact: true }).click();
            await expect.poll(() => {
                const url = new URL(page.url());
                return {
                    pathname: url.pathname,
                    pluginId: url.searchParams.get('pluginId'),
                    localId: url.searchParams.get('localId'),
                };
            }, { timeout: 120_000 }).toEqual({
                pathname: '/settings/connected-services/account',
                pluginId: fixture.pluginId,
                localId: fixture.localId,
            });
            await page.getByTestId('connected-account-mode:manual').click();
            const manualToken = page.getByTestId(
                'connected-account-manual:token',
            );
            await expect(manualToken).toBeVisible({ timeout: 120_000 });
            await manualToken.fill('packed-test-token');
            await page.getByTestId('connected-account-manual:submit').click();
            await expect(page.getByText(fixture.serviceTitle, { exact: true }).first())
                .toBeVisible({ timeout: 120_000 });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect.poll(() => {
                const url = new URL(page.url());
                return {
                    pluginId: url.searchParams.get('pluginId'),
                    localId: url.searchParams.get('localId'),
                };
            }, { timeout: 120_000 }).toEqual({
                pluginId: fixture.pluginId,
                localId: fixture.localId,
            });
            await expect(page.getByText(fixture.serviceTitle, { exact: true }).first())
                .toBeVisible({ timeout: 120_000 });
            await gotoDomContentLoadedWithRetries(
                page,
                connectedServicesIndexUrl,
                180_000,
            );
            for (const peer of PACKED_CONNECTED_ACCOUNT_COLLISION_FIXTURES) {
                await expect(page.getByText(peer.serviceTitle, { exact: true }).first())
                    .toBeVisible({ timeout: 120_000 });
            }
        }

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(
                uiBaseUrl,
                server.baseUrl,
                '/settings/providers?happier_hmr=0',
            ),
            180_000,
        );
        const packedProviderContributionKey =
            'acme.vertical-a/packed-managed-provider';
        const packedProvider = page.getByTestId(
            `settings-provider-available:${packedProviderContributionKey}`,
        );
        await expect(packedProvider).toBeVisible({ timeout: 120_000 });
        await packedProvider.click();
        await expect(page.getByTestId('settings-provider-authoring-built-in'))
            .toBeVisible({ timeout: 120_000 });
        const connectProvider = page.getByTestId(
            'settings-provider-authoring-connect',
        );
        await expect(connectProvider).toBeEnabled({ timeout: 120_000 });
        await connectProvider.click();
        await expect.poll(() => new URL(page.url()).pathname, {
            timeout: 120_000,
        }).toMatch(/^\/settings\/providers\/pc_/u);
        const configureManagedProvider = page.getByTestId(
            'provider-connection-managed-configure',
        );
        await expect(configureManagedProvider)
            .toBeVisible({ timeout: 120_000 });
        await configureManagedProvider.click();
        const purposeChooser = page.getByTestId(
            'provider-connection-managed-purpose-chooser:upstream',
        );
        await purposeChooser.click();
        for (const label of [
            'Novel account-a',
            'Novel account-b',
            'Packed fallback accounts',
        ]) {
            await expect(page.getByText(label, { exact: true }).last())
                .toBeVisible({ timeout: 120_000 });
        }
        await page.getByText('Packed fallback accounts', { exact: true }).last()
            .click();
        await expect(purposeChooser).toContainText('Packed fallback accounts');
        await page.getByTestId(
            'provider-connection-managed-purpose-chooser:upstream:reload',
        ).click();
        await purposeChooser.click();
        for (const label of [
            'Novel account-a',
            'Novel account-b',
            'Packed fallback accounts',
        ]) {
            await expect(page.getByText(label, { exact: true }).last())
                .toBeVisible({ timeout: 120_000 });
        }
        expect(await page.locator('body').innerText()).not.toContain(
            'packed-test-token',
        );
        expect(await page.locator('body').innerText()).not.toContain('token-a');
        expect(await page.locator('body').innerText()).not.toContain('token-b');

        await gotoDomContentLoadedWithRetries(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins/panels?happier_hmr=0'),
            180_000,
        );
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins/panels',
            requiredTestIds: ['settings.plugins.appPanels.host', 'inspector-surface'],
            timeoutMs: 180_000,
        });

        const inspectorTab = page.getByTestId(
            'app-scope-right-sidebar-tab:plugin:happier.inspector:inspector-app',
        );
        await expect(inspectorTab).toHaveRole('tab');
        await expect(inspectorTab).toHaveAccessibleName('Plugin Inspector');
        await inspectorTab.focus();
        await expect(inspectorTab).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(inspectorTab).toHaveAttribute('aria-selected', 'true');
        const tabBox = await inspectorTab.boundingBox();
        expect(tabBox?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(tabBox?.height ?? 0).toBeGreaterThanOrEqual(44);

        const inspectorSurface = page.getByTestId('inspector-surface');
        const inspectorPlugin = page.getByTestId('inspector-plugin-happier.inspector');
        await expect(inspectorSurface).toBeVisible();
        await expect(inspectorPlugin).toBeVisible();
        await inspectorPlugin.click();
        const reloadSelected = page.getByTestId('inspector-reload-selected-happier.inspector');
        await expect(reloadSelected).toBeVisible();
        await reloadSelected.focus();
        await expect(reloadSelected).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('inspector-last-reload')).toContainText(
            'Last reload succeeded',
            { timeout: 120_000 },
        );
        await page.waitForTimeout(1_000);
        await expect(inspectorSurface).toBeVisible();

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await reloadSelected.click();
        await expect(page.getByTestId('inspector-last-reload')).toBeVisible({
            timeout: 120_000,
        });

        await page.evaluate(() => {
            document.documentElement.dir = 'rtl';
            document.documentElement.style.zoom = '2';
        });
        await expect(inspectorSurface).toBeVisible();
        await inspectorTab.focus();
        await expect(inspectorTab).toBeFocused();
        await page.evaluate(() => {
            document.documentElement.dir = 'ltr';
            document.documentElement.style.zoom = '1';
        });
        await page.screenshot({
            path: join(testDir, 'packed-candidate-inspector-rnw.png'),
            fullPage: true,
        });

        const daemonPid = daemon.state.pid;
        await daemon.stop();
        daemon = null;
        const sensitiveFiles = (
            await Promise.all([
                findSensitiveArtifactFiles({
                    rootPath: testDir,
                    sensitiveValues: [
                        oauthClientSecret,
                        'oauth:oauth-account',
                    ],
                    strict: true,
                }),
                findSensitiveArtifactFiles({
                    rootPath:
                        packedNovelConnectedAccount.isolation.root,
                    sensitiveValues: [
                        oauthClientSecret,
                        'oauth:oauth-account',
                    ],
                    strict: true,
                }),
            ])
        ).flat().sort();
        expect(sensitiveFiles).toEqual([]);
        await writeRedactedResultArtifact({
            testDir,
            artifactName: 'packed-candidate-inspector-rnw.result.json',
            label: 'packed-candidate-inspector-rnw',
            outcome: {
                candidateRunId: packedCandidate.attestation.runId,
                sdkVersion: packedCandidate.attestation.sdkVersion,
                sdkIntegrity: packedCandidate.attestation.sdkIntegrity,
                cliVersion: runtimeAttestation.cliVersion,
                cliIntegrity: packedCandidate.attestation.cliIntegrity,
                inspectorContributionId: packedCandidate.attestation.inspectorContributionId,
                inspectorWebArtifactDigest: runtimeAttestation.inspectorWebArtifactDigest,
                inspectorIosArtifactDigest:
                    packedCandidate.attestation.inspectorIosArtifactDigest,
                inspectorAndroidArtifactDigest:
                    packedCandidate.attestation.inspectorAndroidArtifactDigest,
                inspectorRepackContainerName:
                    packedCandidate.attestation.inspectorRepackContainerName,
                inspectorRepackModulePath:
                    packedCandidate.attestation.inspectorRepackModulePath,
                inspectorRepackExportName:
                    packedCandidate.attestation.inspectorRepackExportName,
                inspectorPlatforms: JSON.stringify(
                    packedCandidate.attestation.inspectorPlatforms,
                ),
                publicAuthoringPluginId: publicAuthoring.pluginId,
                publicAuthoringVersion: publicAuthoring.version,
                publicAuthoringArchiveIntegrity:
                    publicAuthoring.archive.integrity,
                publicAuthoringHostedWebDigest:
                    publicAuthoringRuntimeAttestation.hostedWebDigest,
                publicAuthoringProjectionGeneration:
                    publicAuthoringRuntimeAttestation.projectionGeneration,
                projectionGeneration: runtimeAttestation.projectionGeneration,
                artifactMounted: true,
                keyboardFocusVerified: true,
                targetSizeVerified: true,
                reducedMotionVerified: true,
                rtlVerified: true,
                zoom200Verified: true,
                daemonPid,
            },
        });
    });
});
