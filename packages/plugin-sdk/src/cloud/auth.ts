import type { FetchRuntimeServiceV1 } from '../fetch';

export type CloudAuthFailureCodeV1 =
    | 'unsupported'
    | 'cancelled'
    | 'failed'
    | 'invalid_result'
    | 'timeout'
    | 'provider_error';

export type CloudAuthDiagnosticV1 = Readonly<{
    code: string;
    message?: string;
}>;

export type CloudAuthOpenBrowserResultV1 =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthPromptTextInputV1 = Readonly<{
    label: string;
    secret?: boolean;
}>;

export type CloudAuthPromptTextResultV1 =
    | Readonly<{ ok: true; value: string }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthPkceChallengeV1 = Readonly<{
    verifier: string;
    challenge: string;
}>;

export type CloudAuthCallbackModeV1 = 'loopback' | 'paste';

export type CloudAuthCallbackCreateInputV1 = Readonly<{
    mode: CloudAuthCallbackModeV1;
    preferredPort?: number;
    callbackPath?: `/${string}`;
    timeoutMs?: number;
}>;

export type CloudAuthCallbackWaitInputV1 = Readonly<{
    promptLabel?: string;
}>;

export type CloudAuthCallbackResultV1 =
    | Readonly<{ ok: true; code: string; state: string; redirectUri: string }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthCallbackSessionV1 = Readonly<{
    mode: CloudAuthCallbackModeV1;
    state: string;
    redirectUri: string;
    callbackUrl?: string;
    port?: number;
    wait(input?: CloudAuthCallbackWaitInputV1): Promise<CloudAuthCallbackResultV1>;
    close(): Promise<void>;
}>;

export type CloudAuthCallbackCreateResultV1 =
    | Readonly<{ ok: true; session: CloudAuthCallbackSessionV1 }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthCallbackServiceV1 = Readonly<{
    create(input: CloudAuthCallbackCreateInputV1): Promise<CloudAuthCallbackCreateResultV1>;
}>;

export type CloudAuthLoopbackInputV1 = Readonly<{
    defaultPort?: number;
    callbackPath?: string;
}>;

export type CloudAuthLoopbackResultV1 = CloudAuthCallbackResultV1;

export type CloudAuthCredentialWriteInputV1 = Readonly<{
    serviceId?: string;
    profileId?: string;
    record?: unknown;
}>;

export type CloudAuthCredentialWriteResultV1 =
    | Readonly<{ ok: true; credentialRef: string }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudConnectAuthenticateOptionsV1 = Readonly<{
    paste?: boolean;
    device?: boolean;
    noOpen?: boolean;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    serviceId?: string;
    profileId?: string;
}>;

export type CloudConnectAuthenticateResultV1 =
    | Readonly<{
        ok: true;
        accountRef?: string;
        credentialRef?: string;
        diagnostics?: readonly CloudAuthDiagnosticV1[];
    }>
    | Readonly<{
        ok: false;
        code: CloudAuthFailureCodeV1;
        retryAfterMs?: number;
        diagnostics?: readonly CloudAuthDiagnosticV1[];
    }>;

export function isCloudConnectAuthenticateResultV1(value: unknown): value is CloudConnectAuthenticateResultV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    if (record.ok === true) return true;
    return record.ok === false && typeof record.code === 'string';
}

export type CloudCustomAuthenticatorContextV1 = Readonly<{
    signal: AbortSignal;
    now(): number;
    fetch: FetchRuntimeServiceV1;
    browser: Readonly<{
        open(url: string): Promise<CloudAuthOpenBrowserResultV1>;
    }>;
    prompt: Readonly<{
        requestText(input: CloudAuthPromptTextInputV1): Promise<CloudAuthPromptTextResultV1>;
    }>;
    oauth: Readonly<{
        createPkceChallenge(): Promise<CloudAuthPkceChallengeV1>;
        callback: CloudAuthCallbackServiceV1;
        listenForCallback(input: CloudAuthLoopbackInputV1): Promise<CloudAuthLoopbackResultV1>;
    }>;
    credentials: Readonly<{
        write(input: CloudAuthCredentialWriteInputV1): Promise<CloudAuthCredentialWriteResultV1>;
    }>;
    diagnostics: Readonly<{
        info(input: CloudAuthDiagnosticV1): void;
        warn(input: CloudAuthDiagnosticV1): void;
    }>;
}>;

export type CloudCustomAuthenticatorV1 = (
    opts: CloudConnectAuthenticateOptionsV1,
    context: CloudCustomAuthenticatorContextV1,
) => Promise<CloudConnectAuthenticateResultV1 | unknown> | CloudConnectAuthenticateResultV1 | unknown;
