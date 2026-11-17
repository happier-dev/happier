import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecuteFailureError, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPluginCollectionSharingActionExecuteV1 } from '@happier-dev/protocol/plugins/data/collectionSharingActionsV1';
import { createPluginCollectionSharingClientV1 } from '@happier-dev/protocol/plugins/data/collectionSharingClientV1';
import { PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, PluginCollectionContractReadResultV1Schema, PluginCollectionReadErrorV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { doesPluginCollectionContractMatchRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import { preparePluginJsonSchema, createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import axios from '@/api/client/credentialAxios';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { getRandomBytes } from '@/api/encryption';
import { openResourceDataKey } from '@/api/encryption/resourceDataKey';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { CliActionDepsParams } from './types';

type Request = Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>;
export function createCliPluginCollectionSharingActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'isCredentialCurrent'>,
  ports: Readonly<{
    serverId: string;
    serverHttpBaseUrl: string;
    admitAccount: (serverId: string, context: ActionExecutorContext) => Promise<ActionExecuteFailure | null>;
    resolveHeaders: (context: ActionExecutorContext, actionId: string, request: Request) => Promise<Readonly<Record<string, string>> | null>;
  }>,
): Pick<ActionExecutorDeps, 'pluginCollectionSharingAction'> {
  return { pluginCollectionSharingAction: async args => {
    const denied = await ports.admitAccount(ports.serverId, args.context);
    if (denied) return denied;
    const requester = readRequesterAccountActionContext(args.context.externalActionExecutionAuthorization);
    // A signed requester never inherits the daemon's Account content custody.
    const credentials = requester?.credentials ?? (args.context.externalActionExecutionAuthorization ? undefined : params.credentials);
    if (!credentials) throw createActionExecuteFailureError({ ok: false, errorCode: 'client_required', error: 'client_required' });
    const requireCurrent = async () => {
      args.signal?.throwIfAborted();
      const current = requester ? await requester.isCurrent() : !params.isCredentialCurrent || await params.isCredentialCurrent();
      if (!current) throw createActionExecuteFailureError({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    };
    const headers = async (request: Request) => {
      const authorization = await ports.resolveHeaders(args.context, args.actionId, request);
      if (!authorization) throw createActionExecuteFailureError({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
      return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization };
    };
    const request = async (path: string, body: unknown) => {
      const response = await axios.post(`${ports.serverHttpBaseUrl.replace(/\/+$/, '')}${path}`, body, {
        headers: await headers({ method: 'POST', path, body }), validateStatus: () => true,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return { status: response.status, body: response.data };
    };
    return createPluginCollectionSharingActionExecuteV1({ resolveClient: async ref => {
      await requireCurrent();
      const response = await request(PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { ref });
      await requireCurrent();
      const parsed = PluginCollectionContractReadResultV1Schema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success || !doesPluginCollectionContractMatchRefV1(parsed.data.contract, ref)) {
        const refusal = PluginCollectionReadErrorV1Schema.safeParse(response.body);
        const code = refusal.success ? refusal.data.error : 'collection_content_unavailable';
        throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code });
      }
      const storage = await resolveCliAccountStorageContext({ credentials, serverBaseUrl: ports.serverHttpBaseUrl,
        authorizationHeaders: await headers({ method: 'GET', path: '/v1/account/encryption/currentness' }),
        ...(args.signal ? { signal: args.signal } : {}) });
      await requireCurrent();
      const accountId = readAccountIdFromToken(credentials.token);
      if (!accountId) throw createActionExecuteFailureError({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
      const schema = preparePluginJsonSchema(parsed.data.contract.schema);
      const storedSchema = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(schema.jsonSchema));
      return createPluginCollectionSharingClientV1({ accountId, contract: parsed.data.contract, requireCurrent, request,
        isValidLogicalValue: (value): value is PluginCollectionLogicalValueV1 => isValidPluginJsonSchemaValue(schema.validate, value),
        parseStoredLogicalValue: value => {
          const parsed = storedSchema.safeParse(value);
          // The stored-read schema validates the admitted logical JSON object.
          return parsed.success && parsed.data !== null && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
            ? parsed.data as PluginCollectionLogicalValueV1 : null;
        },
        crypto: { accountMaterial: storage.material, randomBytes: getRandomBytes,
          openKey: async encryptedDataKey => {
            try {
              const opened = await openResourceDataKey({ credentials, mode: 'e2ee', dataEncryptionKey: encryptedDataKey });
              return opened.mode === 'e2ee' ? opened.dataKey : null;
            } catch { return null; }
          } },
      });
    } })(args);
  } };
}
