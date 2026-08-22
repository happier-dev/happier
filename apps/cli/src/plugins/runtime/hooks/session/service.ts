import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
    SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
    SessionProviderTranscriptEventPayloadV1Schema,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { buildMissingJavaScriptRuntimeMessage } from '@/packagedRuntime/js/buildMissingJavaScriptRuntimeMessage';
import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';
import { logger } from '@/ui/logger';
import { isBun } from '@/utils/runtime';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import {
    startSessionHookServerWithPersistedPortTakeover,
    type PermissionHookPayload,
    type SessionHookPayload,
    type StatuslineHookPayload,
} from './server';

type AgentSessionHooksService = AgentSessionHostServices['sessionHooks'];
type HostSessionHookLifecycle =
    | Readonly<{ kind: 'runner' }>
    | Readonly<{ kind: 'session'; sessionId: string }>;
type HostSessionHookServerStartRequest =
    Parameters<AgentSessionHooksService['startServer']>[0]
    & Readonly<{
        providerId: string;
        sessionId: string;
        lifecycle?: HostSessionHookLifecycle;
    }>;
type HostSessionHookPluginDirCreateRequest =
    Parameters<AgentSessionHooksService['createPluginDir']>[0]
    & Readonly<{
        providerId: string;
        lifecycle?: HostSessionHookLifecycle;
    }>;
type HostSessionProviderTranscriptPublishRequest =
    Parameters<AgentSessionHooksService['publishProviderTranscript']>[0]
    & Readonly<{
        providerId: string;
        sessionId: string;
    }>;

export type HostSessionHooksOwner = Readonly<{
    startServer(
        request: HostSessionHookServerStartRequest,
    ): ReturnType<AgentSessionHooksService['startServer']>;
    resolveForwarderAssets(): ReturnType<AgentSessionHooksService['resolveForwarderAssets']>;
    createPluginDir(
        request: HostSessionHookPluginDirCreateRequest,
    ): ReturnType<AgentSessionHooksService['createPluginDir']>;
    disposePluginDir(pluginDir: string): ReturnType<AgentSessionHooksService['disposePluginDir']>;
    publishProviderTranscript(
        request: HostSessionProviderTranscriptPublishRequest,
    ): ReturnType<AgentSessionHooksService['publishProviderTranscript']>;
}>;

export type CreateSessionHooksServiceParams = Readonly<{
    happyHomeDir: string;
    addDisposable?: (disposable: { dispose(): Promise<void> | void }) => unknown;
    publishHostEvent?: (name: string, payload?: unknown) => Promise<void>;
    grantTranscriptFileFollowPath?: (request: SessionHookTranscriptFileFollowGrantRequest) => Promise<void>;
    hasCapability: (capability: string) => boolean;
}>;

export type SessionHookTranscriptFileFollowGrantRequest = Readonly<{
    providerId: string;
    sessionId: string;
    providerSessionId: string;
    eventName: string;
    transcriptPath: string;
    providerPayload: SessionHookPayload;
}>;

let pluginDirSequence = 0;
let secretDirSequence = 0;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SESSION_HOOKS_CAPABILITY = 'sessionHooks';

/**
 * `ctx.sessionHooks` denials reach plugin authors directly, so they ARE canonical
 * PluginErrors. Never assign `name` here - `isPluginError` recognizes the contract
 * by name+data, not by class identity.
 */
export class PluginSessionHooksError extends PluginError {
    constructor(message: string) {
        super({ code: 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED', message });
    }
}

function sanitizePathSegment(value: string, fallback: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

function sanitizeProviderId(providerId: string): string {
    return sanitizePathSegment(providerId, 'provider');
}

function shortStableDigest(...values: string[]): string {
    const digest = createHash('sha256')
        .update(values.join('\0'))
        .digest('hex')
        .slice(0, 16);
    return digest;
}

function resolveHookSessionsRoot(happyHomeDir: string): string {
    return join(
        happyHomeDir,
        resolveReleaseRingScopedBasename('session-hooks', configuration.publicReleaseRing),
    );
}

function resolveHookSessionScopeRoot(happyHomeDir: string, sessionId: string): string {
    return join(
        resolveHookSessionsRoot(happyHomeDir),
        `session-${sanitizePathSegment(sessionId, 'session')}-${shortStableDigest(sessionId)}`,
    );
}

function resolveHookSessionRoot(params: Readonly<{
    happyHomeDir: string;
    providerId: string;
    sessionId: string;
}>): string {
    return join(
        resolveHookSessionScopeRoot(params.happyHomeDir, params.sessionId),
        `${sanitizeProviderId(params.providerId)}-session-${sanitizePathSegment(params.sessionId, 'session')}-${shortStableDigest(params.providerId)}`,
    );
}

function resolveHookPluginDirPath(params: Readonly<{
    happyHomeDir: string;
    pluginsRoot: string;
    request: HostSessionHookPluginDirCreateRequest;
}>): string {
    const providerSegment = sanitizeProviderId(params.request.providerId);
    if (params.request.lifecycle?.kind === 'session') {
        return join(resolveHookSessionRoot({
            happyHomeDir: params.happyHomeDir,
            providerId: params.request.providerId,
            sessionId: params.request.lifecycle.sessionId,
        }), 'plugin');
    }
    return join(params.pluginsRoot, `${providerSegment}-${process.pid}-${pluginDirSequence++}`);
}

function shouldRetainHookPluginDir(request: HostSessionHookPluginDirCreateRequest): boolean {
    return request.lifecycle?.kind === 'session';
}

function resolveNodeExecutable(): string {
    const nodeExecutable = resolveJavaScriptRuntimeExecutable({ isBunRuntime: isBun() });
    if (!nodeExecutable) {
        throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('session hook forwarder'));
    }
    return nodeExecutable;
}

function resolveHookPluginsRoot(happyHomeDir: string): string {
    return join(
        happyHomeDir,
        'tmp',
        resolveReleaseRingScopedBasename('hook-plugins', configuration.publicReleaseRing),
    );
}

function resolveHookSecretsRoot(happyHomeDir: string): string {
    return join(
        happyHomeDir,
        'tmp',
        resolveReleaseRingScopedBasename('hook-secrets', configuration.publicReleaseRing),
    );
}

function resolvePluginFilePath(pluginDir: string, relativePath: string): string {
    const normalized = normalize(relativePath);
    if (
        !normalized
        || isAbsolute(normalized)
        || normalized === '..'
        || normalized.startsWith(`..${sep}`)
        || normalized.includes(`${sep}..${sep}`)
    ) {
        throw new Error(`Invalid session hook plugin file path: ${relativePath}`);
    }
    return join(pluginDir, normalized);
}

function toFileContents(file: HostSessionHookPluginDirCreateRequest['files'][number]): string {
    if (typeof file.contents === 'string') return file.contents;
    return `${JSON.stringify(file.json, null, 2)}\n`;
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readSessionHookEventName(data: SessionHookPayload): string {
    return readString(data.hook_event_name) ?? readString(data.hookEventName) ?? 'SessionStart';
}

function readSessionHookTranscriptPath(data: SessionHookPayload): string | null {
    return readString(data.transcript_path) ?? readString(data.transcriptPath);
}

async function applyPrivateMode(path: string, mode: number): Promise<void> {
    if (process.platform === 'win32') return;
    await chmod(path, mode);
}

async function createPrivateDirectory(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await applyPrivateMode(dirPath, PRIVATE_DIRECTORY_MODE);
}

async function createPrivateDirectoryTree(rootDir: string, targetDir: string): Promise<void> {
    await createPrivateDirectory(rootDir);
    if (!isCanonicalAbsolutePathInsideRoot(rootDir, targetDir)) {
        throw new Error('Session hook private directory escaped its owned root');
    }
    const relativePath = relative(rootDir, targetDir);
    let currentDir = rootDir;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
        currentDir = join(currentDir, segment);
        await createPrivateDirectory(currentDir);
    }
}

async function writePrivateFile(filePath: string, contents: string): Promise<void> {
    await writeFile(filePath, contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await applyPrivateMode(filePath, PRIVATE_FILE_MODE);
}

function assertSessionHooksCapability(params: CreateSessionHooksServiceParams): void {
    if (!params.hasCapability(SESSION_HOOKS_CAPABILITY)) {
        throw new PluginSessionHooksError(
            `ctx.sessionHooks requires the manifest-derived '${SESSION_HOOKS_CAPABILITY}' runtime capability`,
        );
    }
}

async function grantSessionHookTranscriptPath(params: Readonly<{
    service: CreateSessionHooksServiceParams;
    request: HostSessionHookServerStartRequest;
    providerSessionId: string;
    data: SessionHookPayload;
}>): Promise<void> {
    const grant = params.service.grantTranscriptFileFollowPath;
    if (!grant) return;
    if (!readString(params.request.sessionHookSecret)) return;
    const eventName = readSessionHookEventName(params.data);
    if (eventName !== 'SessionStart') return;
    const transcriptPath = readSessionHookTranscriptPath(params.data);
    if (!transcriptPath) return;
    await grant({
        providerId: params.request.providerId,
        sessionId: params.request.sessionId,
        providerSessionId: params.providerSessionId,
        eventName,
        transcriptPath,
        providerPayload: params.data,
    });
}

async function createHookSecretFiles(params: Readonly<{
    happyHomeDir: string;
    providerId: string;
    lifecycle?: HostSessionHookServerStartRequest['lifecycle'];
    sessionHookSecret?: string;
    permissionHookSecret?: string;
}>): Promise<Readonly<{
    secretDir: string | null;
    retained: boolean;
    sessionHookSecret?: string;
    permissionHookSecret?: string;
    sessionHookSecretFile?: string;
    permissionHookSecretFile?: string;
}>> {
    const sessionHookSecret = params.sessionHookSecret;
    const permissionHookSecret = params.permissionHookSecret;
    if (!sessionHookSecret && !permissionHookSecret) {
        return { secretDir: null, retained: false };
    }

    const retained = params.lifecycle?.kind === 'session';
    const secretsRoot = retained
        ? resolveHookSessionRoot({
            happyHomeDir: params.happyHomeDir,
            providerId: params.providerId,
            sessionId: params.lifecycle.sessionId,
        })
        : resolveHookSecretsRoot(params.happyHomeDir);
    const providerSegment = sanitizeProviderId(params.providerId);
    const secretDir = retained
        ? join(secretsRoot, 'secrets')
        : join(secretsRoot, `${providerSegment}-${process.pid}-${secretDirSequence++}`);
    await createPrivateDirectoryTree(secretsRoot, secretDir);

    const out: {
        secretDir: string | null;
        retained: boolean;
        sessionHookSecret?: string;
        permissionHookSecret?: string;
        sessionHookSecretFile?: string;
        permissionHookSecretFile?: string;
    } = { secretDir, retained };
    const resolveStableSecret = async (filePath: string, proposed: string): Promise<string> => {
        if (retained) {
            const existing = await readFile(filePath, 'utf8').catch(() => null);
            if (existing?.trim()) return existing.trim();
        }
        await writePrivateFile(filePath, proposed);
        return proposed;
    };
    try {
        if (sessionHookSecret) {
            out.sessionHookSecretFile = join(secretDir, 'session.secret');
            out.sessionHookSecret = await resolveStableSecret(out.sessionHookSecretFile, sessionHookSecret);
        }
        if (permissionHookSecret) {
            out.permissionHookSecretFile = join(secretDir, 'permission.secret');
            out.permissionHookSecret = await resolveStableSecret(out.permissionHookSecretFile, permissionHookSecret);
        }
    } catch (error) {
        if (!retained) await rm(secretDir, { recursive: true, force: true });
        throw error;
    }
    return out;
}

async function readSessionHookEndpointPort(sessionRoot: string): Promise<number | null> {
    try {
        const parsed = JSON.parse(await readFile(join(sessionRoot, 'endpoint.json'), 'utf8')) as Record<string, unknown>;
        const port = parsed.port;
        return parsed.v === 1
            && typeof port === 'number'
            && Number.isInteger(port)
            && port > 0
            && port <= 65_535
            ? port
            : null;
    } catch {
        return null;
    }
}

async function writeSessionHookEndpointPort(sessionRoot: string, port: number): Promise<void> {
    await writeJsonAtomic(join(sessionRoot, 'endpoint.json'), { v: 1, port });
}

function createOnceDisposable(dispose: () => Promise<void>): { dispose(): Promise<void> } {
    let disposed = false;
    return {
        async dispose() {
            if (disposed) return;
            disposed = true;
            await dispose();
        },
    };
}

async function disposeHookPluginDir(pluginDir: string): Promise<void> {
    await rm(pluginDir, { recursive: true, force: true });
}

export async function disposeSessionHookArtifactsForSession(params: Readonly<{
    happyHomeDir: string;
    sessionId: string;
}>): Promise<void> {
    await rm(resolveHookSessionScopeRoot(params.happyHomeDir, params.sessionId), {
        recursive: true,
        force: true,
    });
}

export function createSessionHooksService(
    params: CreateSessionHooksServiceParams,
): HostSessionHooksOwner {
    const activePluginDirs = new Set<string>();
    const disposedPluginDirs = new Set<string>();
    const retainedPluginDirs = new Set<string>();
    const pluginsRoot = resolveHookPluginsRoot(params.happyHomeDir);
    const sessionHooksRoot = resolveHookSessionsRoot(params.happyHomeDir);

    async function disposeRegisteredHookPluginDir(pluginDir: string): Promise<void> {
        const resolvedPluginDir = resolve(pluginDir);
        if (disposedPluginDirs.has(resolvedPluginDir)) return;
        if (
            (!isCanonicalAbsolutePathInsideRoot(pluginsRoot, resolvedPluginDir)
                && !isCanonicalAbsolutePathInsideRoot(sessionHooksRoot, resolvedPluginDir))
            || !activePluginDirs.has(resolvedPluginDir)
        ) {
            throw new Error(`Session hook plugin dir is not owned by this service: ${pluginDir}`);
        }
        activePluginDirs.delete(resolvedPluginDir);
        if (retainedPluginDirs.has(resolvedPluginDir)) {
            disposedPluginDirs.add(resolvedPluginDir);
            return;
        }
        try {
            await disposeHookPluginDir(resolvedPluginDir);
            disposedPluginDirs.add(resolvedPluginDir);
        } catch (error) {
            activePluginDirs.add(resolvedPluginDir);
            throw error;
        }
    }

    return Object.freeze({
        async startServer(request: HostSessionHookServerStartRequest) {
            assertSessionHooksCapability(params);
            if (request.lifecycle?.kind === 'session' && request.lifecycle.sessionId !== request.sessionId) {
                throw new Error('Session hook lifecycle sessionId must match the hook server sessionId');
            }
            const secretFiles = await createHookSecretFiles({
                happyHomeDir: params.happyHomeDir,
                providerId: request.providerId,
                lifecycle: request.lifecycle,
                sessionHookSecret: request.sessionHookSecret,
                permissionHookSecret: request.permissionHookSecret,
            });
            const sessionRoot = request.lifecycle?.kind === 'session'
                ? resolveHookSessionRoot({
                    happyHomeDir: params.happyHomeDir,
                    providerId: request.providerId,
                    sessionId: request.lifecycle.sessionId,
                })
                : null;
            const requestedPort = sessionRoot ? await readSessionHookEndpointPort(sessionRoot) : null;
            const serverState: {
                current: Awaited<ReturnType<typeof startSessionHookServerWithPersistedPortTakeover>> | null;
            } = { current: null };
            try {
                const serverOptions = {
                    session: {
                        providerId: request.providerId,
                        sessionId: request.sessionId,
                    },
                    onSessionHook: request.onSessionHook
                        ? async (providerSessionId: string, data: SessionHookPayload) => {
                            try {
                                await grantSessionHookTranscriptPath({
                                    service: params,
                                    request,
                                    providerSessionId,
                                    data,
                                });
                            } catch {
                                logger.debug('[sessionHookServer] Session hook transcript grant failed');
                            }
                            await request.onSessionHook?.(providerSessionId, data);
                        }
                        : undefined,
                    onPermissionHook: request.onPermissionHook
                        ? async (data: PermissionHookPayload) => await request.onPermissionHook?.(data)
                        : undefined,
                    onStatuslineUpdate: request.onStatuslineUpdate
                        ? async (data: StatuslineHookPayload) => await request.onStatuslineUpdate?.(data)
                        : undefined,
                    defaultPermissionHookResponse: request.defaultPermissionHookResponse
                        ? (data: PermissionHookPayload) => request.defaultPermissionHookResponse?.(data)
                        : undefined,
                    sessionHookSecret: secretFiles.sessionHookSecret,
                    permissionHookSecret: secretFiles.permissionHookSecret,
                    permissionRequestTimeoutMs: request.permissionRequestTimeoutMs,
                    permissionRequestTimeoutMsForTool: request.permissionRequestTimeoutMsForTool,
                    publishHostEvent: params.publishHostEvent,
                    ...(requestedPort ? { requestedPort } : {}),
                } as const;
                serverState.current =
                    await startSessionHookServerWithPersistedPortTakeover(
                        serverOptions,
                    );
                if (sessionRoot && requestedPort === null) {
                    await writeSessionHookEndpointPort(sessionRoot, serverState.current.port);
                }
            } catch (error) {
                if (serverState.current) {
                    serverState.current.stop();
                    await serverState.current.closed;
                }
                if (secretFiles.secretDir && !secretFiles.retained) {
                    await rm(secretFiles.secretDir, { recursive: true, force: true });
                }
                throw error;
            }
            const server = serverState.current;
            if (!server) {
                throw new Error('Session hook server failed to initialize');
            }
            const cleanup = createOnceDisposable(async () => {
                server.stop();
                await server.closed;
                if (secretFiles.secretDir && !secretFiles.retained) {
                    await rm(secretFiles.secretDir, { recursive: true, force: true });
                }
            });
            params.addDisposable?.(cleanup);
            return {
                ...server,
                ...(secretFiles.sessionHookSecretFile ? { sessionHookSecretFile: secretFiles.sessionHookSecretFile } : {}),
                ...(secretFiles.permissionHookSecretFile ? { permissionHookSecretFile: secretFiles.permissionHookSecretFile } : {}),
                dispose: cleanup.dispose,
            };
        },
        async resolveForwarderAssets() {
            assertSessionHooksCapability(params);
            return {
                nodeExecutable: resolveNodeExecutable(),
                sessionForwarderScript: resolveCliRuntimeAssetPath('scripts', 'session_hook_forwarder.cjs'),
                permissionForwarderScript: resolveCliRuntimeAssetPath('scripts', 'permission_hook_forwarder.cjs'),
                statuslineForwarderScript: resolveCliRuntimeAssetPath('scripts', 'statusline_forwarder.cjs'),
            };
        },
        async createPluginDir(request: HostSessionHookPluginDirCreateRequest) {
            assertSessionHooksCapability(params);
            const pluginDir = resolveHookPluginDirPath({
                happyHomeDir: params.happyHomeDir,
                pluginsRoot,
                request,
            });
            const resolvedPluginDir = resolve(pluginDir);
            const retainPluginDir = shouldRetainHookPluginDir(request);
            const replacementSuffix = `${process.pid}-${Date.now()}-${pluginDirSequence++}`;
            const writeRoot = retainPluginDir ? `${pluginDir}.staging-${replacementSuffix}` : pluginDir;
            const backupRoot = `${pluginDir}.backup-${replacementSuffix}`;
            const filesToWrite = request.files.map((file) => ({
                file,
                filePath: resolvePluginFilePath(writeRoot, file.path),
            }));

            try {
                for (const { file, filePath } of filesToWrite) {
                    await createPrivateDirectoryTree(
                        retainPluginDir ? sessionHooksRoot : pluginsRoot,
                        dirname(filePath),
                    );
                    await writePrivateFile(filePath, toFileContents(file));
                }
                if (retainPluginDir) {
                    let movedPrevious = false;
                    try {
                        await rename(pluginDir, backupRoot);
                        movedPrevious = true;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
                    }
                    try {
                        await rename(writeRoot, pluginDir);
                    } catch (error) {
                        if (movedPrevious) {
                            await rename(backupRoot, pluginDir).catch(() => {});
                        }
                        throw error;
                    }
                    if (movedPrevious) {
                        await rm(backupRoot, { recursive: true, force: true });
                    }
                }
            } catch (error) {
                if (retainPluginDir) {
                    await rm(writeRoot, { recursive: true, force: true });
                    await rm(backupRoot, { recursive: true, force: true });
                } else {
                    await disposeHookPluginDir(resolvedPluginDir);
                }
                throw error;
            }

            disposedPluginDirs.delete(resolvedPluginDir);
            if (retainPluginDir) {
                retainedPluginDirs.add(resolvedPluginDir);
            } else {
                retainedPluginDirs.delete(resolvedPluginDir);
            }
            activePluginDirs.add(resolvedPluginDir);
            params.addDisposable?.(createOnceDisposable(async () => await disposeRegisteredHookPluginDir(resolvedPluginDir)));

            return pluginDir;
        },
        async disposePluginDir(pluginDir: string) {
            assertSessionHooksCapability(params);
            await disposeRegisteredHookPluginDir(pluginDir);
        },
        async publishProviderTranscript(request: HostSessionProviderTranscriptPublishRequest) {
            assertSessionHooksCapability(params);
            const payload = SessionProviderTranscriptEventPayloadV1Schema.parse(request);
            await params.publishHostEvent?.(SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1, payload);
        },
    });
}
