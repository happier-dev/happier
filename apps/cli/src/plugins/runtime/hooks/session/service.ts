import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type {
    SessionHookPluginDirCreateRequestV1,
    SessionHooksRuntimeServiceV1,
    SessionHookServerStartRequestV1,
    SessionProviderTranscriptPublishRequestV1,
} from '@happier-dev/plugin-sdk';
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

import { publishHostPluginEvent } from '../../context/events';
import {
    startSessionHookServer,
    type PermissionHookPayload,
    type SessionHookPayload,
    type StatuslineHookPayload,
} from './server';

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
const SESSION_HOOKS_CONTROL_PERMISSION = 'session.hooks.control';

export class PluginSessionHooksError extends Error {
    readonly code: 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED';

    constructor(message: string) {
        super(message);
        this.name = 'PluginSessionHooksError';
        this.code = 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED';
    }
}

function sanitizePathSegment(value: string, fallback: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

function sanitizeProviderId(providerId: string): string {
    return sanitizePathSegment(providerId, 'provider');
}

function resolveHookPluginDirPath(params: Readonly<{
    pluginsRoot: string;
    request: SessionHookPluginDirCreateRequestV1;
}>): string {
    const providerSegment = sanitizeProviderId(params.request.providerId);
    if (params.request.lifecycle?.kind === 'session') {
        return join(
            params.pluginsRoot,
            `${providerSegment}-session-${sanitizePathSegment(params.request.lifecycle.sessionId, 'session')}`,
        );
    }
    return join(params.pluginsRoot, `${providerSegment}-${process.pid}-${pluginDirSequence++}`);
}

function shouldRetainHookPluginDir(request: SessionHookPluginDirCreateRequestV1): boolean {
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

function toFileContents(file: SessionHookPluginDirCreateRequestV1['files'][number]): string {
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
    const relativePath = targetDir.startsWith(`${rootDir}${sep}`)
        ? targetDir.slice(rootDir.length + 1)
        : '';
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

function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
    const relativePath = relative(resolve(rootDir), resolve(candidatePath));
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertSessionHooksCapability(params: CreateSessionHooksServiceParams): void {
    if (
        !params.hasCapability(SESSION_HOOKS_CAPABILITY)
        || !params.hasCapability(SESSION_HOOKS_CONTROL_PERMISSION)
    ) {
        throw new PluginSessionHooksError(
            `ctx.sessionHooks requires '${SESSION_HOOKS_CAPABILITY}' runtime capability and '${SESSION_HOOKS_CONTROL_PERMISSION}' permission`,
        );
    }
}

async function grantSessionHookTranscriptPath(params: Readonly<{
    service: CreateSessionHooksServiceParams;
    request: SessionHookServerStartRequestV1;
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
    sessionHookSecret?: string;
    permissionHookSecret?: string;
}>): Promise<Readonly<{
    secretDir: string | null;
    sessionHookSecretFile?: string;
    permissionHookSecretFile?: string;
}>> {
    const sessionHookSecret = params.sessionHookSecret;
    const permissionHookSecret = params.permissionHookSecret;
    if (!sessionHookSecret && !permissionHookSecret) {
        return { secretDir: null };
    }

    const secretsRoot = resolveHookSecretsRoot(params.happyHomeDir);
    const providerSegment = sanitizeProviderId(params.providerId);
    const secretDir = join(secretsRoot, `${providerSegment}-${process.pid}-${secretDirSequence++}`);
    await createPrivateDirectoryTree(secretsRoot, secretDir);

    const out: {
        secretDir: string | null;
        sessionHookSecretFile?: string;
        permissionHookSecretFile?: string;
    } = { secretDir };
    try {
        if (sessionHookSecret) {
            out.sessionHookSecretFile = join(secretDir, 'session.secret');
            await writePrivateFile(out.sessionHookSecretFile, sessionHookSecret);
        }
        if (permissionHookSecret) {
            out.permissionHookSecretFile = join(secretDir, 'permission.secret');
            await writePrivateFile(out.permissionHookSecretFile, permissionHookSecret);
        }
    } catch (error) {
        await rm(secretDir, { recursive: true, force: true });
        throw error;
    }
    return out;
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

export function createSessionHooksService(
    params: CreateSessionHooksServiceParams,
): SessionHooksRuntimeServiceV1 {
    const activePluginDirs = new Set<string>();
    const disposedPluginDirs = new Set<string>();
    const retainedPluginDirs = new Set<string>();
    const pluginsRoot = resolveHookPluginsRoot(params.happyHomeDir);

    async function disposeRegisteredHookPluginDir(pluginDir: string): Promise<void> {
        const resolvedPluginDir = resolve(pluginDir);
        if (disposedPluginDirs.has(resolvedPluginDir)) return;
        if (!isPathInsideRoot(pluginsRoot, resolvedPluginDir) || !activePluginDirs.has(resolvedPluginDir)) {
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
        async startServer(request: SessionHookServerStartRequestV1) {
            assertSessionHooksCapability(params);
            const secretFiles = await createHookSecretFiles({
                happyHomeDir: params.happyHomeDir,
                providerId: request.providerId,
                sessionHookSecret: request.sessionHookSecret,
                permissionHookSecret: request.permissionHookSecret,
            });
            let server: Awaited<ReturnType<typeof startSessionHookServer>>;
            try {
                server = await startSessionHookServer({
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
                            } catch (grantError) {
                                logger.debug('[sessionHookServer] Session hook transcript grant failed:', grantError);
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
                    sessionHookSecret: request.sessionHookSecret,
                    permissionHookSecret: request.permissionHookSecret,
                    permissionRequestTimeoutMs: request.permissionRequestTimeoutMs,
                    permissionRequestTimeoutMsForTool: request.permissionRequestTimeoutMsForTool,
                    publishHostEvent: params.publishHostEvent,
                });
            } catch (error) {
                if (secretFiles.secretDir) {
                    await rm(secretFiles.secretDir, { recursive: true, force: true });
                }
                throw error;
            }
            const cleanup = createOnceDisposable(async () => {
                server.stop();
                if (secretFiles.secretDir) {
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
        async createPluginDir(request: SessionHookPluginDirCreateRequestV1) {
            assertSessionHooksCapability(params);
            const pluginDir = resolveHookPluginDirPath({ pluginsRoot, request });
            const resolvedPluginDir = resolve(pluginDir);
            const retainPluginDir = shouldRetainHookPluginDir(request);
            const filesToWrite = request.files.map((file) => ({
                file,
                filePath: resolvePluginFilePath(pluginDir, file.path),
            }));

            try {
                for (const { file, filePath } of filesToWrite) {
                    await createPrivateDirectoryTree(pluginsRoot, dirname(filePath));
                    await writePrivateFile(filePath, toFileContents(file));
                }
            } catch (error) {
                if (!retainPluginDir) {
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
        async publishProviderTranscript(request: SessionProviderTranscriptPublishRequestV1) {
            assertSessionHooksCapability(params);
            const payload = SessionProviderTranscriptEventPayloadV1Schema.parse(request);
            await (params.publishHostEvent ?? publishHostPluginEvent)(
                SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
                payload,
            );
        },
    });
}
