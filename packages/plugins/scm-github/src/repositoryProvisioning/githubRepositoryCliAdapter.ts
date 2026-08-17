import type {
  HostingProviderRepositoryCreateInput as ScmHostingProviderRepositoryCreateInput,
  HostingProviderRepositoryDescribePublishTargetsInput as ScmHostingProviderRepositoryDescribePublishTargetsInput,
  HostingProviderRepositoryDescribePublishTargetsResult as ScmHostingProviderRepositoryDescribePublishTargetsResult,
  HostingProviderRepositoryGetInput as ScmHostingProviderRepositoryGetInput,
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositoryPublishTarget,
  ScmHostingRepositorySummary,
} from '@happier-dev/plugin-sdk/scm';

import {
  createGithubRepositoryAuthRequiredError,
  createGithubRepositoryCommandFailedError,
  createGithubRepositoryNotFoundError,
  createGithubRepositoryUnsupportedError,
} from './githubRepositoryErrors.js';
import {
  detectGithubRepositoryCliAuth,
  resolveGithubRepositoryCliHost,
  type GithubRepositoryCliAuthDetectionResult,
  type GithubRepositoryCliCommandRunner,
} from './githubRepositoryCliAuth.js';
import { mapGithubRepositorySummary } from './githubRepositoryMapping.js';

export type GithubRepositoryCliAdapter = Readonly<{
  describePublishTargets(
    input: ScmHostingProviderRepositoryDescribePublishTargetsInput
  ): Promise<ScmHostingProviderRepositoryDescribePublishTargetsResult>;
  createRepository(input: ScmHostingProviderRepositoryCreateInput): Promise<ScmHostingRepositorySummary>;
  getRepository(input: ScmHostingProviderRepositoryGetInput): Promise<ScmHostingRepositorySummary | null>;
}>;

type GithubRepositoryCliAuthDetector = (input: Readonly<{
  providerBaseUrl: string;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>) => Promise<GithubRepositoryCliAuthDetectionResult>;

const DEFAULT_GITHUB_REPOSITORY_CLI_TIMEOUT_MS = 30_000;
const GITHUB_CLI_EXECUTABLE = Object.freeze({ kind: 'systemTool' as const, id: 'github-cli' });
const GITHUB_CLI_NONINTERACTIVE_ENV = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
});
const GITHUB_REPOSITORY_JSON_FIELDS = 'nameWithOwner,url,sshUrl,defaultBranchRef,visibility';

function createRuntimeCommandRunner(
  runtimeServices?: ScmHostingProviderRuntimeServices,
): GithubRepositoryCliCommandRunner | null {
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
}>): Promise<GithubRepositoryCliAuthDetectionResult> {
  const runtimeCommandRunner = createRuntimeCommandRunner(input.runtimeServices);
  return detectGithubRepositoryCliAuth({
    providerBaseUrl: input.providerBaseUrl,
    resolveCommand: async () => runtimeCommandRunner
      ? { kind: 'available', source: 'system', binPath: 'github-cli' }
      : { kind: 'missing' },
    runCommand: runtimeCommandRunner ?? (async () => ({ ok: false, stdout: '', stderr: '', exitCode: null })),
  });
}

function defaultRunCommand(): never {
  throw createGithubRepositoryUnsupportedError('GitHub CLI command runner is unavailable');
}

function readJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw createGithubRepositoryCommandFailedError('GitHub CLI returned invalid JSON');
  }
}

function readLogin(raw: unknown): string | null {
  return Boolean(raw)
    && typeof raw === 'object'
    && !Array.isArray(raw)
    && typeof (raw as { login?: unknown }).login === 'string'
    && (raw as { login: string }).login.trim()
    ? (raw as { login: string }).login.trim()
    : null;
}

function readLabel(raw: unknown, fallback: string): string {
  if (Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = (raw as { name?: unknown }).name;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function buildCreateSelector(input: ScmHostingProviderRepositoryCreateInput): string {
  const nameWithOwner = `${input.owner.trim()}/${input.repositoryName.trim()}`;
  const host = resolveGithubRepositoryCliHost(input.provider.baseUrl);
  return host === 'github.com' ? nameWithOwner : `${host}/${nameWithOwner}`;
}

function buildViewSelector(input: Readonly<{
  provider: ScmHostingProviderRef;
  owner: string;
  repositoryName: string;
}>): string {
  const nameWithOwner = `${input.owner.trim()}/${input.repositoryName.trim()}`;
  const host = resolveGithubRepositoryCliHost(input.provider.baseUrl);
  return host === 'github.com' ? nameWithOwner : `${host}/${nameWithOwner}`;
}

function mapCliFailure(stderr: string): never {
  const normalized = stderr.toLowerCase();
  if (
    /\bnot logged(?:\s+in)?\b/.test(normalized)
    || /\bauthentication\b/.test(normalized)
    || /\bauth(?:orization)?\s+(?:required|failed|needed)\b/.test(normalized)
    || /\bbad credentials\b/.test(normalized)
  ) {
    throw createGithubRepositoryAuthRequiredError('GitHub CLI authentication is required');
  }
  if (normalized.includes('not found') || normalized.includes('404')) {
    throw createGithubRepositoryNotFoundError();
  }
  throw createGithubRepositoryCommandFailedError('GitHub CLI repository operation failed');
}

function parseCreatedRepositoryUrl(stdout: string): string | null {
  return stdout
    .split(/\s+/)
    .map((part) => part.trim())
    .find((part) => /^https?:\/\//i.test(part)) ?? null;
}

function createAuthSummary(): ScmHostingRepositoryAuthSummary {
  return {
    state: 'authenticated',
    profileKind: 'provider_cli',
  };
}

function createTarget(input: Readonly<{
  provider: ScmHostingProviderRef;
  owner: string;
  ownerKind: 'user' | 'org';
  label: string;
}>): ScmHostingRepositoryPublishTarget {
  return {
    provider: input.provider,
    owner: input.owner,
    ownerKind: input.ownerKind,
    label: input.label,
    ...(input.ownerKind === 'user' ? { isDefault: true } : {}),
    supportedVisibilities: input.ownerKind === 'org'
      ? ['private', 'public', 'internal']
      : ['private', 'public'],
    supportedRemoteUrlKinds: ['https', 'ssh'],
    auth: createAuthSummary(),
  };
}

function visibilityFlag(visibility: ScmHostingProviderRepositoryCreateInput['visibility']): string {
  if (visibility === 'public') return '--public';
  if (visibility === 'internal') return '--internal';
  return '--private';
}

export function createGithubRepositoryCliAdapter(params?: Readonly<{
  detectAuth?: GithubRepositoryCliAuthDetector;
  runCommand?: GithubRepositoryCliCommandRunner;
  timeoutMs?: number;
}>): GithubRepositoryCliAdapter {
  const detectAuth = params?.detectAuth ?? defaultDetectAuth;
  const runCommand = params?.runCommand ?? defaultRunCommand;
  const timeoutMs = params?.timeoutMs ?? DEFAULT_GITHUB_REPOSITORY_CLI_TIMEOUT_MS;

  async function resolveAuthenticatedCommand(
    provider: ScmHostingProviderRef,
    runtimeServices?: ScmHostingProviderRuntimeServices,
  ): Promise<Extract<GithubRepositoryCliAuthDetectionResult, { kind: 'authenticated' }>> {
    const auth = await detectAuth({
      providerBaseUrl: provider.baseUrl,
      ...(runtimeServices ? { runtimeServices } : {}),
    });
    if (auth.kind === 'authenticated') return auth;
    if (auth.kind === 'missing-auth') throw createGithubRepositoryAuthRequiredError(`GitHub CLI is not authenticated for ${auth.host}`);
    throw createGithubRepositoryUnsupportedError('GitHub CLI is not available');
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

  return Object.freeze({
    async describePublishTargets(input) {
      const host = resolveGithubRepositoryCliHost(input.provider.baseUrl);
      const userRaw = readJsonOutput(await runRequired(input.provider, ['api', 'user', '--hostname', host], input.runtimeServices));
      const orgsRaw = readJsonOutput(await runRequired(input.provider, ['api', 'user/orgs', '--hostname', host], input.runtimeServices));
      const targets: ScmHostingRepositoryPublishTarget[] = [];
      const userLogin = readLogin(userRaw);
      if (userLogin) {
        targets.push(createTarget({
          provider: input.provider,
          owner: userLogin,
          ownerKind: 'user',
          label: readLabel(userRaw, userLogin),
        }));
      }
      if (Array.isArray(orgsRaw)) {
        for (const org of orgsRaw) {
          const owner = readLogin(org);
          if (!owner) continue;
          targets.push(createTarget({
            provider: input.provider,
            owner,
            ownerKind: 'org',
            label: readLabel(org, owner),
          }));
        }
      }
      return {
        auth: createAuthSummary(),
        targets,
      };
    },
    async createRepository(input) {
      const description = input.description?.trim();
      const args = [
        'repo',
        'create',
        buildCreateSelector(input),
        visibilityFlag(input.visibility),
      ];
      if (description) args.push('--description', description);
      // Audit fence: provider-owned gh repo create; local Git mutation stays in SCM-REPO-4.
      const stdout = await runRequired(input.provider, args, input.runtimeServices);
      const webUrl = parseCreatedRepositoryUrl(stdout);
      const mapped = mapGithubRepositorySummary({
        provider: input.provider,
        raw: {
          nameWithOwner: `${input.owner}/${input.repositoryName}`,
          ...(webUrl ? { url: webUrl } : {}),
          visibility: input.visibility,
        },
        fallbackNameWithOwner: `${input.owner}/${input.repositoryName}`,
        fallbackWebUrl: webUrl ?? undefined,
        fallbackVisibility: input.visibility,
      });
      if (!mapped) throw createGithubRepositoryCommandFailedError('GitHub CLI did not return a repository URL');
      return mapped;
    },
    async getRepository(input) {
      const auth = await resolveAuthenticatedCommand(input.provider, input.runtimeServices);
      const commandRunner = createRuntimeCommandRunner(input.runtimeServices) ?? runCommand;
      const result = await commandRunner({
        binPath: auth.binPath,
        // Audit fence: provider-owned gh repo view for repository descriptions.
        args: [
          'repo',
          'view',
          buildViewSelector(input),
          '--json',
          GITHUB_REPOSITORY_JSON_FIELDS,
        ],
        timeoutMs,
        env: GITHUB_CLI_NONINTERACTIVE_ENV,
      });
      if (!result.ok) {
        try {
          mapCliFailure(result.stderr);
        } catch (error) {
          if (Boolean(error)
            && typeof error === 'object'
            && (error as { errorCode?: unknown }).errorCode === 'REMOTE_NOT_FOUND') {
            return null;
          }
          throw error;
        }
      }
      const mapped = mapGithubRepositorySummary({
        provider: input.provider,
        raw: readJsonOutput(result.stdout),
        fallbackNameWithOwner: `${input.owner}/${input.repositoryName}`,
      });
      if (!mapped) throw createGithubRepositoryCommandFailedError('GitHub CLI returned an invalid repository payload');
      return mapped;
    },
  });
}
