import { createRegistryHostV1,listRegistrySourcesV1,createPluginRegistrySourceDescriptorV1,RegistryFetchErrorV1,type RegistrySourceDescriptorV1, type RegistryHostDepsV1 } from '@happier-dev/protocol/registries';
import { createCliRegistryBotTemplateReaderV1 } from './botTemplates';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readPromptLibraryCatalogRecordV1,updatePromptLibraryRegistrySourcesV1,type PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { StoredCredentials } from '@/persistence';
import { createRegistryHttpV1 } from './registryHttp';
import { createRegistryGitProtocolV1 } from './gitProtocol';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { readSavedSecretMaterializerForOperation, SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { resolveValueRefPlaintext } from '@/settings/valueRefs/resolveValueRefPlaintext';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliRegistryPackageContentV1 } from './packageContent';
import { createAppCatalogReadsV1 } from './appCatalogReads';
import { readRegistryConnectedAccountTokenV1 } from './connectedAccountToken';

/** One Account snapshot source projection, shared by daemon fetch and later marketplace exact review. */
export async function readCliRegistrySourcesV1(input:Readonly<{credentials?:StoredCredentials;serverHttpBaseUrl?:string;port?:PromptLibraryStackActionPortV1;signal?:AbortSignal;pluginRuntime?:PluginReloadController}>={}):Promise<readonly RegistrySourceDescriptorV1[]> {
  input.signal?.throwIfAborted();
  const snapshot=input.port?await input.port.readCatalog(input.signal,'registry-sources'):null;
  const active=input.port?null:getActiveAccountSettingsSnapshot();
  const read=readPromptLibraryCatalogRecordV1(snapshot?{...snapshot,key:'registry-sources'}:{catalog:active?.promptLibraryCatalog??{status:'loading'},rawSettings:active?.rawSettings,key:'registry-sources'});
  if(read.status!=='ready'||read.record.key!=='registry-sources')throw new RegistryFetchErrorV1({state:'unreachable'});
  const registry=await resolveMergedContributionRegistry(input.credentials?{accountStorageDependencies:{
    readCredentials:async()=>input.credentials??null,
    resolveBaseUrl:()=>input.serverHttpBaseUrl??resolveServerHttpBaseUrl(),
  }}:undefined);
  input.signal?.throwIfAborted();input.port?.assertCurrent();
  const pluginSources=new Map<string,RegistrySourceDescriptorV1>();
  for(const entry of registry.registrySources??[]) {
    if('packageContent' in entry.definition)continue;
    const source=createPluginRegistrySourceDescriptorV1({pluginId:entry.pluginId,definition:entry.definition,suppliers:[]});
    pluginSources.set(source.id,source);
  }
  const controller=input.pluginRuntime??pluginReloadController;
  const lease=controller.tryAcquireRuntimeRegistry();
  try {
    if(lease&&controller.isRuntimeRegistryCurrent(lease.registry)) {
      for(const entry of lease.registry.contributes.registrySources??[]) {
        const occurrenceId=lease.registry.contributes.occurrenceIdsByPluginId?.[entry.pluginId];
        if(!entry.definition.kinds.some(kind=>kind==='app')||!entry.pluginVersion||!occurrenceId)continue;
        const source=createPluginRegistrySourceDescriptorV1({pluginId:entry.pluginId,pluginVersion:entry.pluginVersion,occurrenceId,
          definition:entry.definition,suppliers:[]});
        pluginSources.set(source.id,source);
      }
    }
    return listRegistrySourcesV1({record:read.record.value,pluginSources:[...pluginSources.values()]});
  } finally { await lease?.release(); }
}
export function createCliRegistryHostV1(input:Readonly<{credentials?:StoredCredentials;port?:PromptLibraryStackActionPortV1;signal?:AbortSignal;
  /** Runner commitments supply their admitted read-only source inventory. */
  readSources?:()=>Promise<readonly RegistrySourceDescriptorV1[]>;
  pluginRuntime?:PluginReloadController;
  secretSources?:TargetSecretSourcesV1;
  operationContext?:SavedSecretOperationContextV1;machineAdmission?:SocketRpcMachineAdmissionContextV1;
  actionContext?:Pick<ActionExecutorContext,'externalActionExecutionAuthorization'|'externalActionCredential'>;
  updates?: RegistryHostDepsV1['updates']}>={}) {
  const operation=input.operationContext;
  const credentials=operation?.credentials??input.credentials;
  const scopeKey=credentials?(operation?runWithServerHttpBaseUrl(operation.serverHttpBaseUrl,()=>resolveAccountSettingsScopeKey(credentials))
    :resolveAccountSettingsScopeKey(credentials)):null;
  let port=input.port;
  const resolvePort=async()=>{
    if(operation&&(!await operation.isCurrent()||operation.readSnapshot()?.scopeKey!==scopeKey
      ||input.credentials&&input.credentials.token!==operation.credentials.token))throw new RegistryFetchErrorV1({state:'auth_failed'});
    if(port||!credentials)return port;
    if(!operation&&getActiveAccountSettingsSnapshot()?.scopeKey!==scopeKey
      &&!await warmActiveAccountSettingsSnapshotBestEffort({credentials,logger}))throw new RegistryFetchErrorV1({state:'unreachable'});
    const store=createCliPromptLibraryStore({credentials,signal:input.signal,operationContext:operation});
    port={serverId:'',assertCurrent:store.assertCurrent,readCatalog:store.readCatalog,writeRecord:store.writeRecord};
    return port;
  };
  const readSources=input.readSources??(async()=>readCliRegistrySourcesV1({credentials,serverHttpBaseUrl:operation?.serverHttpBaseUrl??resolveServerHttpBaseUrl(),port:await resolvePort(),signal:input.signal,pluginRuntime:input.pluginRuntime}));
  const resolveToken=async(source:import('@happier-dev/protocol/registries').RegistrySourceV1)=>{
    const reference=source.token?.secretRef;
    if(!reference){
      if(!credentials)return null;
      await resolvePort();
      const snapshot=operation?operation.readSnapshot():getActiveAccountSettingsSnapshot();
      if(!snapshot||snapshot.scopeKey!==scopeKey)return null;
      const lifetime=getActiveAccountSettingsSnapshotLifetimeToken();
      const accountOperation=operation??createInvocationSavedSecretOperationContextV1({credentials,snapshot,
        serverHttpBaseUrl:resolveServerHttpBaseUrl(),machineAdmission:input.machineAdmission,
        isCurrent:async()=>getActiveAccountSettingsSnapshotLifetimeToken()===lifetime
          &&getActiveAccountSettingsSnapshot()?.scopeKey===scopeKey});
      return readRegistryConnectedAccountTokenV1({source,operationContext:accountOperation,
        controller:input.pluginRuntime??pluginReloadController,signal:input.signal});
    }
    // A shared Machine grant does not lend the custodian's private Account
    // credential. Only authenticated ingress supplies this fact.
    if(input.machineAdmission&&input.machineAdmission.actorAccountId!==input.machineAdmission.custodianAccountId)
      throw new RegistryFetchErrorV1({state:'auth_failed'});
    const snapshot=operation?operation.readSnapshot():getActiveAccountSettingsSnapshot();
    const expectedScopeKey=scopeKey??snapshot?.scopeKey;if(!expectedScopeKey)return null;
    if(credentials)await resolvePort();
    try {
      const read = () => readSavedSecretMaterializerForOperation({ expectedScopeKey,
        references: [{ ref: reference }], signal: input.signal, operationContext: operation, secretSources: input.secretSources });
      const admitted = operation ? await runWithServerHttpBaseUrl(operation.serverHttpBaseUrl, read) : await read();
      const value=resolveValueRefPlaintext({valueRef:{t:'savedSecret',secretId:reference},
        savedSecretMaterializer:admitted.materializer,processEnv:{}});
      return value.status==='ready'?value.value:null;
    } catch(error) { if(error instanceof SavedSecretOperationAdmissionError)return null;throw error; }
  };
  const createFetchContext = (resolve: typeof resolveToken) => ({ signal: input.signal,
    withAppCatalog: createAppCatalogReadsV1(scopeKey, {
      http: createRegistryHttpV1({resolveToken:resolve}), signal: input.signal,
    }),
    http: createRegistryHttpV1({signal:input.signal,resolveToken:resolve}),
    packageContent:createCliRegistryPackageContentV1(input),
    git: createRegistryGitProtocolV1({signal:input.signal,resolveToken:async source=>{
      const credential=await resolve(source);return typeof credential==='string'?credential:credential?.value??null;
    }}) });
  const baseContext = createFetchContext(resolveToken);
  const admitSource: NonNullable<RegistryHostDepsV1['admitSource']> = async source => {
    if ('packageContent' in source) return baseContext;
    const value = await resolveToken(source);
    if (value === null && source.token) throw new RegistryFetchErrorV1({state:'auth_failed'});
    return createFetchContext(async selected => selected.url === source.url
      && selected.token?.secretRef === source.token?.secretRef ? value : null);
  };
  const fetchContext = { ...baseContext, admitSource };
  const host=createRegistryHostV1({host:'node',...fetchContext,
    readPluginBotTemplates: createCliRegistryBotTemplateReaderV1({ actionContext: input.actionContext }),
    readSources, updates: input.updates,
    ...(input.port||credentials?{mutateSources:async(mutation:Parameters<typeof updatePromptLibraryRegistrySourcesV1>[1])=>{
      const current=await resolvePort();if(!current)return {status:'unavailable' as const,reason:'account_credentials_unavailable'};
      return updatePromptLibraryRegistrySourcesV1(current,mutation,input.signal);
    }}:{}),
  });
  return {...host,readSources,fetchContext};
}
