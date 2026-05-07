import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';

import type {
    ScmHostingProvider,
    ScmPullRequestSummary,
} from '@happier-dev/protocol';

import type {
    ScmHostingProviderAdapter,
    ScmHostingProviderCreatePullRequestInput,
    ScmHostingProviderGetPullRequestInput,
    ScmHostingProviderListOpenPullRequestsInput,
} from '../types';
import { stripTrailingSlash } from '../remoteUrl';
import { gitlabScmHostingProviderAdapter } from './gitlab';
import {
    type GitlabCliCommandRunner,
    resolveGitlabCliHost,
    runGitlabCliCommand,
} from './gitlabCliDetection';
import { mapGitlabMergeRequest } from './gitlabMergeRequestMapping';

const DEFAULT_GITLAB_CLI_MR_TIMEOUT_MS = 30_000;

function resolveGitlabCliMrTimeoutMs(): number {
    const parsed = Number(String(process.env.HAPPIER_GITLAB_CLI_MR_TIMEOUT_MS ?? '').replaceAll('_', '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_GITLAB_CLI_MR_TIMEOUT_MS;
}

function buildRepoSelector(provider: ScmHostingProvider): string {
    if (!provider.nameWithOwner) {
        throw new Error('GitLab repository owner/name is unavailable.');
    }
    const host = resolveGitlabCliHost(provider.baseUrl);
    return host === 'gitlab.com'
        ? provider.nameWithOwner
        : `${stripTrailingSlash(provider.baseUrl)}/${provider.nameWithOwner}`;
}

function buildApiProjectPath(provider: ScmHostingProvider): string {
    if (!provider.nameWithOwner) {
        throw new Error('GitLab repository owner/name is unavailable.');
    }
    return `projects/${encodeURIComponent(provider.nameWithOwner)}/merge_requests`;
}

function readJsonOutput(stdout: string): unknown {
    try {
        return JSON.parse(stdout);
    } catch {
        throw new Error('GitLab CLI returned invalid JSON.');
    }
}

function parseCreatedMergeRequestReference(stdout: string): string | null {
    return stdout
        .split(/\s+/)
        .map((part) => part.trim())
        .find((part) => /^https?:\/\//i.test(part)) ?? null;
}

function throwGitlabCliFailure(action: string, stderr: string): never {
    const message = stderr.trim() || `GitLab CLI ${action} failed.`;
    throw new Error(message);
}

async function runRequiredGitlabCliCommand(input: Readonly<{
    runCommand: GitlabCliCommandRunner;
    args: readonly string[];
}>): Promise<string> {
    const result = await input.runCommand({
        args: input.args,
        timeoutMs: resolveGitlabCliMrTimeoutMs(),
    });
    if (!result.success) {
        throwGitlabCliFailure(input.args.slice(0, 2).join(' '), result.stderr);
    }
    return result.stdout;
}

async function viewMergeRequest(input: Readonly<{
    provider: ScmHostingProvider;
    reference: string;
    runCommand: GitlabCliCommandRunner;
}>): Promise<ScmPullRequestSummary> {
    const stdout = await runRequiredGitlabCliCommand({
        runCommand: input.runCommand,
        args: [
            'mr',
            'view',
            input.reference,
            '--repo',
            buildRepoSelector(input.provider),
            '--output',
            'json',
        ],
    });
    const mapped = mapGitlabMergeRequest(input.provider, readJsonOutput(stdout));
    if (!mapped) {
        throw new Error('GitLab CLI returned an invalid merge request payload.');
    }
    return mapped;
}

async function writeMergeRequestBodyFile(body: string): Promise<string> {
    const path = join(tmpdir(), `happier-glab-mr-body-${randomUUID()}.md`);
    await writeFile(path, body, 'utf8');
    return path;
}

async function removeBodyFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch {
        // Best-effort cleanup only; a failed temp-file cleanup must not hide the glab result.
    }
}

export function createGitlabCliAdapter(params?: Readonly<{
    runCommand?: GitlabCliCommandRunner;
}>): ScmHostingProviderAdapter {
    const runCommand = params?.runCommand ?? runGitlabCliCommand;
    return {
        ...gitlabScmHostingProviderAdapter,
        async listOpenPullRequests(input: ScmHostingProviderListOpenPullRequestsInput) {
            const args = [
                'mr',
                'list',
                '--repo',
                buildRepoSelector(input.provider),
                '--state',
                'opened',
                '--output',
                'json',
            ];
            if (input.base) args.push('--target-branch', input.base);
            if (input.head) args.push('--source-branch', input.head);
            const stdout = await runRequiredGitlabCliCommand({ runCommand, args });
            const rawItems = readJsonOutput(stdout);
            const items = Array.isArray(rawItems) ? rawItems : [];
            return items
                .map((item) => mapGitlabMergeRequest(input.provider, item))
                .filter((item): item is ScmPullRequestSummary => item !== null);
        },
        async getPullRequest(input: ScmHostingProviderGetPullRequestInput) {
            return await viewMergeRequest({
                provider: input.provider,
                reference: String(input.number),
                runCommand,
            });
        },
        async createPullRequest(input: ScmHostingProviderCreatePullRequestInput) {
            const bodyFile = await writeMergeRequestBodyFile(input.body);
            try {
                const stdout = await runRequiredGitlabCliCommand({
                    runCommand,
                    args: [
                        'api',
                        '--hostname',
                        resolveGitlabCliHost(input.provider.baseUrl),
                        '--method',
                        'POST',
                        buildApiProjectPath(input.provider),
                        '--raw-field',
                        `source_branch=${input.head}`,
                        '--raw-field',
                        `target_branch=${input.base}`,
                        '--raw-field',
                        `title=${input.title}`,
                        '--field',
                        `description=@${bodyFile}`,
                    ],
                });
                try {
                    const mapped = mapGitlabMergeRequest(input.provider, readJsonOutput(stdout));
                    if (mapped) return mapped;
                } catch {
                    const reference = parseCreatedMergeRequestReference(stdout);
                    if (reference) {
                        return await viewMergeRequest({
                            provider: input.provider,
                            reference,
                            runCommand,
                        });
                    }
                }
                const reference = parseCreatedMergeRequestReference(stdout);
                if (!reference) {
                    throw new Error('GitLab CLI did not return a merge request payload.');
                }
                return await viewMergeRequest({
                    provider: input.provider,
                    reference,
                    runCommand,
                });
            } finally {
                await removeBodyFile(bodyFile);
            }
        },
    };
}

export const gitlabCliScmHostingProviderAdapter = createGitlabCliAdapter();
