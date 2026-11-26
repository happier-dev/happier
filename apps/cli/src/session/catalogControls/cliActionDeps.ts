import type { ResolvedSessionTransport } from '../actions/cliActionDeps/types';
import type { CliActionDepsParams, CurrentMachineControlIdentity } from '../actions/cliActionDeps/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionVendorPluginCatalogList' | 'sessionSkillCatalogList'>;

export function createCliSessionCatalogActionDeps(
  params: CliActionDepsParams,
  { callSessionRpcForTransport, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resolveTransportForSession }: Readonly<{

    callSessionRpcForTransport: (transport: ResolvedSessionTransport, methodSuffix: string, request: unknown, signal?: AbortSignal, timeoutMs?: number | null) => Promise<unknown>;
    readCurrentMachineControlIdentity: () => Promise<CurrentMachineControlIdentity>;
    readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  }>,
): FamilyActionDeps {


  const callRoutedSessionCatalogControl = async (
    sessionId: string,
    operation: 'vendorPlugins' | 'skills',
    request: Readonly<{ cwd?: string }>,
  ): Promise<unknown> => {
    const { unavailableSessionCatalog } = await import('@happier-dev/session-core/state');
    if (!params.credentials) {
      return unavailableSessionCatalog(operation, 'not_authenticated');
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return unavailableSessionCatalog(operation, transport.code);
    }

    const metadata = readTransportSessionOwnerMetadata(transport);
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    const method = operation === 'vendorPlugins'
      ? SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST
      : SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST;
    const rpcRequest = {
      ...(typeof request.cwd === 'string' && request.cwd.trim().length > 0 ? { cwd: request.cwd.trim() } : {}),
    };
    const { routeSessionCatalogControl } = await import("@/session/catalogControls/sessionCatalogControlRouter");
    return await routeSessionCatalogControl({
      ...transport,
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      operation,
      ...('cwd' in rpcRequest ? { cwd: rpcRequest.cwd } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        method,
        rpcRequest,
      ),
    });
  };
  return {

    sessionVendorPluginCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'vendorPlugins', { cwd });
    },

    sessionSkillCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'skills', { cwd });
    },
  };
}
