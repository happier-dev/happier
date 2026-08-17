import type {
  ScmRefreshPolicy as ProviderRefreshPolicy,
  ScmRepoMode,
} from '@happier-dev/plugin-sdk/scm';
import type {
  ScmBackendCapabilities,
  ScmBackendCapabilityLeaf,
  ScmBackendCapabilityUnavailableReason } from '@happier-dev/plugin-sdk/scm/backend';

type ResolveScmBackendCapabilitiesInput = Readonly<{
  declaredCapabilities: ScmBackendCapabilities;
  mode: ScmRepoMode | null;
  supportedRepoModes?: readonly ScmRepoMode[];
  executableAvailable?: boolean;
  freshness?: Readonly<{
    state?: ScmBackendCapabilities['freshness']['state'];
    refreshPolicy?: ProviderRefreshPolicy;
  }>;
}>;

const DEFAULT_SUPPORTED_REPO_MODES: readonly ScmRepoMode[] = ['.git'];

function isCapabilityLeaf(value: unknown): value is ScmBackendCapabilityLeaf {
  return Boolean(
    value
    && typeof value === 'object'
    && 'support' in value
    && typeof (value as { support?: unknown }).support === 'string',
  );
}

function makeUnavailableLeaf(
  leaf: ScmBackendCapabilityLeaf,
  reason: ScmBackendCapabilityUnavailableReason,
): ScmBackendCapabilityLeaf {
  if (leaf.support === 'unsupported') return leaf;
  return {
    support: 'unsupported',
    reason,
    declaredSupport: leaf.support,
  };
}

function withUnavailableLeaves<T extends Record<string, unknown>>(
  group: T,
  reason: ScmBackendCapabilityUnavailableReason,
): T {
  return Object.fromEntries(
    Object.entries(group).map(([key, value]) => [
      key,
      isCapabilityLeaf(value) ? makeUnavailableLeaf(value, reason) : value,
    ]),
  ) as T;
}

export function resolveScmBackendCapabilities(
  input: ResolveScmBackendCapabilitiesInput,
): ScmBackendCapabilities {
  const supportedRepoModes = input.supportedRepoModes ?? DEFAULT_SUPPORTED_REPO_MODES;
  const repoModeSupported = input.mode !== null && supportedRepoModes.includes(input.mode);
  const executableReason: ScmBackendCapabilityUnavailableReason | null =
    input.executableAvailable === false ? 'tool_missing' : null;
  const leafUnavailableReason: ScmBackendCapabilityUnavailableReason | null =
    executableReason ?? (repoModeSupported ? null : 'repo_mode_unsupported');

  const resolved: ScmBackendCapabilities = {
    ...input.declaredCapabilities,
    detection: {
      ...input.declaredCapabilities.detection,
      ...(input.declaredCapabilities.detection.repository && !repoModeSupported
        ? {
          repository: makeUnavailableLeaf(
            input.declaredCapabilities.detection.repository,
            'repo_mode_unsupported',
          ),
        }
        : {}),
      ...(input.declaredCapabilities.detection.executable && executableReason
        ? {
          executable: makeUnavailableLeaf(input.declaredCapabilities.detection.executable, executableReason),
        }
        : {}),
    },
    freshness: {
      ...input.declaredCapabilities.freshness,
      ...(input.freshness?.state ? { state: input.freshness.state } : {}),
      ...(input.freshness?.refreshPolicy ? { refreshPolicy: input.freshness.refreshPolicy } : {}),
    },
  };

  if (!leafUnavailableReason) return resolved;

  return {
    ...resolved,
    read: withUnavailableLeaves(resolved.read, leafUnavailableReason),
    changeSet: withUnavailableLeaves(resolved.changeSet, leafUnavailableReason),
    commit: withUnavailableLeaves(resolved.commit, leafUnavailableReason),
    remote: withUnavailableLeaves(resolved.remote, leafUnavailableReason),
    branch: withUnavailableLeaves(resolved.branch, leafUnavailableReason),
    worktree: withUnavailableLeaves(resolved.worktree, leafUnavailableReason),
    lifecycle: withUnavailableLeaves(resolved.lifecycle, leafUnavailableReason),
    hosting: withUnavailableLeaves(resolved.hosting, leafUnavailableReason),
    checkpoints: withUnavailableLeaves(resolved.checkpoints, leafUnavailableReason),
    workspaceIntegration: withUnavailableLeaves(resolved.workspaceIntegration, leafUnavailableReason),
    tooling: withUnavailableLeaves(resolved.tooling, leafUnavailableReason),
  };
}
