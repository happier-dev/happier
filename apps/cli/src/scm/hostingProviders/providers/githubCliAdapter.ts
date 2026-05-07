import type {
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositorySummary,
    ScmHostingRepositoryVisibility,
    ScmHostingProvider,
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
import {
    type GithubCliCommandRunner,
    resolveGithubCliHost,
    runGithubCliCommand,
} from './githubCliDetection';
import { mapGithubPullRequest } from './githubPullRequestMapping';

const DEFAULT_GITHUB_CLI_PR_TIMEOUT_MS = 30_000;
const GITHUB_PR_JSON_FIELDS = 'number,title,url,state,baseRefName,headRefName,mergedAt';
const GITHUB_REPOSITORY_JSON_FIELDS = 'nameWithOwner,url,sshUrl,defaultBranchRef,visibility';

function resolveGithubCliPrTimeoutMs(): number {
    const parsed = Number(String(process.env.HAPPIER_GITHUB_CLI_PR_TIMEOUT_MS ?? '').replaceAll('_', '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_GITHUB_CLI_PR_TIMEOUT_MS;
}

function buildRepoSelector(provider: ScmHostingProvider): string {
    if (!provider.nameWithOwner) {
        throw new Error('GitHub repository owner/name is unavailable.');
    }
    return buildRepoSelectorFromBaseUrl(provider.baseUrl, provider.nameWithOwner);
}

function buildRepoSelectorFromBaseUrl(providerBaseUrl: string, nameWithOwner: string): string {
    const host = resolveGithubCliHost(providerBaseUrl);
    return host === 'github.com' ? nameWithOwner : `${host}/${nameWithOwner}`;
}

function buildGithubApiArgs(providerBaseUrl: string, path: string): string[] {
    const host = resolveGithubCliHost(providerBaseUrl);
    return host === 'github.com'
        ? ['api', path]
        : ['api', '--hostname', host, path];
}

function readJsonOutput(stdout: string): unknown {
    try {
        return JSON.parse(stdout);
    } catch {
        throw new Error('GitHub CLI returned invalid JSON.');
    }
}

function readLogin(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const login = (value as { login?: unknown }).login;
    return typeof login === 'string' && login.trim() ? login.trim() : null;
}

function buildGithubCloneUrlFromWebUrl(url: string): string {
    const withoutTrailingSlash = url.trim().replace(/\/+$/g, '');
    return /\.git$/i.test(withoutTrailingSlash)
        ? withoutTrailingSlash
        : `${withoutTrailingSlash}.git`;
}

function parseCreatedPullRequestReference(stdout: string): string {
    const reference = stdout
        .split(/\s+/)
        .map((part) => part.trim())
        .find((part) => /^https?:\/\//i.test(part));
    if (!reference) {
        throw new Error('GitHub CLI did not return a pull request URL.');
    }
    return reference;
}

function throwGithubCliFailure(action: string, stderr: string): never {
    const message = stderr.trim() || `GitHub CLI ${action} failed.`;
    throw new Error(message);
}

async function runRequiredGithubCliCommand(input: Readonly<{
    runCommand: GithubCliCommandRunner;
    args: readonly string[];
}>): Promise<string> {
    const result = await input.runCommand({
        args: input.args,
        timeoutMs: resolveGithubCliPrTimeoutMs(),
    });
    if (!result.success) {
        throwGithubCliFailure(input.args.slice(0, 2).join(' '), result.stderr);
    }
    return result.stdout;
}

async function viewPullRequest(input: Readonly<{
    provider: ScmHostingProvider;
    reference: string;
    runCommand: GithubCliCommandRunner;
}>): Promise<ScmPullRequestSummary> {
    const stdout = await runRequiredGithubCliCommand({
        runCommand: input.runCommand,
        args: [
            'pr',
            'view',
            input.reference,
            '--repo',
            buildRepoSelector(input.provider),
            '--json',
            GITHUB_PR_JSON_FIELDS,
        ],
    });
    const mapped = mapGithubPullRequest(input.provider, readJsonOutput(stdout));
    if (!mapped) {
        throw new Error('GitHub CLI returned an invalid pull request payload.');
    }
    return mapped;
}

async function viewRepository(input: Readonly<{
    providerBaseUrl: string;
    nameWithOwner: string;
    runCommand: GithubCliCommandRunner;
}>): Promise<ScmHostingRepositorySummary> {
    const stdout = await runRequiredGithubCliCommand({
        runCommand: input.runCommand,
        args: [
            'repo',
            'view',
            buildRepoSelectorFromBaseUrl(input.providerBaseUrl, input.nameWithOwner),
            '--json',
            GITHUB_REPOSITORY_JSON_FIELDS,
        ],
    });
    return mapGithubRepository({
        providerBaseUrl: input.providerBaseUrl,
        repository: readJsonOutput(stdout),
    });
}

function mapGithubRepository(input: Readonly<{
    providerBaseUrl: string;
    repository: unknown;
}>): ScmHostingRepositorySummary {
    if (!input.repository || typeof input.repository !== 'object') {
        throw new Error('GitHub CLI returned an invalid repository payload.');
    }
    const record = input.repository as Record<string, unknown>;
    const nameWithOwner = typeof record.nameWithOwner === 'string' ? record.nameWithOwner : null;
    const url = typeof record.url === 'string' ? record.url : null;
    if (!nameWithOwner || !url) {
        throw new Error('GitHub CLI returned an invalid repository payload.');
    }
    const defaultBranchRef = record.defaultBranchRef;
    const defaultBranch = defaultBranchRef && typeof defaultBranchRef === 'object'
        ? (defaultBranchRef as { name?: unknown }).name
        : null;
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
        cloneUrl: buildGithubCloneUrlFromWebUrl(url),
        ...(typeof record.sshUrl === 'string' ? { sshUrl: record.sshUrl } : {}),
        visibility: mapGithubRepositoryVisibility(record.visibility),
        defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : null,
    };
}

function mapGithubRepositoryVisibility(value: unknown): ScmHostingRepositoryVisibility {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    if (normalized === 'public' || normalized === 'internal') return normalized;
    return 'private';
}

async function readPublishTargets(input: Readonly<{
    providerBaseUrl: string;
    runCommand: GithubCliCommandRunner;
}>): Promise<readonly ScmHostingRepositoryPublishTarget[]> {
    const [userJson, orgsJson] = await Promise.all([
        runRequiredGithubCliCommand({
            runCommand: input.runCommand,
            args: buildGithubApiArgs(input.providerBaseUrl, 'user'),
        }),
        runRequiredGithubCliCommand({
            runCommand: input.runCommand,
            args: buildGithubApiArgs(input.providerBaseUrl, 'user/orgs'),
        }),
    ]);
    const userLogin = readLogin(readJsonOutput(userJson));
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
    const orgs = readJsonOutput(orgsJson);
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
}

export function createGithubCliAdapter(params?: Readonly<{
    runCommand?: GithubCliCommandRunner;
}>): ScmHostingProviderAdapter {
    const runCommand = params?.runCommand ?? runGithubCliCommand;
    return {
        ...githubScmHostingProviderAdapter,
        async listOpenPullRequests(input: ScmHostingProviderListOpenPullRequestsInput) {
            const args = [
                'pr',
                'list',
                '--repo',
                buildRepoSelector(input.provider),
                '--state',
                'open',
                '--json',
                GITHUB_PR_JSON_FIELDS,
            ];
            if (input.base) args.push('--base', input.base);
            if (input.head) args.push('--head', input.head);
            const stdout = await runRequiredGithubCliCommand({ runCommand, args });
            const rawItems = readJsonOutput(stdout);
            const items = Array.isArray(rawItems) ? rawItems : [];
            return items
                .map((item) => mapGithubPullRequest(input.provider, item))
                .filter((item): item is ScmPullRequestSummary => item !== null);
        },
        async getPullRequest(input: ScmHostingProviderGetPullRequestInput) {
            return await viewPullRequest({
                provider: input.provider,
                reference: String(input.number),
                runCommand,
            });
        },
        async createPullRequest(input: ScmHostingProviderCreatePullRequestInput) {
            const args = [
                'pr',
                'create',
                '--repo',
                buildRepoSelector(input.provider),
                '--base',
                input.base,
                '--head',
                input.head,
                '--title',
                input.title,
                '--body',
                input.body,
            ];
            if (input.draft) args.push('--draft');
            const stdout = await runRequiredGithubCliCommand({ runCommand, args });
            return await viewPullRequest({
                provider: input.provider,
                reference: parseCreatedPullRequestReference(stdout),
                runCommand,
            });
        },
        async listRepositoryPublishTargets(input: ScmHostingProviderListRepositoryPublishTargetsInput) {
            return await readPublishTargets({
                providerBaseUrl: input.providerBaseUrl,
                runCommand,
            });
        },
        async createRepository(input: ScmHostingProviderCreateRepositoryInput) {
            const nameWithOwner = `${input.owner}/${input.repositoryName}`;
            const args = [
                'repo',
                'create',
                buildRepoSelectorFromBaseUrl(input.providerBaseUrl, nameWithOwner),
                input.visibility === 'public'
                    ? '--public'
                    : input.visibility === 'internal'
                        ? '--internal'
                        : '--private',
            ];
            if (input.description?.trim()) {
                args.push('--description', input.description.trim());
            }
            await runRequiredGithubCliCommand({ runCommand, args });
            return await viewRepository({
                providerBaseUrl: input.providerBaseUrl,
                nameWithOwner,
                runCommand,
            });
        },
    };
}

export const githubCliScmHostingProviderAdapter = createGithubCliAdapter();
