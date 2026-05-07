import {
    type ScmHostingProvider,
    SCM_OPERATION_ERROR_CODES,
    type ScmPullRequestOpenOrReuseRequest,
    type ScmPullRequestOpenOrReuseResponse,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import {
    resolveGithubConnectedAccountToken,
    type GithubConnectedAccountTokenResolution,
} from '../../../hostingProviders/auth/resolveGithubConnectedAccountToken';
import { detectGithubCliAuth, type GithubCliAuthDetectionResult } from '../../../hostingProviders/providers/githubCliDetection';
import { detectGitlabCliAuth, type GitlabCliAuthDetectionResult } from '../../../hostingProviders/providers/gitlabCliDetection';
import { defaultScmHostingProviderRegistry } from '../../../hostingProviders/registry';

type GithubConnectedAccountAuthResolution =
    | (Extract<GithubConnectedAccountTokenResolution, { kind: 'available' }> & Readonly<{ authProfileKey: string }>)
    | Extract<GithubConnectedAccountTokenResolution, { kind: 'missing' }>;

type GithubCliAuthDetector = (input: Readonly<{
    providerBaseUrl: string;
}>) => Promise<GithubCliAuthDetectionResult>;

type GitlabCliAuthDetector = (input: Readonly<{
    providerBaseUrl: string;
}>) => Promise<GitlabCliAuthDetectionResult>;

export function providerUnavailableResponse<T extends { success: false; errorCode?: string; error: string }>(): T {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'No supported SCM hosting provider was detected for this repository.',
    } as T;
}

export function resolveOpenOrReuseHead(input: {
    snapshot: ScmWorkingSnapshot;
    request: ScmPullRequestOpenOrReuseRequest;
}): { ok: true; head: string } | { ok: false; error: string } {
    const requestedHead = input.request.head?.trim();
    if (requestedHead) return { ok: true, head: requestedHead };
    const snapshotHead = input.snapshot.branch.head?.trim();
    if (snapshotHead && !input.snapshot.branch.detached) return { ok: true, head: snapshotHead };
    return { ok: false, error: 'A pull request head branch is required while HEAD is detached.' };
}

export function buildConnectedAccountAuthProfileKey(input: {
    profileId: string;
    credentialKind: 'oauth' | 'token';
}): string {
    return `connected:${input.credentialKind}:${input.profileId}`;
}

function isGithubDotComBaseUrl(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).hostname.toLowerCase() === 'github.com';
    } catch {
        return false;
    }
}

async function resolveGithubCredentialRecord(context: ScmBackendContext) {
    if (!context.connectedAccounts) return null;
    try {
        return await context.connectedAccounts.resolveCredential('github');
    } catch {
        return null;
    }
}

export async function resolveGithubConnectedAccountAuth(input: {
    context: ScmBackendContext;
    providerBaseUrl: string;
    requireDotComHost?: boolean;
}): Promise<GithubConnectedAccountAuthResolution> {
    if (input.requireDotComHost === true && !isGithubDotComBaseUrl(input.providerBaseUrl)) {
        return { kind: 'missing' };
    }

    const resolved = resolveGithubConnectedAccountToken(await resolveGithubCredentialRecord(input.context));
    if (resolved.kind !== 'available') {
        return resolved;
    }

    return {
        ...resolved,
        authProfileKey: buildConnectedAccountAuthProfileKey(resolved),
    };
}

export async function resolveHostingAuthProfileKey(input: {
    context: ScmBackendContext;
    provider: ScmHostingProvider | null;
    detectGithubCliAuth?: GithubCliAuthDetector;
    detectGitlabCliAuth?: GitlabCliAuthDetector;
}): Promise<string | null> {
    if (!input.provider) return null;

    if (input.provider.kind === 'github') {
        const connectedAccount = await resolveGithubConnectedAccountAuth({
            context: input.context,
            providerBaseUrl: input.provider.baseUrl,
            requireDotComHost: true,
        });
        if (connectedAccount.kind === 'available') {
            return connectedAccount.authProfileKey;
        }
        const cliAuth = await (input.detectGithubCliAuth ?? detectGithubCliAuth)({
            providerBaseUrl: input.provider.baseUrl,
        });
        return cliAuth.kind === 'authenticated' ? 'gh-cli' : null;
    }

    if (input.provider.kind === 'gitlab') {
        const cliAuth = await (input.detectGitlabCliAuth ?? detectGitlabCliAuth)({
            providerBaseUrl: input.provider.baseUrl,
        });
        return cliAuth.kind === 'authenticated' ? 'glab-cli' : null;
    }

    return null;
}

export function buildNoAuthOpenOrReuseResponse(input: {
    provider: ScmWorkingSnapshot['hostingProvider'];
    base: string;
    head: string;
}): ScmPullRequestOpenOrReuseResponse {
    if (!input.provider) {
        return providerUnavailableResponse<ScmPullRequestOpenOrReuseResponse & { success: false }>();
    }
    const composeUrl = defaultScmHostingProviderRegistry.buildCompareUrl({
        provider: input.provider,
        base: input.base,
        head: input.head,
    });
    if (!composeUrl) {
        return providerUnavailableResponse<ScmPullRequestOpenOrReuseResponse & { success: false }>();
    }
    return {
        success: true,
        kind: 'no-auth',
        composeUrl,
    };
}
