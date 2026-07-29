import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AgentExternalSessionHookInstallationVariant,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { buildShellCommand } from '@happier-dev/agents/process/shellCommand';

import {
    removePrivateBearerFile,
    replacePrivateBearerFile,
    writePrivateBearerFile,
} from '@/daemon/privateBearerFile';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { buildMissingJavaScriptRuntimeMessage } from '@/packagedRuntime/js/buildMissingJavaScriptRuntimeMessage';
import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { isBun } from '@/utils/runtime';

import type {
    QualifiedExternalSessionHookDeliveryInput,
    QualifiedExternalSessionHookDeliveryResult,
    QualifiedExternalSessionHookPrincipalInput,
} from './qualifiedExternalSessionHookIngress';
import { startSessionHookServerWithPersistedPortTakeover } from './server';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ENDPOINT_JSON_MAX_BYTES = 4_096;
const CREDENTIAL_MAX_BYTES = 44;
const DEFAULT_HOOK_TIMEOUT_MS = 500;
const MAX_SAFE_HOOK_TIMEOUT_SECONDS = Number.MAX_SAFE_INTEGER;

class InvalidBoundedPrivateFileError extends Error {}
class InvalidQualifiedExternalSessionHookCredentialError extends Error {
    constructor() {
        super('Invalid qualified External Session hook credential');
    }
}

function hookEventJsonArraysTimeoutSeconds(timeoutMs: number | undefined): number {
    const declaredTimeoutMs = timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    if (!Number.isSafeInteger(declaredTimeoutMs) || declaredTimeoutMs < 1) {
        throw new TypeError(
            'Qualified External Session hook timeout must be a positive safe integer',
        );
    }
    return Math.min(
        MAX_SAFE_HOOK_TIMEOUT_SECONDS,
        Math.max(1, Math.ceil(declaredTimeoutMs / 1_000)),
    );
}

export type QualifiedExternalSessionHookTransportIngress = Readonly<{
    createPrincipal(
        input: QualifiedExternalSessionHookPrincipalInput,
    ): Readonly<{ principalRef: string; token: string }>;
    enable(principalRef: string): Readonly<{ state: string }>;
    disable(principalRef: string): Readonly<{ state: string }>;
    revoke(principalRef: string): Readonly<{ state: string }>;
    handleAuthenticatedEvent(
        input: QualifiedExternalSessionHookDeliveryInput,
    ): Promise<QualifiedExternalSessionHookDeliveryResult>;
}>;

type CredentialInput = Omit<
    QualifiedExternalSessionHookPrincipalInput,
    'principalRef' | 'token'
> & Readonly<{
    hostInstallationId: string;
    installationPrincipalRef?: string;
}>;

export type QualifiedExternalSessionHookCredential = Readonly<{
    installationPrincipalRef: string;
    eventPrincipalRef: string;
    eventId: string;
    secretFile: string;
}>;

export type QualifiedExternalSessionHookDurableCredentialIdentity = Readonly<{
    qualifiedContributionId: QualifiedExternalSessionHookPrincipalInput[
        'qualifiedContributionId'
    ];
    hostInstallationId: string;
    installationPrincipalRef: string;
    eventId: string;
}>;

export type QualifiedExternalSessionHookOwnedEntry = Readonly<{
    matcher: string | null;
    hooks: readonly Readonly<{
        type: 'command';
        command: string;
        timeout: number;
    }>[];
}>;

export type QualifiedExternalSessionHookListener = Readonly<{
    port: number;
    createOrReuseCredential(
        input: CredentialInput,
    ): Promise<QualifiedExternalSessionHookCredential>;
    restoreCredential(
        input: CredentialInput & Readonly<{
            installationPrincipalRef: string;
        }>,
    ): Promise<
        | Readonly<{
            state: 'restored';
            credential: QualifiedExternalSessionHookCredential;
        }>
        | Readonly<{
            state: 'unavailable';
            reason: 'missing' | 'corrupt';
        }>
    >;
    rotateCredential(
        input: CredentialInput,
    ): Promise<QualifiedExternalSessionHookCredential>;
    enable(eventPrincipalRef: string): Readonly<{ state: string }>;
    disable(eventPrincipalRef: string): Readonly<{ state: string }>;
    disableDurableCredential(
        input: QualifiedExternalSessionHookDurableCredentialIdentity,
    ): Readonly<{ state: string }>;
    revokeDurableCredential(
        input: QualifiedExternalSessionHookDurableCredentialIdentity,
    ): Promise<void>;
    buildOwnedEntry(input: Readonly<{
        credential: QualifiedExternalSessionHookCredential;
        event: AgentExternalSessionHookInstallationVariant['events'][number];
    }>): QualifiedExternalSessionHookOwnedEntry;
    buildOwnedEntryPreview(input: Readonly<{
        qualifiedContributionId: QualifiedExternalSessionHookPrincipalInput[
            'qualifiedContributionId'
        ];
        hostInstallationId: string;
        event: AgentExternalSessionHookInstallationVariant['events'][number];
    }>): QualifiedExternalSessionHookOwnedEntry;
    stop(): Promise<void>;
}>;

function stablePathSegment(value: string, fallback: string): string {
    const label = value
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        || fallback;
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
    return `${label}-${digest}`;
}

function eventPrincipalRef(
    installationPrincipalRef: string,
    eventId: string,
): string {
    const digest = createHash('sha256').update(eventId).digest('hex').slice(0, 24);
    return `${installationPrincipalRef}.${digest}`;
}

function resolveEndpointPath(activeServerDir: string): string {
    return join(
        activeServerDir,
        'external-sessions',
        'hook-ingress',
        'v1',
        'endpoint.json',
    );
}

function resolveCredentialFile(input: Readonly<{
    activeServerDir: string;
    qualifiedContributionId: QualifiedExternalSessionHookPrincipalInput[
        'qualifiedContributionId'
    ];
    hostInstallationId: string;
    eventId: string;
}>): string {
    return join(
        input.activeServerDir,
        'external-sessions',
        'hook-ingress',
        'v1',
        'credentials',
        stablePathSegment(
            `${input.qualifiedContributionId.pluginId}--${input.qualifiedContributionId.localId}`,
            'agent',
        ),
        stablePathSegment(input.hostInstallationId, 'installation'),
        `${stablePathSegment(input.eventId, 'event')}.secret`,
    );
}

export async function revokeQualifiedExternalSessionHookDurableCredential(
    input: QualifiedExternalSessionHookDurableCredentialIdentity & Readonly<{
        activeServerDir: string;
    }>,
): Promise<void> {
    await removePrivateBearerFile(resolveCredentialFile({
        activeServerDir: input.activeServerDir,
        qualifiedContributionId: input.qualifiedContributionId,
        hostInstallationId: input.hostInstallationId,
        eventId: input.eventId,
    }));
}

async function readBoundedPrivateFile(
    path: string,
    maxBytes: number,
): Promise<Buffer | null> {
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
        file = await open(path, 'r');
        const metadata = await file.stat();
        if (
            !metadata.isFile()
            || !Number.isSafeInteger(metadata.size)
            || metadata.size < 0
            || metadata.size > maxBytes
        ) {
            throw new InvalidBoundedPrivateFileError();
        }
        const contents = Buffer.alloc(metadata.size);
        let offset = 0;
        while (offset < contents.length) {
            const read = await file.read(
                contents,
                offset,
                contents.length - offset,
                offset,
            );
            if (read.bytesRead === 0) {
                throw new InvalidBoundedPrivateFileError();
            }
            offset += read.bytesRead;
        }
        const tail = Buffer.alloc(1);
        const afterBound = await file.read(tail, 0, 1, contents.length);
        if (afterBound.bytesRead !== 0) {
            throw new InvalidBoundedPrivateFileError();
        }
        return contents;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    } finally {
        await file?.close();
    }
}

async function readPersistedPort(path: string): Promise<number | null> {
    try {
        const contents = await readBoundedPrivateFile(
            path,
            ENDPOINT_JSON_MAX_BYTES,
        );
        if (!contents) return null;
        const parsed = JSON.parse(contents.toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        return record.v === 1
            && Number.isInteger(record.port)
            && Number(record.port) > 0
            && Number(record.port) <= 65_535
            ? Number(record.port)
            : null;
    } catch {
        return null;
    }
}

async function readCredential(path: string): Promise<string | null> {
    try {
        const contents = await readBoundedPrivateFile(
            path,
            CREDENTIAL_MAX_BYTES,
        );
        if (!contents) return null;
        const raw = contents.toString('utf8');
        const token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
        if (!TOKEN_PATTERN.test(token)) {
            throw new InvalidQualifiedExternalSessionHookCredentialError();
        }
        return token;
    } catch (error) {
        if (error instanceof InvalidBoundedPrivateFileError) {
            throw new InvalidQualifiedExternalSessionHookCredentialError();
        }
        throw error;
    }
}

async function createCredential(path: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    try {
        await writePrivateBearerFile({ path, contents: `${token}\n` });
        return token;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readCredential(path);
        if (!existing) {
            throw new Error(
                'Qualified External Session hook credential disappeared',
            );
        }
        return existing;
    }
}

function resolveNodeExecutable(): string {
    const executable = resolveJavaScriptRuntimeExecutable({
        isBunRuntime: isBun(),
    });
    if (!executable) {
        throw new ReferenceError(
            buildMissingJavaScriptRuntimeMessage(
                'qualified External Session hook forwarder',
            ),
        );
    }
    return executable;
}

export async function startQualifiedExternalSessionHookListener(
    params: Readonly<{
        activeServerDir: string;
        ingress: QualifiedExternalSessionHookTransportIngress;
        nodeExecutable?: string;
        forwarderScript?: string;
    }>,
): Promise<QualifiedExternalSessionHookListener> {
    const endpointPath = resolveEndpointPath(params.activeServerDir);
    const persistedPort = await readPersistedPort(endpointPath);
    const nodeExecutable = params.nodeExecutable ?? resolveNodeExecutable();
    const forwarderScript = params.forwarderScript
        ?? resolveCliRuntimeAssetPath('scripts', 'session_hook_forwarder.cjs');
    const server = await startSessionHookServerWithPersistedPortTakeover({
        ...(persistedPort === null ? {} : { requestedPort: persistedPort }),
        onQualifiedExternalSessionHook: async (request) =>
            await params.ingress.handleAuthenticatedEvent(request),
    });
    try {
        if (persistedPort === null) {
            await writeJsonAtomic(endpointPath, { v: 1, port: server.port });
        }
    } catch (error) {
        server.stop();
        await server.closed;
        throw error;
    }

    let stopped = false;

    const materializePrincipal = (
        input: CredentialInput,
        token: string,
        secretFile: string,
    ): QualifiedExternalSessionHookCredential => {
        const installationPrincipalRef =
            input.installationPrincipalRef ?? randomUUID();
        const derivedEventPrincipalRef = eventPrincipalRef(
            installationPrincipalRef,
            input.eventId,
        );
        params.ingress.createPrincipal({
            ...input,
            principalRef: derivedEventPrincipalRef,
            token,
        });
        return Object.freeze({
            installationPrincipalRef,
            eventPrincipalRef: derivedEventPrincipalRef,
            eventId: input.eventId,
            secretFile,
        });
    };

    const materializeCredential = async (
        input: CredentialInput,
        rotate: boolean,
    ): Promise<QualifiedExternalSessionHookCredential> => {
        const secretFile = resolveCredentialFile({
            activeServerDir: params.activeServerDir,
            qualifiedContributionId: input.qualifiedContributionId,
            hostInstallationId: input.hostInstallationId,
            eventId: input.eventId,
        });
        let token: string;
        if (rotate) {
            token = randomBytes(32).toString('base64url');
            await replacePrivateBearerFile({
                path: secretFile,
                contents: `${token}\n`,
            });
        } else {
            token = await readCredential(secretFile)
                ?? await createCredential(secretFile);
        }
        return materializePrincipal(input, token, secretFile);
    };

    const restoreCredential = async (
        input: CredentialInput & Readonly<{
            installationPrincipalRef: string;
        }>,
    ) => {
        const secretFile = resolveCredentialFile({
            activeServerDir: params.activeServerDir,
            qualifiedContributionId: input.qualifiedContributionId,
            hostInstallationId: input.hostInstallationId,
            eventId: input.eventId,
        });
        let token: string | null;
        try {
            token = await readCredential(secretFile);
        } catch (error) {
            if (
                error
                instanceof InvalidQualifiedExternalSessionHookCredentialError
            ) {
                return Object.freeze({
                    state: 'unavailable' as const,
                    reason: 'corrupt' as const,
                });
            }
            throw error;
        }
        if (!token) {
            return Object.freeze({
                state: 'unavailable' as const,
                reason: 'missing' as const,
            });
        }
        return Object.freeze({
            state: 'restored' as const,
            credential: materializePrincipal(input, token, secretFile),
        });
    };
    const buildOwnedEntry = (
        secretFile: string,
        event: AgentExternalSessionHookInstallationVariant['events'][number],
    ): QualifiedExternalSessionHookOwnedEntry => {
        const command = buildShellCommand([
            nodeExecutable,
            forwarderScript,
            String(server.port),
            event.eventId,
            '--qualified-external-session',
            '--secret-file',
            secretFile,
        ], event.command.shellDialect);
        return Object.freeze({
            matcher: event.command.matcher ?? null,
            hooks: Object.freeze([Object.freeze({
                type: 'command' as const,
                command,
                timeout: hookEventJsonArraysTimeoutSeconds(
                    event.command.timeoutMs,
                ),
            })]),
        });
    };

    return Object.freeze({
        port: server.port,
        async createOrReuseCredential(input) {
            return await materializeCredential(input, false);
        },
        restoreCredential,
        async rotateCredential(input) {
            return await materializeCredential(input, true);
        },
        enable(eventRef) {
            return params.ingress.enable(eventRef);
        },
        disable(eventRef) {
            return params.ingress.disable(eventRef);
        },
        disableDurableCredential(input) {
            return params.ingress.disable(eventPrincipalRef(
                input.installationPrincipalRef,
                input.eventId,
            ));
        },
        async revokeDurableCredential(input) {
            params.ingress.revoke(eventPrincipalRef(
                input.installationPrincipalRef,
                input.eventId,
            ));
            await revokeQualifiedExternalSessionHookDurableCredential({
                activeServerDir: params.activeServerDir,
                ...input,
            });
        },
        buildOwnedEntry({ credential, event }) {
            if (credential.eventId !== event.eventId) {
                throw new Error(
                    'Qualified External Session hook credential/event mismatch',
                );
            }
            return buildOwnedEntry(credential.secretFile, event);
        },
        buildOwnedEntryPreview(input) {
            return buildOwnedEntry(resolveCredentialFile({
                activeServerDir: params.activeServerDir,
                qualifiedContributionId: input.qualifiedContributionId,
                hostInstallationId: input.hostInstallationId,
                eventId: input.event.eventId,
            }), input.event);
        },
        async stop() {
            if (stopped) return;
            stopped = true;
            server.stop();
            await server.closed;
        },
    });
}
