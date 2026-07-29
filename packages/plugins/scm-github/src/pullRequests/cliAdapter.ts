import type {
  ScmHostingProviderDefaultBranchInput,
  ScmHostingProviderDefaultBranchMetadata,
  ScmHostingProviderPullRequestCheckoutReferenceInput,
  ScmHostingProviderPullRequestCheckoutReferenceMetadata,
  ScmHostingProviderPullRequestCreateInput,
  ScmHostingProviderPullRequestGetInput,
  ScmHostingProviderPullRequestListInput,
  ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';
import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';

import { resolveGithubCheckoutReferenceFromPullRequest } from './checkoutReference.js';
import {
  detectGithubCliAuth,
  type GithubCliAuthDetectionResult,
  type GithubCliCommandRunner,
  resolveGithubCliHost,
} from './cliDetection.js';
import { mapGithubDefaultBranch } from './defaultBranch.js';
import {
  createGithubAuthRequiredError,
  createGithubCommandFailedError,
  createGithubNotFoundError,
  createGithubUnsupportedError,
} from './errors.js';
import { mapGithubPullRequest } from './mapping.js';

export type GithubCliPullRequestAdapter = Readonly<{
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
  getDefaultBranch(input: ScmHostingProviderDefaultBranchInput): Promise<ScmHostingProviderDefaultBranchMetadata>;
  resolvePullRequestCheckoutReference(
    input: ScmHostingProviderPullRequestCheckoutReferenceInput
  ): Promise<ScmHostingProviderPullRequestCheckoutReferenceMetadata>;
}>;

type GithubCliAuthDetector = (input: Readonly<{
  providerBaseUrl: string;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>) => Promise<GithubCliAuthDetectionResult>;

const DEFAULT_GITHUB_CLI_PR_TIMEOUT_MS = 30_000;
const GITHUB_CLI_EXECUTABLE = Object.freeze({ kind: 'systemTool' as const, id: 'github-cli' });
const GITHUB_CLI_NONINTERACTIVE_ENV = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
});
const GITHUB_PR_JSON_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'baseRefName',
  'headRefName',
  'headRepository',
  'headRepositoryOwner',
  'baseRefOid',
  'headRefOid',
  'author',
  'mergedAt',
  'statusCheckRollup',
].join(',');

function createRuntimeCommandRunner(
  runtimeServices?: ScmHostingProviderRuntimeServices,
): GithubCliCommandRunner | null {
  const executeCommand = runtimeServices?.executeCommand;
  if (!executeCommand) return null;
  return async (request) => await executeCommand({
    executable: GITHUB_CLI_EXECUTABLE,
    args: request.args,
    timeoutMs: request.timeoutMs,
    ...(request.env ? { env: request.env } : {}),
  });
}

function defaultDetectAuth(input: Readonly<{
  providerBaseUrl: string;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<GithubCliAuthDetectionResult> {
  const runtimeCommandRunner = createRuntimeCommandRunner(input.runtimeServices);
  return detectGithubCliAuth({
    providerBaseUrl: input.providerBaseUrl,
    resolveCommand: async () => runtimeCommandRunner
      ? { kind: 'available', source: 'system', binPath: 'github-cli' }
      : { kind: 'missing' },
    runCommand: runtimeCommandRunner ?? (async () => ({ ok: false, stdout: '', stderr: '', exitCode: null })),
  });
}

function defaultRunCommand(): never {
  throw createGithubUnsupportedError('GitHub CLI command runner is unavailable');
}

function buildRepoSelector(provider: ScmHostingProviderRef): string {
  const nameWithOwner = provider.nameWithOwner?.trim();
  if (!nameWithOwner) throw createGithubCommandFailedError('GitHub repository owner/name is unavailable');
  const host = resolveGithubCliHost(provider.baseUrl);
  return host === 'github.com' ? nameWithOwner : `${host}/${nameWithOwner}`;
}

function readNameWithOwnerSegments(provider: ScmHostingProviderRef): readonly [string, string] | null {
  const segments = provider.nameWithOwner?.split('/').map((segment) => segment.trim()).filter(Boolean);
  return segments?.length === 2 ? [segments[0]!, segments[1]!] : null;
}

function readPullRequestNumberFromProviderUrl(provider: ScmHostingProviderRef, url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== resolveGithubCliHost(provider.baseUrl)) return null;
    const nameWithOwner = readNameWithOwnerSegments(provider);
    if (!nameWithOwner) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 4) return null;
    if (segments[0]?.toLowerCase() !== nameWithOwner[0].toLowerCase()) return null;
    if (segments[1]?.toLowerCase() !== nameWithOwner[1].toLowerCase()) return null;
    if (segments[2] !== 'pull') return null;
    const number = Number(segments[3]);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function readJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw createGithubCommandFailedError('GitHub CLI returned invalid JSON');
  }
}

function parseCreatedPullRequestReference(stdout: string): string {
  const reference = stdout
    .split(/\s+/)
    .map((part) => part.trim())
    .find((part) => /^https?:\/\//i.test(part));
  if (!reference) {
    throw createGithubCommandFailedError('GitHub CLI did not return a pull request URL');
  }
  return reference;
}

function readPullRequestReference(input: ScmHostingProviderPullRequestGetInput): string {
  const reference = input.reference as Readonly<{
    number?: unknown;
    url?: unknown;
    headBranch?: unknown;
  }>;
  if (typeof reference.number === 'number') return String(reference.number);
  if (typeof reference.url === 'string') {
    const number = readPullRequestNumberFromProviderUrl(input.provider, reference.url);
    if (number !== null) return String(number);
    throw createGithubCommandFailedError('GitHub pull request URL is outside the detected repository');
  }
  if (typeof reference.headBranch === 'string') return reference.headBranch;
  throw createGithubCommandFailedError('GitHub pull request reference is invalid');
}

function mapCliFailure(stderr: string): never {
  const normalized = stderr.toLowerCase();
  if (
    /\bnot logged(?:\s+in)?\b/.test(normalized)
    || /\bauthentication\b/.test(normalized)
    || /\bauth(?:orization)?\s+(?:required|failed|needed)\b/.test(normalized)
    || /\bbad credentials\b/.test(normalized)
  ) {
    throw createGithubAuthRequiredError('GitHub CLI authentication is required');
  }
  if (normalized.includes('not found')) {
    throw createGithubNotFoundError();
  }
  throw createGithubCommandFailedError('GitHub CLI pull request operation failed');
}

export function createGithubCliAdapter(params?: Readonly<{
  detectAuth?: GithubCliAuthDetector;
  runCommand?: GithubCliCommandRunner;
  timeoutMs?: number;
}>): GithubCliPullRequestAdapter {
  const detectAuth = params?.detectAuth ?? defaultDetectAuth;
  const runCommand = params?.runCommand ?? defaultRunCommand;
  const timeoutMs = params?.timeoutMs ?? DEFAULT_GITHUB_CLI_PR_TIMEOUT_MS;

  async function resolveAuthenticatedCommand(
    provider: ScmHostingProviderRef,
    runtimeServices?: ScmHostingProviderRuntimeServices,
  ): Promise<Extract<GithubCliAuthDetectionResult, { kind: 'authenticated' }>> {
    const auth = await detectAuth({
      providerBaseUrl: provider.baseUrl,
      ...(runtimeServices ? { runtimeServices } : {}),
    });
    if (auth.kind === 'authenticated') return auth;
    if (auth.kind === 'missing-auth') throw createGithubAuthRequiredError(`GitHub CLI is not authenticated for ${auth.host}`);
    throw createGithubUnsupportedError('GitHub CLI is not available');
  }

  async function runRequired(
    provider: ScmHostingProviderRef,
    args: readonly string[],
    runtimeServices?: ScmHostingProviderRuntimeServices,
  ): Promise<string> {
    const auth = await resolveAuthenticatedCommand(provider, runtimeServices);
    const commandRunner = createRuntimeCommandRunner(runtimeServices) ?? runCommand;
    const result = await commandRunner({
      binPath: auth.binPath,
      args,
      timeoutMs,
      env: GITHUB_CLI_NONINTERACTIVE_ENV,
    });
    if (!result.ok) mapCliFailure(result.stderr);
    return result.stdout;
  }

  async function getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null> {
    const stdout = await runRequired(input.provider, [
      'pr',
      'view',
      readPullRequestReference(input),
      '--repo',
      buildRepoSelector(input.provider),
      '--json',
      GITHUB_PR_JSON_FIELDS,
    ], input.runtimeServices);
    const mapped = mapGithubPullRequest(input.provider, readJsonOutput(stdout));
    if (!mapped) throw createGithubCommandFailedError('GitHub CLI returned an invalid pull request payload');
    return mapped;
  }

  return Object.freeze({
    async listPullRequests(input) {
      const args = [
        'pr',
        'list',
        '--repo',
        buildRepoSelector(input.provider),
        '--state',
        input.state === 'closed' || input.state === 'merged' ? 'closed' : 'open',
        '--json',
        GITHUB_PR_JSON_FIELDS,
      ];
      if (input.base) args.push('--base', input.base);
      if (input.head) args.push('--head', input.head);
      const stdout = await runRequired(input.provider, args, input.runtimeServices);
      const raw = readJsonOutput(stdout);
      return (Array.isArray(raw) ? raw : [])
        .map((item) => mapGithubPullRequest(input.provider, item))
        .filter((item): item is ScmPullRequestSummary => item !== null);
    },
    getPullRequest,
    async createPullRequest(input) {
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
        input.body ?? '',
      ];
      if (input.draft) args.push('--draft');
      const stdout = await runRequired(input.provider, args, input.runtimeServices);
      const pullRequest = await getPullRequest({
        provider: input.provider,
        reference: { url: parseCreatedPullRequestReference(stdout) },
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      if (!pullRequest) throw createGithubCommandFailedError('GitHub CLI returned an invalid pull request payload');
      return pullRequest;
    },
    async getDefaultBranch(input) {
      const stdout = await runRequired(input.provider, [
        'repo',
        'view',
        buildRepoSelector(input.provider),
        '--json',
        'defaultBranchRef',
      ], input.runtimeServices);
      const mapped = mapGithubDefaultBranch(readJsonOutput(stdout));
      if (!mapped) throw createGithubCommandFailedError('GitHub CLI returned an invalid repository payload');
      return mapped;
    },
    async resolvePullRequestCheckoutReference(input) {
      const pullRequest = await getPullRequest(input);
      if (!pullRequest) throw createGithubNotFoundError();
      return resolveGithubCheckoutReferenceFromPullRequest(pullRequest);
    },
  });
}
