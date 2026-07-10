import {
  readSessionMetadataRuntimeDescriptor,
  type HostRuntimeControlServiceV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { readCodexAuthStoreProviderAccountId } from '../auth/accountId.js';

type RuntimeControlMaterializerInput = Readonly<{
  runtimeControl: HostRuntimeControlServiceV1;
  params: Readonly<{
    input: Readonly<{
      serviceId: string;
    }>;
    baseSelection: Readonly<Record<string, unknown>>;
  }>;
}>;

function readCodexHome(metadata: unknown): string | null {
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  return typeof runtimeDescriptor?.homePath === 'string' && runtimeDescriptor.homePath.trim().length > 0
    ? runtimeDescriptor.homePath.trim()
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRuntimeApplyGenerationControl(
  runtimeControl: HostRuntimeControlServiceV1,
): ((request: unknown) => Promise<unknown>) | null {
  const runtimeControlRecord = readRecord(runtimeControl);
  const session = readRecord(runtimeControlRecord?.session);
  const connectedServices = readRecord(runtimeControlRecord?.connectedServices);
  const candidates = [
    session?.applyConnectedServiceAuthGeneration,
    connectedServices?.applyConnectedServiceAuthGeneration,
    connectedServices?.applyGeneration,
  ];
  const apply = candidates.find((candidate) => typeof candidate === 'function');
  return typeof apply === 'function'
    ? async (request) => await apply(request)
    : null;
}

function normalizeRuntimeControlResult(value: unknown): unknown {
  const result = readRecord(value);
  if (result?.ok === true && Object.prototype.hasOwnProperty.call(result, 'value')) {
    return result.value;
  }
  if (result?.ok === false) {
    throwRuntimeControlFailure(result as Readonly<{ error?: string; code?: string }>);
  }
  return value;
}

function throwRuntimeControlFailure(result: Readonly<{ error?: string; code?: string }>): never {
  throw new Error(result.error ?? result.code ?? 'runtime_control_failed');
}

export async function materializeCodexConnectedServiceRuntimeAuthSelection(
  input: RuntimeControlMaterializerInput,
): Promise<unknown | null> {
  if (input.params.input.serviceId !== 'openai-codex') return input.params.baseSelection;

  const runtimeApplyGeneration = readRuntimeApplyGenerationControl(input.runtimeControl);
  const codexHome = readCodexHome(input.runtimeControl.context.metadata);
  const baseSelection = {
    ...input.params.baseSelection,
    ...(runtimeApplyGeneration
      ? {
          applyConnectedServiceAuthGeneration: async (request: unknown) =>
            normalizeRuntimeControlResult(await runtimeApplyGeneration(request)),
        }
      : {}),
    ...(codexHome
      ? {
          readAuthStoreProviderAccountId: async () => await readCodexAuthStoreProviderAccountId(codexHome),
        }
      : {}),
  };

  if (runtimeApplyGeneration) return baseSelection;

  const [appServer, transport] = await Promise.all([
    input.runtimeControl.appServer.checkAvailable(),
    input.runtimeControl.session.checkConnectedServiceAuthTransportInvalidation(),
  ]);
  if (!appServer.ok || !transport.ok) return input.params.baseSelection;

  return {
    ...baseSelection,
    client: {
      request: async (method: string, params: unknown) => {
        const result = await input.runtimeControl.appServer.request({ method, params });
        if (!result.ok) throwRuntimeControlFailure(result);
        return result.value;
      },
    },
    ...(codexHome
      ? {
          readAuthStoreProviderAccountId: async () => await readCodexAuthStoreProviderAccountId(codexHome),
        }
      : {}),
    invalidateTransports: async () => {
      const result = await input.runtimeControl.session.invalidateConnectedServiceAuthTransports();
      if (!result.ok) throwRuntimeControlFailure(result);
    },
  };
}
