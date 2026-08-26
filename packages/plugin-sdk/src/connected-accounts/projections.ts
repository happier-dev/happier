export type {
    ConnectedAccountPurposeDeclarationsV1 as ConnectedAccountPurposeDeclarations,
} from '@happier-dev/protocol/connect/connected-account-purposes';

import type {
    AuthCallbackCreateInput,
    AuthCallbackWaitInput,
    AuthFailureCode,
} from '../connectedAccounts.js';

/** Bounded author-facing diagnostic returned by Connected Account auth helpers. */
export type ConnectedAccountAuthDiagnostic = Readonly<{
    code: string;
    message?: string;
}>;

export type ConnectedAccountAuthFailure = Readonly<{
    ok: false;
    code: AuthFailureCode;
    diagnostics?: readonly ConnectedAccountAuthDiagnostic[];
}>;

export type AuthOpenBrowserResult = Readonly<{ ok: true }> | ConnectedAccountAuthFailure;
export type AuthPromptTextResult = Readonly<{ ok: true; value: string }> | ConnectedAccountAuthFailure;
export type AuthCallbackResult =
    | Readonly<{ ok: true; code: string; state: string; redirectUri: string }>
    | ConnectedAccountAuthFailure;
export type AuthLoopbackResult = AuthCallbackResult;
export type AuthCallbackSession = Readonly<{
    mode: 'loopback' | 'paste';
    state: string;
    redirectUri: string;
    callbackUrl?: string;
    port?: number;
    wait(input?: AuthCallbackWaitInput): Promise<AuthCallbackResult>;
    close(): Promise<void>;
}>;
export type AuthCallbackCreateResult =
    | Readonly<{ ok: true; session: AuthCallbackSession }>
    | ConnectedAccountAuthFailure;
export type AuthCallbackService = Readonly<{
    create(input: AuthCallbackCreateInput): Promise<AuthCallbackCreateResult>;
}>;
