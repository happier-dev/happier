import {
  SCM_OPERATION_ERROR_CODES,
  type ScmHostingProviderRef,
  type ScmOperationErrorCode,
  type ScmPullRequestReference,
  type ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import type {
  ScmHostingProviderPullRequestCreateInput,
  ScmHostingProviderPullRequestGetInput,
  ScmHostingProviderPullRequestListInput,
  ScmHostingProviderRuntimeCommandResult,
  ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';

import {
  detectGitlabCliAuth,
  type GitlabCliAuthDetectionResult,
  type GitlabCliCommandRunner,
} from './gitlabCliDetection.js';
import { withGitlabCliTempBody } from './gitlabCliTempBody.js';
import { mapGitlabMergeRequest } from './gitlabMergeRequestMapping.js';

export const GITLAB_PULL_REQUEST_AUTH_PROFILE_KEY = 'glab-cli';

const DEFAULT_GITLAB_CLI_PR_TIMEOUT_MS = 30_000;
const GITLAB_CLI_NONINTERACTIVE_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GLAB_NO_PROMPT: '1',
});

export type GitlabCliPullRequestAdapter = Readonly<{
  getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>): string | null;
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
}>;

type GitlabCliAuthDetector = (input: Readonly<{
  providerBaseUrl: string;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>) => Promise<GitlabCliAuthDetectionResult>;

class GitlabPullRequestAdapterError extends Error {
  readonly errorCode: ScmOperationErrorCode;

  constructor(message: string, errorCode: ScmOperationErrorCode) {
    super(message);
    this.name = 'GitlabPullRequestAdapterError';
    this.errorCode = errorCode;
  }
}

function createAuthRequiredError(message = 'GitLab CLI authentication is required'): GitlabPullRequestAdapterError {
  return new GitlabPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
}

function createUnsupportedError(message = 'GitLab CLI is unavailable'): GitlabPullRequestAdapterError {
  return new GitlabPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

function createCommandFailedError(message = 'GitLab CLI merge request operation failed'): GitlabPullRequestAdapterError {
  return new GitlabPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

function createNotFoundError(message = 'GitLab merge request was not found'): GitlabPullRequestAdapterError {
  return new GitlabPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
}

function defaultRunCommand(): never {
  throw createUnsupportedError('GitLab CLI command runner is unavailable');
}

function normalizeRuntimeCommandResult(result: ScmHostingProviderRuntimeCommandResult): Awaited<ReturnType<GitlabCliCommandRunner>> {
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function defaultDetectAuth(input: Readonly<{
  providerBaseUrl: string;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<GitlabCliAuthDetectionResult> {
  return detectGitlabCliAuth({
    providerBaseUrl: input.providerBaseUrl,
    runCommand: input.runtimeServices?.runCommand
      ? async (request) => normalizeRuntimeCommandResult(await input.runtimeServices?.runCommand?.(request) ?? {
        ok: false,
        stdout: '',
        stderr: 'glab command runner is unavailable',
        exitCode: null,
      })
      : undefined,
  });
}

function readGitlabHost(provider: ScmHostingProviderRef): string {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    return 'gitlab.com';
  }
}

function readProjectPath(provider: ScmHostingProviderRef): string {
  const nameWithOwner = provider.nameWithOwner?.trim();
  if (!nameWithOwner) throw createCommandFailedError('GitLab repository namespace/path is unavailable');
  const segments = nameWithOwner.split('/').filter(Boolean);
  if (segments.length < 2) throw createCommandFailedError('GitLab repository namespace/path is invalid');
  return segments.join('/');
}

function buildRepoSelector(provider: ScmHostingProviderRef): string {
  const projectPath = readProjectPath(provider);
  const host = readGitlabHost(provider);
  return host === 'gitlab.com' ? projectPath : `${provider.baseUrl.replace(/\/+$/u, '')}/${projectPath}`;
}

function encodedProjectApiPath(provider: ScmHostingProviderRef): string {
  return `projects/${encodeURIComponent(readProjectPath(provider))}/merge_requests`;
}

function readJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw createCommandFailedError('GitLab CLI returned invalid JSON');
  }
}

function tryReadJsonOutput(stdout: string): unknown | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseCreatedMergeRequestReference(stdout: string): ScmPullRequestReference | null {
  const reference = stdout
    .split(/\s+/)
    .map((part) => part.trim().replace(/^["']+|["',.;)]+$/gu, ''))
    .find((part) => /^https?:\/\//iu.test(part));
  return reference ? { url: reference } : null;
}

function readPullRequestReference(input: ScmHostingProviderPullRequestGetInput): string {
  const reference = input.reference as Readonly<{
    number?: unknown;
    url?: unknown;
    headBranch?: unknown;
  }>;
  if (typeof reference.number === 'number' && Number.isInteger(reference.number) && reference.number > 0) {
    return String(reference.number);
  }
  if (typeof reference.url === 'string') {
    const parsed = parseGitlabMergeRequestNumberFromProviderUrl(input.provider, reference.url);
    if (parsed) return String(parsed);
    throw createCommandFailedError('GitLab merge request URL is outside the detected repository');
  }
  if (typeof reference.headBranch === 'string' && reference.headBranch.trim()) {
    return reference.headBranch.trim();
  }
  throw createCommandFailedError('GitLab merge request reference is invalid');
}

function parseGitlabMergeRequestNumberFromProviderUrl(provider: ScmHostingProviderRef, url: string): number | null {
  try {
    const parsed = new URL(url);
    const providerBase = new URL(provider.baseUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== providerBase.hostname.toLowerCase()) return null;
    const providerBasePath = providerBase.pathname.replace(/\/+$/u, '');
    const projectPath = `/${readProjectPath(provider).split('/').map(encodeURIComponent).join('/')}`;
    if (!parsed.pathname.startsWith(`${providerBasePath}${projectPath}/-/merge_requests/`)) return null;
    const match = /\/-\/merge_requests\/(\d+)(?:\/)?$/u.exec(parsed.pathname);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function mapCliFailure(result: Readonly<{ stderr: string }>): never {
  const normalized = result.stderr.toLowerCase();
  if (/\b(not logged|not authenticated|authentication|authorization|auth required|credentials?)\b/.test(normalized)) {
    throw createAuthRequiredError();
  }
  if (/\b(not found|404)\b/.test(normalized)) {
    throw createNotFoundError();
  }
  throw createCommandFailedError();
}

function mapAuthFailure(auth: Exclude<GitlabCliAuthDetectionResult, { kind: 'authenticated' }>): never {
  if (auth.kind === 'missing-auth') {
    throw createAuthRequiredError(`GitLab CLI is not authenticated for ${auth.host}`);
  }
  if (auth.kind === 'missing-cli') {
    throw createUnsupportedError('GitLab CLI is not available');
  }
  throw createUnsupportedError(`GitLab CLI auth status failed for ${auth.host}`);
}

function mapListState(state: ScmHostingProviderPullRequestListInput['state']): string {
  if (state === 'closed') return 'closed';
  if (state === 'merged') return 'merged';
  return 'opened';
}

export function createGitlabCliAdapter(params?: Readonly<{
  detectAuth?: GitlabCliAuthDetector;
  runCommand?: (request: Readonly<{
    binPath: string;
    args: readonly string[];
    timeoutMs: number;
    env?: Readonly<Record<string, string>>;
  }>) => Promise<Readonly<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>>;
  timeoutMs?: number;
  withTempBody?: typeof withGitlabCliTempBody;
}>): GitlabCliPullRequestAdapter {
  const detectAuth = params?.detectAuth ?? defaultDetectAuth;
  const runCommand = params?.runCommand ?? defaultRunCommand;
  const timeoutMs = params?.timeoutMs ?? DEFAULT_GITLAB_CLI_PR_TIMEOUT_MS;
  const withTempBody = params?.withTempBody ?? withGitlabCliTempBody;

  async function resolveAuthenticatedCommand(
    provider: ScmHostingProviderRef,
    runtimeServices?: ScmHostingProviderRuntimeServices,
  ): Promise<Extract<GitlabCliAuthDetectionResult, { kind: 'authenticated' }>> {
    const auth = await detectAuth({
      providerBaseUrl: provider.baseUrl,
      ...(runtimeServices ? { runtimeServices } : {}),
    });
    if (auth.kind === 'authenticated') return auth;
    return mapAuthFailure(auth);
  }

  async function runRequired(input: Readonly<{
    provider: ScmHostingProviderRef;
    args: readonly string[];
    runtimeServices?: ScmHostingProviderRuntimeServices;
  }>): Promise<string> {
    const auth = await resolveAuthenticatedCommand(input.provider, input.runtimeServices);
    const commandRunner = input.runtimeServices?.runCommand ?? runCommand;
    const result = await commandRunner({
      binPath: auth.binPath,
      args: input.args,
      timeoutMs,
      env: GITLAB_CLI_NONINTERACTIVE_ENV,
    });
    if (!result.ok) mapCliFailure(result);
    return result.stdout;
  }

  async function getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null> {
    const stdout = await runRequired({
      provider: input.provider,
      args: [
        'mr',
        'view',
        readPullRequestReference(input),
        '--repo',
        buildRepoSelector(input.provider),
        '--output',
        'json',
      ],
      ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
    });
    const mapped = mapGitlabMergeRequest(input.provider, readJsonOutput(stdout), { includeDescription: true });
    if (!mapped) throw createCommandFailedError('GitLab CLI returned an invalid merge request payload');
    return mapped;
  }

  return Object.freeze({
    getPullRequestAuthProfileKey() {
      return GITLAB_PULL_REQUEST_AUTH_PROFILE_KEY;
    },
    async listPullRequests(input) {
      const args = [
        'mr',
        'list',
        '--repo',
        buildRepoSelector(input.provider),
        '--state',
        mapListState(input.state),
        '--output',
        'json',
      ];
      if (input.base) args.push('--target-branch', input.base);
      if (input.head) args.push('--source-branch', input.head);
      const stdout = await runRequired({
        provider: input.provider,
        args,
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      });
      const raw = readJsonOutput(stdout);
      return (Array.isArray(raw) ? raw : [])
        .map((item) => mapGitlabMergeRequest(input.provider, item))
        .filter((item): item is ScmPullRequestSummary => item !== null);
    },
    getPullRequest,
    async createPullRequest(input) {
      return withTempBody(input.body ?? '', async (descriptionField) => {
        const stdout = await runRequired({
          provider: input.provider,
          args: [
            'api',
            '--hostname',
            readGitlabHost(input.provider),
            '--method',
            'POST',
            encodedProjectApiPath(input.provider),
            '--raw-field',
            `source_branch=${input.head}`,
            '--raw-field',
            `target_branch=${input.base}`,
            '--raw-field',
            `title=${input.title}`,
            '--field',
            descriptionField,
          ],
          ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
        });
        const raw = tryReadJsonOutput(stdout);
        const pullRequest = raw
          ? mapGitlabMergeRequest(input.provider, raw, { includeDescription: true })
          : null;
        if (pullRequest) return pullRequest;
        const reference = parseCreatedMergeRequestReference(stdout);
        if (!reference) throw createCommandFailedError('GitLab CLI returned an invalid merge request payload');
        const viewed = await getPullRequest({
          provider: input.provider,
          reference,
          ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
        });
        if (!viewed) throw createCommandFailedError('GitLab CLI returned an invalid merge request payload');
        return viewed;
      });
    },
  });
}

export const gitlabCliPullRequestAdapter = createGitlabCliAdapter();
