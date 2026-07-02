import type { HostRuntimeControlServiceV1 } from '@happier-dev/agents';
import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';

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

function throwRuntimeControlFailure(result: Readonly<{ error?: string; code?: string }>): never {
  throw new Error(result.error ?? result.code ?? 'runtime_control_failed');
}

export async function materializeCodexConnectedServiceRuntimeAuthSelection(
  input: RuntimeControlMaterializerInput,
): Promise<unknown | null> {
  if (input.params.input.serviceId !== 'openai-codex') return input.params.baseSelection;

  const [appServer, transport] = await Promise.all([
    input.runtimeControl.appServer.checkAvailable(),
    input.runtimeControl.session.checkConnectedServiceAuthTransportInvalidation(),
  ]);
  if (!appServer.ok || !transport.ok) return input.params.baseSelection;

  const codexHome = readCodexHome(input.runtimeControl.context.metadata);
  return {
    ...input.params.baseSelection,
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
