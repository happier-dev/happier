import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type {
    CloudAuthCallbackCreateInputV1,
    CloudAuthCallbackCreateResultV1,
    CloudAuthCallbackResultV1,
    CloudAuthCallbackServiceV1,
    CloudAuthCallbackSessionV1,
    CloudAuthCallbackWaitInputV1,
    CloudAuthFailureCodeV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';

const DEFAULT_CALLBACK_PATH = '/auth/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

type NodeHttpServerFactory = (
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) => Server;

export type CloudAuthCallbackServiceOptions = Readonly<{
    signal?: AbortSignal;
    promptText?: (label: string) => Promise<string>;
    generateState?: () => string;
    defaultTimeoutMs?: number;
    createServerFn?: NodeHttpServerFactory;
    isLoopbackPortAvailableFn?: (port: number) => Promise<boolean>;
    findAvailableLoopbackPortFn?: () => Promise<number>;
}>;

function generateOauthState(): string {
    return randomBytes(32).toString('hex');
}

function failure(
    code: CloudAuthFailureCodeV1,
    diagnosticCode: string,
    message?: string,
): Extract<CloudAuthCallbackResultV1, { ok: false }> {
    return {
        ok: false,
        code,
        diagnostics: [
            {
                code: diagnosticCode,
                ...(message ? { message } : {}),
            },
        ],
    };
}

function createFailureResult(
    code: CloudAuthFailureCodeV1,
    diagnosticCode: string,
    message?: string,
): CloudAuthCallbackCreateResultV1 {
    return {
        ok: false,
        code,
        diagnostics: [
            {
                code: diagnosticCode,
                ...(message ? { message } : {}),
            },
        ],
    };
}

function normalizeCallbackPath(callbackPath: string | undefined): `/${string}` | null {
    const path = callbackPath?.trim() || DEFAULT_CALLBACK_PATH;
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) return null;
    try {
        const parsed = new URL(path, 'http://localhost');
        return parsed.pathname === path ? path as `/${string}` : null;
    } catch {
        return null;
    }
}

function renderSuccessHtml(): string {
    return [
        '<html>',
        '<body style="font-family: sans-serif; padding: 20px;">',
        '<h2>Authentication Successful</h2>',
        '<p>You can close this window and return to Happier.</p>',
        '</body>',
        '</html>',
    ].join('');
}

async function resolveLoopbackPort(
    preferredPort: number | undefined,
    opts: Required<Pick<CloudAuthCallbackServiceOptions, 'findAvailableLoopbackPortFn' | 'isLoopbackPortAvailableFn'>>,
): Promise<number> {
    if (!preferredPort || !Number.isInteger(preferredPort) || preferredPort <= 0) {
        return await opts.findAvailableLoopbackPortFn();
    }
    return await opts.isLoopbackPortAvailableFn(preferredPort)
        ? preferredPort
        : await opts.findAvailableLoopbackPortFn();
}

function createWaitController(
    params: Readonly<{
        signal?: AbortSignal;
        timeoutMs: number;
        closeTransport: () => Promise<void>;
    }>,
): Readonly<{
    promise: Promise<CloudAuthCallbackResultV1>;
    settle(result: CloudAuthCallbackResultV1): void;
    isSettled(): boolean;
    close(): Promise<void>;
}> {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let resolveWait!: (result: CloudAuthCallbackResultV1) => void;
    const promise = new Promise<CloudAuthCallbackResultV1>((resolve) => {
        resolveWait = resolve;
    });
    const removeAbortListener = () => params.signal?.removeEventListener('abort', abort);
    const settle = (result: CloudAuthCallbackResultV1) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        removeAbortListener();
        void params.closeTransport();
        resolveWait(result);
    };
    const abort = () => settle(failure('cancelled', 'authentication_cancelled'));

    if (params.signal?.aborted) {
        abort();
    } else {
        params.signal?.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(() => {
            settle(failure('timeout', 'authentication_timeout'));
        }, params.timeoutMs);
    }

    return {
        promise,
        settle,
        isSettled: () => settled,
        close: async () => {
            settle(failure('cancelled', 'authentication_cancelled'));
            await params.closeTransport();
        },
    };
}

function createServerClose(server: Server): () => Promise<void> {
    let closePromise: Promise<void> | null = null;
    return () => {
        if (!server.listening) {
            return Promise.resolve();
        }
        closePromise ??= new Promise<void>((resolve) => {
            try {
                server.closeAllConnections();
                server.close(() => resolve());
            } catch {
                closePromise = null;
                resolve();
            }
        });
        return closePromise;
    };
}

async function createLoopbackSession(
    input: CloudAuthCallbackCreateInputV1,
    opts: Required<Omit<CloudAuthCallbackServiceOptions, 'signal' | 'promptText'>> & Pick<CloudAuthCallbackServiceOptions, 'signal'>,
): Promise<CloudAuthCallbackCreateResultV1> {
    const callbackPath = normalizeCallbackPath(input.callbackPath);
    if (!callbackPath) return createFailureResult('invalid_result', 'invalid_callback_path');
    const timeoutMs = Math.max(1, input.timeoutMs ?? opts.defaultTimeoutMs);
    const port = await resolveLoopbackPort(input.preferredPort, opts);
    const state = opts.generateState();
    const redirectUri = `http://localhost:${port}${callbackPath}`;
    const callbackUrl = `http://127.0.0.1:${port}${callbackPath}`;
    let controller: ReturnType<typeof createWaitController>;
    const server = opts.createServerFn(async (req, res) => {
        const requestUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
        if (requestUrl.pathname !== callbackPath) {
            res.writeHead(404, { Connection: 'close' });
            res.end('Not found');
            return;
        }

        const receivedState = requestUrl.searchParams.get('state');
        if (receivedState !== state) {
            res.writeHead(400, { Connection: 'close' });
            res.end('Invalid state parameter');
            controller.settle(failure('invalid_result', 'oauth_state_mismatch'));
            return;
        }

        const providerError = requestUrl.searchParams.get('error');
        if (providerError) {
            res.writeHead(400, { Connection: 'close' });
            res.end('Authentication failed');
            controller.settle(failure('provider_error', 'oauth_provider_error'));
            return;
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
            res.writeHead(400, { Connection: 'close' });
            res.end('No authorization code received');
            controller.settle(failure('invalid_result', 'oauth_code_missing'));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' });
        res.end(renderSuccessHtml());
        controller.settle({
            ok: true,
            code,
            state,
            redirectUri,
        });
    });
    const closeTransport = createServerClose(server);
    controller = createWaitController({
        signal: opts.signal,
        timeoutMs,
        closeTransport,
    });

    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => resolve());
        });
    } catch (error) {
        controller.settle(failure('failed', 'loopback_listener_start_failed'));
        await closeTransport();
        return createFailureResult(
            'failed',
            'loopback_listener_start_failed',
            error instanceof Error ? error.message : String(error),
        );
    }
    if (controller.isSettled()) {
        await closeTransport();
        const result = await controller.promise;
        return result.ok
            ? createFailureResult('failed', 'loopback_listener_already_settled')
            : result;
    }

    const session: CloudAuthCallbackSessionV1 = Object.freeze({
        mode: 'loopback',
        state,
        redirectUri,
        callbackUrl,
        port,
        wait: async () => await controller.promise,
        close: async () => await controller.close(),
    });
    return { ok: true, session };
}

async function createPasteSession(
    input: CloudAuthCallbackCreateInputV1,
    opts: Required<Omit<CloudAuthCallbackServiceOptions, 'signal' | 'promptText'>> & Pick<CloudAuthCallbackServiceOptions, 'signal' | 'promptText'>,
): Promise<CloudAuthCallbackCreateResultV1> {
    const callbackPath = normalizeCallbackPath(input.callbackPath);
    if (!callbackPath) return createFailureResult('invalid_result', 'invalid_callback_path');
    const timeoutMs = Math.max(1, input.timeoutMs ?? opts.defaultTimeoutMs);
    const port = input.preferredPort && input.preferredPort > 0
        ? input.preferredPort
        : await opts.findAvailableLoopbackPortFn();
    const state = opts.generateState();
    const redirectUri = `http://localhost:${port}${callbackPath}`;
    let waitPromise: Promise<CloudAuthCallbackResultV1> | null = null;
    const closeTransport = async () => {};
    const controller = createWaitController({
        signal: opts.signal,
        timeoutMs,
        closeTransport,
    });

    const wait = (waitInput?: CloudAuthCallbackWaitInputV1) => {
        waitPromise ??= (async () => {
            if (controller.isSettled()) {
                return await controller.promise;
            }
            if (!opts.promptText) {
                controller.settle(failure('unsupported', 'prompt_unavailable'));
                return await controller.promise;
            }
            try {
                const promptPromise = opts.promptText(waitInput?.promptLabel ?? 'Paste redirect URL: ');
                const promptResult = await Promise.race([
                    promptPromise.then((pasted) => ({ kind: 'pasted' as const, pasted })),
                    controller.promise.then((result) => ({ kind: 'settled' as const, result })),
                ]);
                if (promptResult.kind === 'settled') {
                    return promptResult.result;
                }
                const pasted = promptResult.pasted;
                if (controller.isSettled()) {
                    return await controller.promise;
                }
                const parsed = parseOauthRedirectPaste({ pasted });
                if (!parsed.ok) {
                    controller.settle(failure('invalid_result', `oauth_redirect_${parsed.error}`));
                } else if (parsed.state !== state) {
                    controller.settle(failure('invalid_result', 'oauth_state_mismatch'));
                } else {
                    controller.settle({
                        ok: true,
                        code: parsed.code,
                        state,
                        redirectUri,
                    });
                }
            } catch (error) {
                controller.settle(failure(
                    'failed',
                    'prompt_failed',
                    error instanceof Error ? error.message : String(error),
                ));
            }
            return await controller.promise;
        })();
        return waitPromise;
    };

    const session: CloudAuthCallbackSessionV1 = Object.freeze({
        mode: 'paste',
        state,
        redirectUri,
        port,
        wait,
        close: async () => await controller.close(),
    });
    return { ok: true, session };
}

export function createCloudAuthCallbackService(options: CloudAuthCallbackServiceOptions = {}): CloudAuthCallbackServiceV1 {
    const opts = {
        signal: options.signal,
        promptText: options.promptText,
        generateState: options.generateState ?? generateOauthState,
        defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        createServerFn: options.createServerFn ?? createServer,
        isLoopbackPortAvailableFn: options.isLoopbackPortAvailableFn ?? isLoopbackPortAvailable,
        findAvailableLoopbackPortFn: options.findAvailableLoopbackPortFn ?? findAvailableLoopbackPort,
    };

    return Object.freeze({
        create: async (input: CloudAuthCallbackCreateInputV1): Promise<CloudAuthCallbackCreateResultV1> => {
            if (opts.signal?.aborted) {
                return createFailureResult('cancelled', 'authentication_cancelled');
            }
            return input.mode === 'paste'
                ? await createPasteSession(input, opts)
                : await createLoopbackSession(input, opts);
        },
    });
}
