import { AGENT_IDS, getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { planAgentCliInstall } from '@happier-dev/cli-common/agents';

const PROVIDER_ID_SET = new Set(AGENT_IDS);

function resolvePlatform() {
  return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : 'unsupported';
}

function resolveProviderInstallPlan(providerId, platform) {
  if (platform === 'unsupported') {
    return { ok: false, provider: providerId, error: 'Unsupported platform' };
  }
  const planned = planAgentCliInstall({ agentId: providerId, platform });
  if (!planned.ok) {
    return { ok: false, provider: providerId, error: planned.errorMessage };
  }
  return { ok: true, provider: providerId, commands: planned.plan.commands };
}

export function resolveStackProviderRows() {
  const platform = resolvePlatform();
  return AGENT_IDS.map((id) => {
    const spec = getAgentCliRuntimeSpec(id);
    const planned = resolveProviderInstallPlan(id, platform);
    return {
      id: spec.id,
      title: spec.title,
      binaries: [spec.binaryName],
      autoInstall: planned.ok,
      note: planned.ok ? null : planned.error,
      platform: resolvePlatform(),
    };
  });
}

export function resolveStackProviderIds(input) {
  const wanted = String(input ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return wanted;
}

export function assertKnownStackProviderIds(providerIds) {
  for (const providerId of providerIds) {
    if (!PROVIDER_ID_SET.has(providerId)) {
      const error = new Error(`[providers] unknown provider: ${providerId}`);
      error.code = 'EUNKNOWN_PROVIDER';
      throw error;
    }
  }
}

export function resolveStackProviderInstallLabel(providerId) {
  const spec = getAgentCliRuntimeSpec(providerId);
  return `Installing ${spec.title || `${providerId} CLI`}`;
}

export function resolveStackProviderPlatform() {
  return resolvePlatform();
}
