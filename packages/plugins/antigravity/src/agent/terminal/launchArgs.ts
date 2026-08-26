import type { AgentTerminalSurface } from '@happier-dev/plugin-sdk/agents/runtime';
import { readCanonicalAntigravityRuntimeDescriptorV1 } from '../runtime/runtimeDescriptor.js';

export type AntigravityTerminalLaunchArgsInput = Readonly<{
  conversationId?: string | null;
  modelId?: string | null;
}>;

function readModelIdCandidate(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized === 'default') return null;
  return normalized;
}

export function resolveAntigravityTerminalLaunchArgsInput(
  metadata: Readonly<Record<string, unknown>>,
  modelSelection: Parameters<AgentTerminalSurface['resolveLaunch']>[0]['modelSelection'],
): AntigravityTerminalLaunchArgsInput {
  const runtimeDescriptor = metadata.runtimeDescriptorV1
    ? readCanonicalAntigravityRuntimeDescriptorV1(metadata.runtimeDescriptorV1)
    : null;
  return {
    conversationId: runtimeDescriptor?.providerSessionId ?? null,
    modelId: readModelIdCandidate(modelSelection?.modelId),
  };
}

function readNonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function readSelectedModelId(value: string | null | undefined): string | null {
  const normalized = readNonEmpty(value);
  return normalized && normalized !== 'default' ? normalized : null;
}

export function buildAntigravityTerminalLaunchArgs(input: AntigravityTerminalLaunchArgsInput = {}): string[] {
  const args: string[] = [];
  const conversationId = readNonEmpty(input.conversationId);
  if (conversationId) {
    args.push('--conversation', conversationId);
  }

  const modelId = readSelectedModelId(input.modelId);
  if (modelId) {
    args.push('--model', modelId);
  }

  return args;
}
