import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { ThemeProfileV1Schema } from '@happier-dev/protocol/account/settings/themeProfiles';
import { RegistryProvenanceV1Schema } from '@happier-dev/protocol/registries/registryItemsV1';
import type { RegistryUpdateCheckResultV1 } from '@happier-dev/protocol/registries/registryUpstreamV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { createTestAuth } from '../../src/testkit/auth';
import { readEncryptedAccountSettingsV2, upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { buildTestAccountCliAuthCredentials, seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { resolveDaemonStartupPhaseTimeoutMs, startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy } from '../../src/testkit/httpRequestRecordingProxy';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import openVsx from '../../fixtures/themes/openvsx-http.json';

// PLAN.md Final Action contract v1. Future result shapes stay structural here:
// these acceptance tests must load before the Action-family producer lands.
type Ref = { kind: 'artifact'; id: string } | { kind: 'built-in'; presetId: string }
    | { kind: 'plugin'; pluginId: string; contributionId: string };
type Entry = { reference: Ref; name: string; source?: { kind: string; provenance?: unknown } };
type Preview = { previewRef: string; coverage: { total: number; native: number; webOnly: number; hides: unknown[] } };
type Kept = { entry: Entry; undoHandle: string };
type Applied = { applied: { clientId?: string; mode: 'light' | 'dark' }; undoHandle: string };
type ListingKey = { sourceId: string; itemId: string };
const run = createRunDirs({ runLabel: 'core' });
const testDir = run.testDir(`themes-composed-${randomUUID()}`);
let server: StartedServer | undefined;
let daemon: StartedDaemon | undefined;
let home: HttpRequestRecordingProxy | undefined;
let connectUiActionClient: typeof import('@happier-tests/ui-action-client').connectUiActionClient;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let machineId: string;
let readSettings: () => ReturnType<typeof readEncryptedAccountSettingsV2>;
let seedLegacySettings: () => Promise<number>;
let uiCredentials: Parameters<typeof connectUiActionClient>[0]['credentials'];
let controlCredentials: typeof uiCredentials;
// Released ui-web-v0.2.20 Account library shape (accountDisplaySettingDefinitions
// and themeProfileTypes). A valid UUID survives the existing Artifact id scope.
const legacyProfile = { schemaVersion: 1, id: 'a47b4b4d-b1c3-47ef-83bc-38750ec55885', name: 'Released saved theme',
    createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } };

beforeAll(async () => {
    // Only an explicitly supplied disposable database may be migrated. Never
    // inherit DATABASE_URL from a developer's retained Stack.
    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    if (!databaseUrl) throw new Error('Supply the disposable PostgreSQL harness URL');
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(resolve(repoRootDir(),
        'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    // Both source-loaded processes share the canonical daemon startup phase
    // budget; the server's shorter default otherwise cuts off valid TS boots.
    const startupTimeoutMs = resolveDaemonStartupPhaseTimeoutMs(process.env, undefined);
    console.info('THEMES STARTUP: source server');
    server = await startServerLight({ testDir, dbProvider: 'postgres', startupTimeoutMs, extraEnv: {
        DATABASE_URL: databaseUrl, NODE_OPTIONS: sourceOptions, NODE_ENV: 'test',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    console.info('THEMES STARTUP: source server healthy');
    home = await startHttpRequestRecordingProxy({ targetBaseUrl: server.baseUrl,
        captureRequestBody: row => row.path.split('?')[0] === '/v1/artifacts/read' });
    // Import once; every flow below owns a fresh Account and enrolled daemon.
    ({ connectUiActionClient } = await import('@happier-tests/ui-action-client'));
    console.info('THEMES STARTUP: UI host loaded');
}, 0);

async function startControlAccount() {
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(resolve(repoRootDir(),
        'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    const startupTimeoutMs = resolveDaemonStartupPhaseTimeoutMs(process.env, undefined);
    const auth = await createTestAuth(home!.baseUrl);
    const account = { baseUrl: home!.baseUrl, token: auth.token, secret: auth.accountSigningSeed };
    readSettings = () => readEncryptedAccountSettingsV2(account);
    const controlDir = resolve(testDir, `control-account-${randomUUID()}`);
    const happyHomeDir = resolve(controlDir, 'daemon-home');
    await mkdir(happyHomeDir, { recursive: true });
    ({ machineId } = await seedCliAuthForTestAccount({ cliHome: happyHomeDir,
        serverUrl: home!.baseUrl, auth, mode: 'legacy' }));
    // Consume the moving authored CLI through the canonical source loader.
    // The harness's explicit process adapter avoids its dist-snapshot publisher.
    daemon = await startTestDaemon({ testDir: controlDir, happyHomeDir, startupTimeoutMs, requireMachineControlReady: true,
        cliLaunchSpec: { command: process.execPath, args: [resolve(repoRootDir(), 'apps/cli/src/index.ts')],
            cwd: resolve(repoRootDir(), 'apps/cli') }, env: { ...process.env,
        NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_SERVER_URL: home!.baseUrl,
        HAPPIER_WEBAPP_URL: home!.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1', CI: '1',
    } });
    uiCredentials = buildTestAccountCliAuthCredentials({ auth, mode: 'legacy' });
    controlCredentials = uiCredentials;
// Process fixtures own their startup phase budgets (daemon defaults to 300s).
// Disable Vitest's shorter outer hook cutoff; do not invent a competing budget.
}

// The canonical UI setup resets device credentials before every test. Each
// flow owns its Account/daemon as well; only Home/Postgres and module loading are shared.
beforeEach(async context => {
    await startControlAccount();
    ui = await connectUiActionClient({ serverUrl: home!.baseUrl, credentials: uiCredentials });
    if (!ui.isMachineActive(machineId)) {
        // Preserve boundary evidence before cleanup retires the Account. Never
        // record tokens, encryption material, Machine metadata or content.
        const socketPath = '../../../../apps/ui/sources/sync/api/session/apiSocket';
        const { apiSocket } = await import(socketPath) as { apiSocket: { config?: { token: string } } };
        const encryptionPath = '../../../../apps/ui/sources/sync/encryption/scopedAccountEncryption';
        const { readScopedAccountEncryption } = await import(encryptionPath) as {
            readScopedAccountEncryption(serverId: string): { getMachineEncryptionContext(id: string): { isCurrent(): boolean } | null } | null;
        };
        const encryption = readScopedAccountEncryption(ui.serverId);
        const observations = await Promise.all(['/v1/machines', '/v1/machines?includeRevoked=true'].map(async path => {
            const response = await fetch(`${home!.baseUrl}${path}`, { headers: { Authorization: `Bearer ${uiCredentials.token}` } });
            const body: unknown = await response.json();
            return { path, status: response.status, rows: Array.isArray(body) ? body.map(row => ({ id: row.id, active: row.active })) : null };
        }));
        await writeFile(resolve(testDir, `${context.task.name.slice(0, 2)}-control-census.json`), JSON.stringify({
            machineId, socketCredentialMatches: apiSocket.config?.token === uiCredentials.token,
            accountReady: ui.isAccountReady(), uiMachineIds: Object.keys((await appState()).machines), observations,
            admittedEncryption: Boolean(encryption),
            machineEncryptionCurrent: encryption?.getMachineEncryptionContext(machineId)?.isCurrent() ?? null,
        }, null, 2));
    }
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
    await knownGoodControl();
    console.info(`KNOWN-GOOD CONTROL PASS: ${context.task.name}`);
    // The control Account owns the enrolled daemon. First-use Accounts have
    // no Machine grants, plugin admissions or saved themes.
    if (/^F[12] /.test(context.task.name)) await connectFreshAccount();
}, 0);

afterEach(async () => {
    try { await ui?.close(); } finally {
        ui = undefined;
        await daemon?.stop();
        daemon = undefined;
    }
});

afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => ui?.close(), () => daemon?.stop(), () => home?.stop(), () => server?.stop()]) {
        try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Themes composed cleanup failed');
});

function document(name: string, css?: string) {
    const base = ThemeProfileV1Schema.parse({ schemaVersion: 1, id: `theme_${randomUUID()}`, name,
        createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
        base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } });
    // The existing schema builds the released fields. New document fields use
    // Final Action contract v1 structurally, with no unlanded producer import.
    const profile = { ...base, seeds: { canvas: '#182028', accent: '#AABBCC' }, ...(css ? { css } : {}) };
    return { profile, raw: profile, compatibility: { status: 'supported' as const, unsupportedPaths: [] } };
}

async function dispatch(id: string, input: unknown, confirmed = false) {
    if (!ui) throw new Error('UI fixture not started');
    // The runtime front door accepts external Action ids; the catalog's TS
    // union intentionally does not contain the not-yet-implemented ids.
    return (confirmed ? ui.executeConfirmed : ui.execute)(id as Parameters<typeof ui.execute>[0], input,
        { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
}

async function action<T>(id: string, input: unknown, confirmed = false): Promise<T> {
    const result = await dispatch(id, input, confirmed);
    expect(result, `${id}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`${id} refused: ${result.errorCode}`);
    return result.result as T;
}
const theme = <T>(id: string, input: unknown, confirmed = false) => action<T>(`appearance.themes.${id}`, input, confirmed);
function artifactWrites() {
    return home!.entries().filter(row => /\/v1\/artifacts(?:\/|$)/.test(row.path)
        && row.path.split('?')[0] !== '/v1/artifacts/read'
        && ['POST', 'DELETE', 'PUT', 'PATCH'].includes(row.method));
}
function accountSettingsWrites() {
    return home!.entries().filter(row => /^\/v2\/account\/settings(?:\?|$)/.test(row.path)
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method));
}
function bodyReads() {
    return home!.entries().flatMap(row => {
        if (row.method === 'GET' && /^\/v1\/artifacts\/[^/?]+(?:\?|$)/.test(row.path)) return [row.path];
        if (row.method !== 'POST' || row.path.split('?')[0] !== '/v1/artifacts/read') return [];
        expect(row.body).toMatchObject({ complete: true, truncated: false });
        const batch = JSON.parse(row.body!.text) as { artifactIds: string[]; projection?: string };
        return batch.projection === 'headers' ? [] : batch.artifactIds;
    });
}

async function appState() {
    const storagePath = '../../../../apps/ui/sources/sync/domains/state/storage';
    const { storage } = await import(storagePath) as { storage: { getState(): {
        machines: Record<string, unknown>;
        settingsVersion: number | null;
        localSettings: { themeProfileSelection: { light: Ref | null; dark: Ref | null } | null };
    } } };
    return storage.getState();
}
const selection = async () => (await appState()).localSettings.themeProfileSelection?.dark ?? null;

async function connectAdditionalAppClients() {
    const socketPath = '../../../../apps/ui/sources/sync/api/session/apiSocket';
    const accountPath = '../../../../apps/ui/sources/sync/ops/actions/actionAccountContext';
    const reversePath = '../../../../apps/ui/sources/sync/ops/actions/clientActionReverseDispatch';
    const constantsPath = 'expo-constants';
    type AppSocket = {
        initialize(config: { endpoint: string; token: string; credentials: typeof uiCredentials; serverId: string;
            request(path: string, init?: RequestInit): Promise<Response>; isCurrent(): boolean }, encryption: unknown): void;
        registerMachineScopedRpcHandler(machineId: string, method: string, handler: unknown): () => void;
        getSocketId(): string; disconnect(): void;
    };
    const { apiSocket } = await import(socketPath) as { apiSocket: AppSocket };
    const { captureLazyActionAccountContext } = await import(accountPath) as {
        captureLazyActionAccountContext(serverId: string): Promise<{ accountId: string; dispose(): void;
            request(path: string, init?: RequestInit): Promise<Response>;
            resolveAccountEncryption(): Promise<{ encryption: { initializeMachines(keys: Map<string, null>): Promise<void> } }> }>;
    };
    const { createUiClientActionReverseHandler } = await import(reversePath) as {
        createUiClientActionReverseHandler(binding: { serverId: string; accountId: string; machineId: string; isCurrent(): boolean }):
            (raw: unknown, context?: { signal: AbortSignal }) => Promise<unknown>;
    };
    const { default: constants } = await import(constantsPath) as { default: { deviceName: string | null } };
    const account = await captureLazyActionAccountContext(ui!.serverId);
    const { encryption } = await account.resolveAccountEncryption();
    // The enrolled legacy Machine uses the Account secret, not a fabricated data key.
    await encryption.initializeMachines(new Map([[machineId, null]]));
    // Reuse the actual socket owner and its handshake, crypto and reverse handler;
    // instantiate it separately because the public app exports its single instance.
    const SocketOwner = apiSocket.constructor as new () => AppSocket;
    const sockets: AppSocket[] = [];
    const disposers: (() => void)[] = [];
    // This headless app has no mounted shell; register its real reverse owner
    // alongside the two additional Apps, so the unlabeled caller can answer.
    disposers.push(apiSocket.registerMachineScopedRpcHandler(machineId, RPC_METHODS.UI_ACTION_EXECUTE,
        createUiClientActionReverseHandler({ serverId: ui!.serverId, accountId: account.accountId,
            machineId, isCurrent: () => Boolean(apiSocket.getSocketId()) })));
    const previousName = constants.deviceName;
    const close = () => {
        for (const socket of sockets) socket.disconnect();
        for (const dispose of disposers) dispose();
        account.dispose();
        constants.deviceName = previousName;
    };
    try {
        for (const label of ['Studio\nLaptop', 'Pocket\tPhone']) {
            constants.deviceName = label;
            const socket = new SocketOwner();
            sockets.push(socket);
            const receive = createUiClientActionReverseHandler({ serverId: ui!.serverId, accountId: account.accountId,
                machineId, isCurrent: () => Boolean(socket.getSocketId()) });
            disposers.push(socket.registerMachineScopedRpcHandler(machineId, RPC_METHODS.UI_ACTION_EXECUTE,
                async (raw: unknown, context?: { signal: AbortSignal }) => {
                    // Network identity is the substituted boundary: these serial
                    // receivers share an app realm, but each has a real socket id.
                    // Keep the real reverse handler and Action executor beneath it.
                    const identity = vi.spyOn(apiSocket, 'getSocketId').mockImplementation(() => socket.getSocketId());
                    try { return await receive(raw, context); } finally { identity.mockRestore(); }
                }));
            socket.initialize({ endpoint: home!.baseUrl, token: uiCredentials.token,
                credentials: uiCredentials, serverId: ui!.serverId, request: account.request,
                isCurrent: () => true }, encryption);
            await waitFor(() => Boolean(socket.getSocketId()), { timeoutMs: 60_000 });
        }
        constants.deviceName = previousName;
        return { sockets, close };
    } catch (error) { close(); throw error; }
}

async function daemonAction(id: string, input: unknown) {
    const response = await daemonControlPostJson<unknown>({ port: daemon!.state.httpPort,
        controlToken: daemon!.state.controlToken, path: '/actions/root/execute',
        body: { actionId: `appearance.themes.${id}`, target: { kind: 'machine', machineId }, input } });
    expect(response.status).toBe(200);
    return response.data;
}

async function knownGoodControl() {
    const path = resolve(testDir, `control-${randomUUID()}.txt`);
    const content = `Themes composed control ${randomUUID()}`;
    await writeFile(path, content);
    // Established filesystem Action: real UI admission → Home/PG Machine
    // authority → encrypted daemon RPC → native disk read. No theme producer.
    const result = await ui!.executeConfirmed('daemon.filesystem.readFile', { rootPath: testDir, path },
        { surface: 'ui', authority: 'present_user', serverId: ui!.serverId,
            actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'machine', machineId } });
    expect(result, `CONTROL must pass before RED: ${JSON.stringify(result)}`)
        .toMatchObject({ ok: true, result: { success: true, content: Buffer.from(content).toString('base64') } });
}

async function connectFreshAccount() {
    await ui?.close();
    ui = undefined;
    const auth = await createTestAuth(home!.baseUrl);
    const account = { baseUrl: home!.baseUrl, token: auth.token, secret: auth.accountSigningSeed };
    uiCredentials = buildTestAccountCliAuthCredentials({ auth, mode: 'legacy' });
    readSettings = () => readEncryptedAccountSettingsV2(account);
    seedLegacySettings = () => upsertEncryptedAccountSettingsV2({ ...account,
        settings: { themeProfiles: [legacyProfile] } });
    ui = await connectUiActionClient({ serverUrl: home!.baseUrl, credentials: uiCredentials });
    await waitFor(() => ui!.isAccountReady(), { timeoutMs: 60_000 });
    expect(Object.keys((await appState()).machines)).toEqual([]);
}

async function firstKeep(name: string, draft = document(name)) {
    const initial = await theme<{ themes: Entry[] }>('list', {});
    expect(initial.themes.length).toBeGreaterThan(0);
    expect(initial.themes.every(entry => entry.reference.kind === 'built-in')).toBe(true);
    const builtin: Ref = { kind: 'built-in', presetId: 'premiumDark' };
    await theme('apply', { ref: builtin, mode: 'dark' });
    expect(await selection()).toEqual(builtin);
    home!.clear();
    const preview = await theme<Preview>('tryOn', { document: draft, mode: 'dark', origin: { kind: 'editor' } });
    expect(artifactWrites()).toHaveLength(0);
    const kept = await theme<Kept>('keep', { previewRef: preview.previewRef });
    expect(kept.entry.reference.kind).toBe('artifact');
    expect(await selection()).toEqual(kept.entry.reference);
    expect(artifactWrites().filter(row => row.method === 'POST' && row.path === '/v1/artifacts')).toHaveLength(1);
    return kept;
}

async function rejectSecondArtifactInsert() {
    // PostgreSQL is the genuine persistence boundary. A nontransactional
    // sequence rejects one face exactly once, so explicit retry can recover.
    const requireServer = createRequire(resolve(repoRootDir(), 'apps/server/package.json'));
    type Database = { $executeRawUnsafe(sql: string): Promise<unknown>; $disconnect(): Promise<void> };
    const { PrismaClient } = requireServer('@prisma/client') as {
        PrismaClient: new (options: { datasources: { db: { url: string } } }) => Database;
    };
    const database = new PrismaClient({ datasources: { db: { url: process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL! } } });
    const name = `themes_${randomUUID().replaceAll('-', '')}`;
    const close = async () => {
        try {
            await database.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "Artifact"`);
            await database.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
            await database.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${name}`);
        } finally { await database.$disconnect(); }
    };
    try {
        await database.$executeRawUnsafe(`CREATE SEQUENCE ${name}`);
        await database.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF nextval('${name}') = 2 THEN RAISE EXCEPTION 'composed face write failure'; END IF;
            RETURN NEW; END $$`);
        await database.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "Artifact" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        return close;
    } catch (error) { await close(); throw error; }
}

async function enrollPlatformCredentials() {
    // Platform fixtures select distinct web/native storage backends. Keep the
    // same Account enrolled through the real credential writer in either one.
    const tokenPath = '../../../../apps/ui/sources/auth/storage/tokenStorage';
    const { TokenStorage } = await import(tokenPath) as { TokenStorage: {
        setCredentialsForServerUrl(url: string, options: { serverId: string }, credentials: typeof uiCredentials): Promise<boolean>;
    } };
    expect(await TokenStorage.setCredentialsForServerUrl(home!.baseUrl, { serverId: ui!.serverId }, uiCredentials)).toBe(true);
}

async function mountThemeRuntime(platform: 'web' | 'ios') {
    // Import through the composed runner's app-aware resolver without making
    // the CLI-oriented test compiler reinterpret the UI's @/* imports.
    const runtimePath = '../../../../apps/ui/sources/theme/ThemeProfileRuntimeSync';
    const renderPath = '../../../../apps/ui/sources/dev/testkit/render/renderScreen';
    const storagePath = '../../../../apps/ui/sources/sync/domains/state/storage';
    const nativePath = 'react-native';
    const unistylesPath = 'react-native-unistyles';
    const reactPath = 'react';
    const runtime = await import(runtimePath) as { ThemeProfileRuntimeSync: unknown };
    const renderer = await import(renderPath) as { renderScreen(element: unknown): Promise<{ unmount(): Promise<void> }> };
    const { createElement } = await import(reactPath) as { createElement(component: unknown): unknown };
    const { Platform } = await import(nativePath) as { Platform: { OS: string } };
    type RuntimeTheme = { colors: { background: { canvas: string } } };
    const { UnistylesRuntime } = await import(unistylesPath) as { UnistylesRuntime: {
        getTheme(mode: 'light' | 'dark'): RuntimeTheme;
        updateTheme(mode: 'light' | 'dark', update: (previous: RuntimeTheme) => RuntimeTheme): void;
    } };
    const { storage } = await import(storagePath) as { storage: { getState(): {
        localSettings: { uiFontScale: number }; applyLocalSettings(input: { uiFontScale: number }): void;
    } } };
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    // Unistyles is the native system boundary. Keep its registered values as
    // real update callbacks produce them, rather than the default inert mock.
    const registered = { light: UnistylesRuntime.getTheme('light'), dark: UnistylesRuntime.getTheme('dark') };
    const reads = vi.spyOn(UnistylesRuntime, 'getTheme').mockImplementation(mode => registered[mode]);
    const updates = vi.spyOn(UnistylesRuntime, 'updateTheme').mockImplementation((mode, update) => {
        registered[mode] = update(registered[mode]);
    });
    let mounted: Awaited<ReturnType<typeof renderer.renderScreen>> | undefined;
    try {
        await enrollPlatformCredentials();
        mounted = await renderer.renderScreen(createElement(runtime.ThemeProfileRuntimeSync));
        updates.mockClear();
    } catch (error) {
        updates.mockRestore();
        reads.mockRestore();
        if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
        throw error;
    }
    return {
        updates,
        readCanvas: (mode: 'light' | 'dark') => registered[mode].colors.background.canvas,
        writeUnrelatedSetting: () => {
            const state = storage.getState();
            state.applyLocalSettings({ uiFontScale: state.localSettings.uiFontScale === 1 ? 1.1 : 1 });
        },
        close: async () => {
            try { await mounted?.unmount(); } finally {
                updates.mockRestore();
                reads.mockRestore();
                if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
            }
        },
    };
}

export async function runF1() {
    await firstKeep('First ever theme');
    const baseline = await theme<{ entry: Entry; document: unknown; guide: string }>('get', {
        ref: { kind: 'built-in', presetId: 'premiumDark' }, include: ['document', 'guide'] });
    expect(baseline.document).toBeDefined();
    expect(baseline.guide).toEqual(expect.any(String));
    const sibling = await theme<Kept>('save', { document: document('Sibling') });
    const previousSelection = await selection();
    home!.clear();
    const draft = document('Agent draft');
    const first = await theme<Preview>('tryOn', { document: draft, mode: 'dark', origin: { kind: 'agent' }, group: 'options' });
    await theme('revert', { previewRef: first.previewRef });
    expect(artifactWrites()).toHaveLength(0);
    expect(accountSettingsWrites()).toHaveLength(0);
    expect(await dispatch('appearance.themes.keep', { previewRef: first.previewRef }))
        .toMatchObject({ ok: false, errorCode: 'theme_preview_stale' });
    const second = await theme<Preview>('tryOn', { document: draft, mode: 'dark', origin: { kind: 'agent' } });
    const kept = await theme<Kept>('keep', { previewRef: second.previewRef });
    expect(await selection()).toEqual(kept.entry.reference);
    expect(artifactWrites().filter(row => row.method === 'POST' && row.path === '/v1/artifacts')).toHaveLength(1);
    await theme('undo', { undoHandle: kept.undoHandle });
    expect(await selection()).toEqual(previousSelection);
    expect(kept.entry.reference.kind).toBe('artifact');
    expect(artifactWrites().filter(row => row.method === 'DELETE').map(row => row.path.split('?')[0].split('/')[3]))
        .toEqual([(kept.entry.reference as { kind: 'artifact'; id: string }).id]);
    expect(await dispatch('appearance.themes.undo', { undoHandle: kept.undoHandle }))
        .toMatchObject({ ok: false, errorCode: 'theme_undo_handle_unknown' });
    expect(await dispatch('appearance.themes.undo', { undoHandle: 'foreign-client-handle' }))
        .toMatchObject({ ok: false, errorCode: 'theme_undo_handle_unknown' });
    await theme('get', { ref: sibling.entry.reference, include: ['document'] });
    const persistedDeleted = await fetch(`${home!.baseUrl}/v1/artifacts/${(kept.entry.reference as { kind: 'artifact'; id: string }).id}`, {
        headers: { Authorization: `Bearer ${uiCredentials.token}` },
    });
    expect(persistedDeleted.status).toBe(404);
    const deleted = await dispatch('appearance.themes.get', { ref: kept.entry.reference });
    expect(deleted, JSON.stringify(deleted))
        .toMatchObject({ ok: false, errorCode: 'theme_not_found' });
    const redo = await theme<Preview>('tryOn', { document: draft, mode: 'dark', origin: { kind: 'agent' } });
    await theme('keep', { previewRef: redo.previewRef });
    const beforeApply = await selection();
    home!.clear();
    const applied = await theme<Applied>('apply', { ref: sibling.entry.reference, mode: 'dark' });
    // A local apply may omit clientId; only a routed socket receipt requires it.
    expect(applied.applied).toMatchObject({ mode: 'dark' });
    expect(await selection()).toEqual(sibling.entry.reference);
    await theme('undo', { undoHandle: applied.undoHandle });
    expect(await selection()).toEqual(beforeApply);
    const base = await theme<Applied>('apply', { ref: null, mode: 'dark' });
    expect(base.applied).toMatchObject({ mode: 'dark' });
    expect(await selection()).toBeNull();
    await theme('undo', { undoHandle: base.undoHandle });
    expect(await selection()).toEqual(beforeApply);
    expect(artifactWrites()).toHaveLength(0);
    expect(accountSettingsWrites()).toHaveLength(0);
    // Ask must settle before the destructive effect; explicit user confirmation
    // is tested separately from the unconfirmed ingress.
    const refused = await daemonAction('delete', { ref: sibling.entry.reference });
    expect(refused).toMatchObject({ ok: true, result: { kind: 'approval_request_created',
        actionId: 'appearance.themes.delete', artifactId: expect.any(String) } });
    await theme('get', { ref: sibling.entry.reference });
}

export async function runF2() {
    const retained = { futureTheme: { layers: [{ opacity: 0.375, tags: ['grain', 'paper'] }], enabled: true } };
    const draft = document('Editor');
    const saved = await firstKeep('Editor', { ...draft, raw: { ...draft.raw, ...retained } });
    // Released migration data is a later state, never a first-use prerequisite.
    const releasedSettingsVersion = await seedLegacySettings();
    await ui!.close();
    ui = await connectUiActionClient({ serverUrl: home!.baseUrl, credentials: uiCredentials });
    await waitFor(() => ui!.isAccountReady(), { timeoutMs: 60_000 });
    // Shell readiness may precede Settings recovery. Observe the seeded input
    // reaching Sync before asserting its library projection.
    await waitFor(async () => ((await appState()).settingsVersion ?? -1) >= releasedSettingsVersion,
        { timeoutMs: 60_000 });
    const migrated = await theme<{ themes: Entry[] }>('list', {});
    const released = migrated.themes.find(entry => entry.name === legacyProfile.name);
    expect(released?.reference).toMatchObject({ kind: 'artifact' });
    const reopened = await theme<{ themes: Entry[] }>('list', {});
    expect(reopened.themes.find(entry => entry.name === legacyProfile.name)?.reference).toEqual(released?.reference);
    expect((await readSettings()).settings.themeProfiles).toEqual([]);
    // P09: the body-read budget follows opened records, not the 40+ library.
    for (let index = 0; index < 40; index += 1) {
        await theme('save', { document: document(`Inventory ${index}`,
            `[data-surface="sidebar"] { border-radius: ${index % 3 + 10}px; }`) });
    }
    // A selected uncached document is a legitimate body demand. Keep the cold
    // header-list measurement free of that separate selected-theme demand.
    await theme('apply', { ref: { kind: 'built-in', presetId: 'premiumDark' }, mode: 'dark' });
    // A new app connection has not opened this document. Header discovery must
    // not eagerly hydrate it, even though the previous client saved it.
    await ui!.close();
    home!.clear();
    ui = await connectUiActionClient({ serverUrl: home!.baseUrl, credentials: uiCredentials });
    await waitFor(() => ui!.isAccountReady(), { timeoutMs: 60_000 });
    const coldList = await theme<{ themes: Entry[] }>('list', {});
    expect(coldList.themes.filter(entry => entry.reference.kind === 'artifact').length).toBeGreaterThanOrEqual(41);
    expect(coldList.themes.find(entry => entry.name === legacyProfile.name)?.reference).toEqual(released?.reference);
    expect(bodyReads()).toHaveLength(0);
    type RetainedDocument = { raw: typeof retained };
    const opened = await theme<{ document: RetainedDocument }>('get', { ref: saved.entry.reference, include: ['document'] });
    expect(opened.document).toBeDefined();
    expect(opened.document.raw.futureTheme).toEqual(retained.futureTheme);
    expect(bodyReads()).toHaveLength(1);
    home!.clear();
    await theme('save', { document: opened.document, ref: saved.entry.reference });
    expect(artifactWrites()).toHaveLength(0);
    expect(accountSettingsWrites()).toHaveLength(0);
    const copy = await theme<{ entry: Entry }>('duplicate', { ref: saved.entry.reference });
    expect(copy.entry.reference).not.toEqual(saved.entry.reference);
    const exported = await theme<{ file: { name: string; text: string } }>('export', { ref: saved.entry.reference });
    expect(JSON.parse(exported.file.text).profile.futureTheme).toEqual(opened.document.raw.futureTheme);
    const imported = await theme<{ entry: Entry }>('import', { file: exported.file });
    const importedRead = await theme<{ document: RetainedDocument }>('get', { ref: imported.entry.reference, include: ['document'] });
    expect(importedRead.document.raw.futureTheme).toEqual(opened.document.raw.futureTheme);
    expect(await dispatch('appearance.themes.save', { ref: { kind: 'built-in', presetId: 'premiumDark' },
        document: document('Forbidden edit') })).toMatchObject({ ok: false, errorCode: 'theme_immutable_source' });
    expect(await dispatch('appearance.themes.import', { file: { name: 'broken.json', text: '{' } }))
        .toMatchObject({ ok: false, errorCode: 'theme_document_invalid' });
}

export async function runF3() {
    await theme('list', {}); // Intended missing-Action RED precedes optional fixture work.
    // Before the headless shell registers a receiver, discovery must expose
    // the typed unavailable result rather than throwing in RPC error mapping.
    expect(await dispatch('appearance.themes.list', { includeDevices: true }))
        .toMatchObject({ ok: false, errorCode: 'client_not_connected' });
    console.info('THEMES F3: no receiver returns typed unavailable');
    const clients = await connectAdditionalAppClients();
    try {
        type Candidate = { id: string; deviceLabel: string | null };
        const listed = await theme<{ devices: Candidate[] }>('list', { includeDevices: true });
        expect(listed.devices).toHaveLength(3);
        expect(new Set(listed.devices.map(client => client.id)).size).toBe(3);
        const labels = listed.devices.map(client => client.deviceLabel ?? null);
        expect(labels.filter(label => label !== null)).toHaveLength(2);
        expect(labels).toContain(null);
        expect(labels.filter((label): label is string => label !== null).map(label => label.replace(/\s/g, '')).sort())
            .toEqual(['PocketPhone', 'StudioLaptop']);
        for (const label of labels) expect(label ?? '').not.toMatch(/[\u0000-\u001f\u007f]/);
        const saved = await theme<Kept>('save', { document: document('Devices') });
        home!.clear();
        const ambiguous = await daemonAction('apply', { ref: saved.entry.reference, mode: 'dark' });
        expect(ambiguous).toMatchObject({ ok: false, errorCode: 'client_ambiguous',
            details: { clients: expect.arrayContaining(listed.devices.map(client => expect.objectContaining(client))) } });
        for (const client of listed.devices) {
            expect(await daemonAction('apply', { ref: saved.entry.reference, mode: 'dark', clientId: client.id }))
                .toMatchObject({ ok: true, result: { applied: { clientId: client.id, mode: 'dark' } } });
            const fromApp = await theme<Applied>('apply', {
                ref: saved.entry.reference, mode: 'dark', clientId: client.id });
            expect(fromApp.applied).toEqual({ clientId: client.id, mode: 'dark' });
            expect(await daemonAction('apply', { ref: null, mode: 'dark', clientId: client.id }))
                .toMatchObject({ ok: true, result: { applied: { clientId: client.id, mode: 'dark' } } });
        }
        // Disconnect the exact offered target after choice; it must not silently
        // route to another connected app or return success for a queued request.
        const disconnectedId = clients.sockets[0].getSocketId();
        clients.sockets[0].disconnect();
        await waitFor(async () => !(await theme<{ devices: Candidate[] }>('list', { includeDevices: true }))
            .devices.some(client => client.id === disconnectedId), { timeoutMs: 60_000 });
        expect(await daemonAction('apply', { ref: saved.entry.reference, mode: 'dark', clientId: disconnectedId }))
            .toMatchObject({ ok: false, errorCode: 'client_not_connected' });
        expect(artifactWrites()).toHaveLength(0);
    } finally { clients.close(); }
}

export async function runF4() {
    const css = '[data-surface="sidebar"] { border-radius: 12px; }';
    home!.clear();
    const preview = await theme<Preview>('tryOn', { document: document('CSS', css), mode: 'dark', origin: { kind: 'editor' } });
    expect(preview.coverage).toMatchObject({ total: 1, native: 1, webOnly: 0, hides: [] });
    expect(artifactWrites()).toHaveLength(0);
    const kept = await theme<Kept>('keep', { previewRef: preview.previewRef });
    const read = await theme<{ document: { raw: { css: string } } }>('get', { ref: kept.entry.reference, include: ['document', 'coverage'] });
    expect(read.document.raw.css).toBe(css);
    // The native table is reached by tryOn's coverage above. The web slot needs
    // a browser CSSOM; JSDOM cannot establish attachment or network silence.
    const { chromium } = await import('@playwright/test');
    const requireUi = createRequire(resolve(repoRootDir(), 'apps/ui/package.json'));
    const { build } = requireUi('esbuild') as { build(options: { entryPoints: string[]; bundle: boolean;
        write: boolean; format: string; globalName: string; platform: string }): Promise<{ outputFiles: { text: string }[] }> };
    const bundle = await build({ entryPoints: [resolve(repoRootDir(), 'apps/ui/sources/theme/css/themeStylesheet.web.ts')],
        bundle: true, write: false, format: 'iife', globalName: 'themeSheet', platform: 'browser' });
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const requests: string[] = [];
        page.on('request', request => requests.push(request.url()));
        await page.route('**/*', route => route.abort());
        await page.setContent('<html><head></head><body><div data-surface="sidebar" data-part="root"></div></body></html>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const attached = await page.evaluate(async (source) => {
            const { themeSheet } = globalThis as unknown as { themeSheet: {
                applyThemeStylesheet(input: { source: string } | null, mode: 'dark'): { available: boolean };
            } };
            const first = themeSheet.applyThemeStylesheet({ source }, 'dark');
            const element = globalThis.document.querySelector('[data-surface]')!;
            const radius = getComputedStyle(element).borderRadius;
            const count = globalThis.document.adoptedStyleSheets.length;
            themeSheet.applyThemeStylesheet({ source: source.replace('12px', '14px') }, 'dark');
            const replacement = getComputedStyle(element).borderRadius;
            const replacementCount = globalThis.document.adoptedStyleSheets.length;
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            themeSheet.applyThemeStylesheet(null, 'dark');
            return { available: first.available, radius, count, replacement, replacementCount,
                cleared: globalThis.document.adoptedStyleSheets.length };
        }, read.document.raw.css);
        expect(attached).toEqual({ available: true, radius: '12px', count: 1,
            replacement: '14px', replacementCount: 1, cleared: 0 });
        expect(requests).toEqual([]);
    } finally { await browser.close(); }
    // The owner ruling accepts one deliberate native repaint, never a
    // zero-app-wide-render guarantee. This headless host mounts only runtime
    // sync, not the app shell: these counts measure updateTheme calls only,
    // and do not claim app-wide React Profiler commits.
    for (const platform of ['web', 'ios'] as const) {
        const runtime = await mountThemeRuntime(platform);
        console.info(`THEMES F4: mounted ${platform} with Account custody`);
        try {
            const actPath = 'react-test-renderer';
            const { act } = await import(actPath) as { act(callback: () => Promise<void>): Promise<void> };
            let changed: Preview | undefined;
            await act(async () => {
                changed = await theme<Preview>('tryOn', { document: document(`CSS ${platform}`,
                    '[data-surface="sidebar"] { border-radius: 14px; }'), mode: 'dark', origin: { kind: 'editor' } });
            });
            expect(runtime.updates).toHaveBeenCalledTimes(platform === 'web' ? 0 : 1);
            runtime.updates.mockClear();
            // A settled React turn, without advancing or inventing a timer.
            await act(async () => {});
            expect(runtime.updates).toHaveBeenCalledTimes(0);
            await act(async () => { runtime.writeUnrelatedSetting(); });
            expect(runtime.updates).toHaveBeenCalledTimes(0);
            await act(async () => { await theme('revert', { previewRef: changed!.previewRef }); });
            expect(runtime.updates).toHaveBeenCalledTimes(platform === 'web' ? 0 : 1);
        } finally { await runtime.close(); }
    }
}

export async function runF5() {
    const nativePath = 'react-native';
    const { Platform } = await import(nativePath) as { Platform: { OS: string } };
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const requests: string[] = [];
    const acquisitionReads = () => ({
        detail: requests.filter(path => /^\/api\/fixture\/palette\/(?:1\.0\.0|latest)$/.test(path)).length,
        manifest: requests.filter(path => path.endsWith('/package.json')).length,
        package: requests.filter(path => path.endsWith('.vsix')).length,
    });
    const expectOneAcquisition = (before: ReturnType<typeof acquisitionReads>) => {
        expect(acquisitionReads()).toEqual({
            detail: before.detail + 1, manifest: before.manifest + 1, package: before.package + 1,
        });
    };
    // Scale the recorded search shape at the external boundary. Only the
    // selected first listing's recorded package/detail endpoints may be read.
    const largeSearch = { ...openVsx.search, totalSize: 120,
        extensions: Array.from({ length: 120 }, (_, index) => index === 0 ? openVsx.search.extensions[0] : {
            ...openVsx.search.extensions[0], name: `palette-${index}`, displayName: `Palette ${index}`,
            url: `https://open-vsx.org/api/fixture/palette-${index}/1.0.0`,
        }) };
    let latestVersion = openVsx.detail.version;
    const realFetch = globalThis.fetch;
    // Only Open VSX is substituted. Home, PostgreSQL, daemon and Action
    // dispatch stay real. Do not record headers or Account content.
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'open-vsx.org') return realFetch(input, init);
        requests.push(url.pathname);
        if (url.pathname === '/api/-/search') return Response.json(largeSearch);
        if (url.pathname.endsWith('.vsix')) return new Response(Buffer.from(openVsx.packageBase64, 'base64'));
        if (url.pathname.endsWith('.sha256')) return new Response(openVsx.sha256);
        if (url.pathname.endsWith('/package.json')) return Response.json(openVsx.manifest);
        if (/^\/api\/fixture\/palette\/(?:1\.0\.0|latest)$/.test(url.pathname)) {
            return Response.json({ ...openVsx.detail,
                version: url.pathname.endsWith('/latest') ? latestVersion : openVsx.detail.version });
        }
        throw new Error(`Unrecorded Open VSX request: ${url.pathname}`);
    });
    try {
    await enrollPlatformCredentials();
    const listed = await action<{ pages: { sourceId: string; items: ListingKey[] }[] }>('registries.items.list', { kind: 'theme', query: 'palette' });
    expect(listed.pages.flatMap(page => page.items)).toHaveLength(largeSearch.extensions.length);
    const item = listed.pages.flatMap(page => page.items).find(item => item.itemId.includes('palette'));
    expect(item).toBeDefined();
    if (!item) throw new Error('Recorded theme is missing from registry browse');
    const listing = { sourceId: item.sourceId, itemId: item.itemId };
    expect(requests.filter(path => path === '/api/-/search')).toHaveLength(1);
    expect(acquisitionReads()).toEqual({ detail: 0, manifest: 0, package: 0 });
    const acquired = await theme<{ faces: ReturnType<typeof document>[] }>('store.get', { listing });
    expect(acquired.faces).toHaveLength(2);
    expect(acquisitionReads()).toEqual({ detail: 1, manifest: 1, package: 1 });
    expect(requests.filter(path => path.endsWith('.sha256'))).toHaveLength(1);
    const preview = await theme<Preview>('tryOn', { document: acquired.faces[0], mode: 'dark', origin: { kind: 'store', listing } });
    await theme('revert', { previewRef: preview.previewRef });
    home!.clear();
    const releaseFailure = await rejectSecondArtifactInsert();
    try {
        const before = acquisitionReads();
        const partial = await dispatch('appearance.themes.install', { listing });
        expect(partial).toMatchObject({ ok: false, errorCode: 'theme_install_partial', details: { faces: [
            { faceId: expect.any(String), status: 'saved', entry: expect.any(Object) },
            { faceId: expect.any(String), status: 'failed', error: { code: expect.any(String) } },
        ] } });
        expectOneAcquisition(before);
        expect(artifactWrites().filter(row => row.method === 'POST' && row.path === '/v1/artifacts'
            && row.statusCode !== null && row.statusCode >= 200 && row.statusCode < 300)).toHaveLength(1);
    } finally { await releaseFailure(); }
    home!.clear();
    const beforeRetry = acquisitionReads();
    const installed = await theme<{ faces: { faceId: string; status: string; entry?: Entry }[] }>('install', { listing });
    expect(installed.faces.every(face => face.status === 'saved')).toBe(true);
    expectOneAcquisition(beforeRetry);
    // Completed faces are unchanged on retry: only the failed face is created.
    expect(artifactWrites().filter(row => row.method === 'POST' && row.path === '/v1/artifacts')).toHaveLength(1);
    for (const face of installed.faces) {
        expect(face.entry?.source?.kind).toBe('store');
        const provenance = RegistryProvenanceV1Schema.parse(face.entry?.source?.provenance);
        expect(provenance).toMatchObject(listing);
    }
    const inspected = await theme<Preview>('tryOn', {
        document: acquired.faces[0], mode: 'dark', origin: { kind: 'store', listing },
    });
    home!.clear();
    const beforeKeep = requests.length;
    await theme('keep', { previewRef: inspected.previewRef });
    expect(requests).toHaveLength(beforeKeep);
    expect(artifactWrites()).toHaveLength(0);
    latestVersion = '2.0.0';
    const keys = installed.faces.map(face => {
        expect(face.entry!.reference.kind).toBe('artifact');
        return (face.entry!.reference as { kind: 'artifact'; id: string }).id;
    });
    const changed = await action<RegistryUpdateCheckResultV1>('registries.updates.check', { kind: 'theme', keys });
    expect(changed.results.map(result => ({ kind: result.kind, key: result.key, upstream: result.upstream }))
        .sort((left, right) => left.key.localeCompare(right.key))).toEqual(keys.map(key => ({ kind: 'theme', key,
            upstream: { state: 'update_available', latest: { kind: 'version', version: latestVersion } },
        })).sort((left, right) => left.key.localeCompare(right.key)));
    home!.clear();
    await theme('uninstall', { listing }, true);
    expect(artifactWrites().filter(row => row.method === 'DELETE')).toHaveLength(acquired.faces.length);
    for (const face of installed.faces) {
        expect(await dispatch('appearance.themes.get', { ref: face.entry!.reference }))
            .toMatchObject({ ok: false, errorCode: 'theme_not_found' });
    }
    } finally {
        network.mockRestore();
        if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
    }
}

export async function runF6() {
    const { applyTrustedLocalPluginFixture, uninstallTrustedLocalPluginFixture } =
        await import('../../src/testkit/externalSessionLiveLifecycleFixture');
    // First Share has no reachable Machine; a typed unavailable result must
    // arrive at the app rather than a generic action_failed or false success.
    await connectFreshAccount();
    const offline = await firstKeep('Share without a Machine');
    home!.clear();
    expect(await dispatch('appearance.themes.sharePlugin', { refs: [offline.entry.reference],
        machineId: randomUUID(), path: resolve(testDir, 'unavailable-share') }, true))
        // Existing original-Account Machine acquisition uses this typed code
        // when the requested row is absent (externalActionAccountTransport).
        .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(artifactWrites()).toHaveLength(0);
    await ui!.close();
    uiCredentials = controlCredentials;
    ui = await connectUiActionClient({ serverUrl: home!.baseUrl, credentials: uiCredentials });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
    await theme('list', {});
    const pluginId = 'org.example.theme-composed';
    const pluginRoot = resolve(testDir, 'contributed-theme');
    await mkdir(resolve(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(resolve(pluginRoot, 'package.json'), JSON.stringify({ name: pluginId, version: '1.0.0', private: true, type: 'module' }));
    await writeFile(resolve(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify({ schemaVersion: 2,
        id: pluginId, version: '1.0.0', displayName: 'Contributed theme', engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 }, contributes: { themes: [{ id: 'paper', theme: document('Plugin paper').profile }] } }));
    home!.clear();
    await applyTrustedLocalPluginFixture({ daemonPort: daemon!.state.httpPort, controlToken: daemon!.state.controlToken,
        pluginRoot, pluginId, interactionId: 'themes-composed-install' });
    const ref: Ref = { kind: 'plugin', pluginId, contributionId: 'paper' };
    await waitFor(async () => (await theme<{ themes: Entry[] }>('list', {})).themes.some(entry =>
        entry.reference.kind === 'plugin' && entry.reference.pluginId === pluginId), { timeoutMs: 60_000 });
    const runtime = await mountThemeRuntime('web');
    try {
        const actPath = 'react-test-renderer';
        const { act } = await import(actPath) as { act(callback: () => Promise<void>): Promise<void> };
        const baseCanvas = runtime.readCanvas('dark');
        await act(async () => { await theme('apply', { ref, mode: 'dark' }); });
        await waitFor(() => runtime.readCanvas('dark') === '#182028', { timeoutMs: 60_000 });
        expect(baseCanvas).not.toBe('#182028');
        const selectedPlugin = await selection();
        expect(artifactWrites()).toHaveLength(0);
        home!.clear();
        await act(async () => {
            await uninstallTrustedLocalPluginFixture({ daemonPort: daemon!.state.httpPort,
                controlToken: daemon!.state.controlToken, pluginId });
            await waitFor(async () => !(await theme<{ themes: Entry[] }>('list', {})).themes.some(entry =>
                entry.reference.kind === 'plugin' && entry.reference.pluginId === pluginId), { timeoutMs: 60_000 });
        });
        await waitFor(() => runtime.readCanvas('dark') === baseCanvas, { timeoutMs: 60_000 });
        expect(await dispatch('appearance.themes.get', { ref })).toMatchObject({ ok: false, errorCode: 'theme_not_found' });
        // T11: the mounted runtime falls back without rewriting selection.
        expect(await selection()).toEqual(selectedPlugin);
        expect(accountSettingsWrites()).toHaveLength(0);
        expect(artifactWrites()).toHaveLength(0);
    } finally { await runtime.close(); }
    const saved = await theme<Kept>('save', { document: document('Shared') });
    const path = resolve(testDir, 'shared-theme-plugin');
    home!.clear();
    const shared = await theme<{ project: unknown; archive: string; digest: string }>('sharePlugin', {
        refs: [saved.entry.reference], machineId, path }, true);
    expect(shared.project).toBeDefined();
    expect((await stat(shared.archive)).size).toBeGreaterThan(0);
    const archiveBytes = await readFile(shared.archive);
    expect(shared.digest).toBe(`sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`);
    const requireCli = createRequire(resolve(repoRootDir(), 'apps/cli/package.json'));
    const tar = requireCli('tar') as { t(options: { file: string; onentry(entry: {
        path: string; on(event: 'data', listener: (chunk: Buffer) => void): void;
        on(event: 'end', listener: () => void): void;
    }): void }): Promise<void> };
    const packedFiles = new Map<string, string>();
    await tar.t({ file: shared.archive, onentry(entry) {
        const chunks: Buffer[] = [];
        entry.on('data', chunk => chunks.push(chunk));
        entry.on('end', () => packedFiles.set(entry.path, Buffer.concat(chunks).toString('utf8')));
    } });
    const manifestText = packedFiles.get('package/.happier-plugin/plugin.json');
    expect(manifestText).toBeDefined();
    expect(JSON.parse(manifestText!)).toMatchObject({ contributes: { themes: [
        { theme: { name: 'Shared', seeds: { canvas: '#182028', accent: '#AABBCC' } } },
    ] } });
    expect(artifactWrites()).toHaveLength(0);
    expect(home!.entries().filter(row => /plugins.*(?:install|publish)/.test(row.path))).toHaveLength(0);
}
