import type {
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositorySummary,
    ScmHostingRepositoryVisibility,
    ScmPullRequestSummary,
} from '@happier-dev/protocol';

import type {
    ScmHostingProviderAdapter,
    ScmHostingProviderCreatePullRequestInput,
    ScmHostingProviderCreateRepositoryInput,
    ScmHostingProviderGetPullRequestInput,
    ScmHostingProviderListRepositoryPublishTargetsInput,
    ScmHostingProviderListOpenPullRequestsInput,
} from '../types';
import { githubScmHostingProviderAdapter } from './github';
import { mapGithubPullRequest } from './githubPullRequestMapping';

type GithubRestFetcher = (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json(): Promise<unknown>;
    text(): Promise<string>;
}>;

function resolveGitHubApiBaseUrl(providerBaseUrl: string): string {
    const parsed = new URL(providerBaseUrl);
    if (parsed.hostname === 'github.com') return 'https://api.github.com';
    return `${parsed.protocol}//${parsed.hostname}/api/v3`;
}

function buildPullsUrl(input: ScmHostingProviderListOpenPullRequestsInput): string {
    if (!input.provider.nameWithOwner) {
        throw new Error('GitHub repository owner/name is unavailable.');
    }
    const params = new URLSearchParams({ state: 'open' });
    if (input.base) params.set('base', input.base);
    if (input.head) {
        const [owner] = input.provider.nameWithOwner.split('/');
        const headFilter = input.head.includes(':') || !owner
            ? input.head
            : `${owner}:${input.head}`;
        params.set('head', headFilter);
    }
    return `${resolveGitHubApiBaseUrl(input.provider.baseUrl)}/repos/${input.provider.nameWithOwner}/pulls?${params.toString()}`;
}

function buildPullUrl(input: ScmHostingProviderGetPullRequestInput): string {
    if (!input.provider.nameWithOwner) {
        throw new Error('GitHub repository owner/name is unavailable.');
    }
    return `${resolveGitHubApiBaseUrl(input.provider.baseUrl)}/repos/${input.provider.nameWithOwner}/pulls/${input.number}`;
}

function buildCreatePullUrl(input: ScmHostingProviderCreatePullRequestInput): string {
    if (!input.provider.nameWithOwner) {
        throw new Error('GitHub repository owner/name is unavailable.');
    }
    return `${resolveGitHubApiBaseUrl(input.provider.baseUrl)}/repos/${input.provider.nameWithOwner}/pulls`;
}

function buildAuthenticatedUserUrl(input: ScmHostingProviderListRepositoryPublishTargetsInput): string {
    return `${resolveGitHubApiBaseUrl(input.providerBaseUrl)}/user`;
}

function buildAuthenticatedUserOrgsUrl(input: ScmHostingProviderListRepositoryPublishTargetsInput): string {
    return `${resolveGitHubApiBaseUrl(input.providerBaseUrl)}/user/orgs`;
}

function buildCreateRepositoryUrl(input: ScmHostingProviderCreateRepositoryInput): string {
    const apiBase = resolveGitHubApiBaseUrl(input.providerBaseUrl);
    return input.ownerKind === 'org'
        ? `${apiBase}/orgs/${encodeURIComponent(input.owner)}/repos`
        : `${apiBase}/user/repos`;
}

function buildHeaders(token: string): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

function requireToken(token: string | undefined): string {
    const trimmed = token?.trim() ?? '';
    if (!trimmed) throw new Error('GitHub connected account token is required for REST pull request operations.');
    return trimmed;
}

async function readGithubResponseJson(response: Awaited<ReturnType<GithubRestFetcher>>): Promise<unknown> {
    if (response.ok) return await response.json();
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub request failed (${response.status}): ${body || response.statusText}`);
}

function readLogin(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const login = (value as { login?: unknown }).login;
    return typeof login === 'string' && login.trim() ? login.trim() : null;
}

function mapRepositoryVisibility(value: unknown): ScmHostingRepositoryVisibility {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    if (normalized === 'public' || normalized === 'internal') return normalized;
    if (value === false) return 'public';
    return 'private';
}

function mapGithubRepository(input: Readonly<{
    providerBaseUrl: string;
    repository: unknown;
}>): ScmHostingRepositorySummary {
    if (!input.repository || typeof input.repository !== 'object') {
        throw new Error('GitHub returned an invalid repository payload.');
    }
    const record = input.repository as Record<string, unknown>;
    const nameWithOwner = typeof record.full_name === 'string'
        ? record.full_name
        : typeof record.nameWithOwner === 'string'
            ? record.nameWithOwner
            : null;
    const url = typeof record.html_url === 'string'
        ? record.html_url
        : typeof record.url === 'string'
            ? record.url
            : null;
    if (!nameWithOwner || !url) {
        throw new Error('GitHub returned an invalid repository payload.');
    }
    return {
        provider: {
            kind: 'github',
            name: 'GitHub',
            baseUrl: input.providerBaseUrl,
            nameWithOwner,
            remoteName: null,
        },
        nameWithOwner,
        url,
        ...(typeof record.clone_url === 'string' ? { cloneUrl: record.clone_url } : {}),
        ...(typeof record.ssh_url === 'string' ? { sshUrl: record.ssh_url } : {}),
        visibility: mapRepositoryVisibility(record.visibility ?? (record.private === true ? 'private' : 'public')),
        defaultBranch: typeof record.default_branch === 'string' ? record.default_branch : null,
    };
}

export function createGithubRestAdapter(params?: Readonly<{
    fetcher?: GithubRestFetcher;
}>): ScmHostingProviderAdapter {
    const fetcher: GithubRestFetcher = params?.fetcher ?? ((url, init) => fetch(url, init));
    return {
        ...githubScmHostingProviderAdapter,
        async listOpenPullRequests(input) {
            const json = await readGithubResponseJson(await fetcher(buildPullsUrl(input), {
                method: 'GET',
                headers: buildHeaders(requireToken(input.token)),
            }));
            const items = Array.isArray(json) ? json : [];
            return items
                .map((item) => mapGithubPullRequest(input.provider, item))
                .filter((item): item is ScmPullRequestSummary => item !== null);
        },
        async getPullRequest(input) {
            const json = await readGithubResponseJson(await fetcher(buildPullUrl(input), {
                method: 'GET',
                headers: buildHeaders(requireToken(input.token)),
            }));
            return mapGithubPullRequest(input.provider, json);
        },
        async createPullRequest(input) {
            const json = await readGithubResponseJson(await fetcher(buildCreatePullUrl(input), {
                method: 'POST',
                headers: buildHeaders(requireToken(input.token)),
                body: JSON.stringify({
                    base: input.base,
                    head: input.head,
                    title: input.title,
                    body: input.body,
                    ...(input.draft ? { draft: true } : {}),
                }),
            }));
            const mapped = mapGithubPullRequest(input.provider, json);
            if (!mapped) throw new Error('GitHub returned an invalid pull request payload.');
            return mapped;
        },
        async listRepositoryPublishTargets(input) {
            const token = requireToken(input.token);
            const user = await readGithubResponseJson(await fetcher(buildAuthenticatedUserUrl(input), {
                method: 'GET',
                headers: buildHeaders(token),
            }));
            const orgs = await readGithubResponseJson(await fetcher(buildAuthenticatedUserOrgsUrl(input), {
                method: 'GET',
                headers: buildHeaders(token),
            }));
            const userLogin = readLogin(user);
            const targets: ScmHostingRepositoryPublishTarget[] = [];
            if (userLogin) {
                targets.push({
                    providerKind: 'github',
                    owner: userLogin,
                    ownerKind: 'user',
                    label: userLogin,
                    default: true,
                    supportedVisibilities: ['private', 'public'],
                });
            }
            if (Array.isArray(orgs)) {
                for (const org of orgs) {
                    const login = readLogin(org);
                    if (!login) continue;
                    targets.push({
                        providerKind: 'github',
                        owner: login,
                        ownerKind: 'org',
                        label: login,
                        supportedVisibilities: ['private', 'public', 'internal'],
                    });
                }
            }
            return targets;
        },
        async createRepository(input) {
            const body: Record<string, unknown> = {
                name: input.repositoryName,
                private: input.visibility === 'private',
            };
            if (input.visibility === 'internal') {
                body.visibility = 'internal';
            }
            if (input.description?.trim()) {
                body.description = input.description.trim();
            }
            const json = await readGithubResponseJson(await fetcher(buildCreateRepositoryUrl(input), {
                method: 'POST',
                headers: buildHeaders(requireToken(input.token)),
                body: JSON.stringify(body),
            }));
            return mapGithubRepository({
                providerBaseUrl: input.providerBaseUrl,
                repository: json,
            });
        },
    };
}

export const githubRestScmHostingProviderAdapter = createGithubRestAdapter();
