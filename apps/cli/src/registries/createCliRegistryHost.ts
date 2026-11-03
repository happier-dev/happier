import { createRegistryHostV1,listRegistrySourcesV1,createPluginRegistrySourceDescriptorV1,RegistryFetchErrorV1,type RegistrySourceDescriptorV1, type RegistryHostDepsV1 } from '@happier-dev/protocol/registries';
import { readPromptLibraryCatalogRecordV1,updatePromptLibraryRegistrySourcesV1,type PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { StoredCredentials } from '@/persistence';
import { createRegistryHttpV1 } from './registryHttp';
import { createRegistryGitProtocolV1 } from './gitProtocol';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { readSavedSecretMaterializerForOperation, SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { resolveValueRefPlaintext } from '@/settings/valueRefs/resolveValueRefPlaintext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';

/** One Account snapshot source projection, shared by daemon fetch and later marketplace exact review. */
export async function readCliRegistrySourcesV1(input:Readonly<{port?:PromptLibraryStackActionPortV1;signal?:AbortSignal}>={}):Promise<readonly RegistrySourceDescriptorV1[]> {
  input.signal?.throwIfAborted();
  const snapshot=input.port?await input.port.readCatalog(input.signal,'registry-sources'):null;
  const active=input.port?null:getActiveAccountSettingsSnapshot();
  const read=readPromptLibraryCatalogRecordV1(snapshot?{...snapshot,key:'registry-sources'}:{catalog:active?.promptLibraryCatalog??{status:'loading'},rawSettings:active?.rawSettings,key:'registry-sources'});
  if(read.status!=='ready'||read.record.key!=='registry-sources')throw new RegistryFetchErrorV1({state:'unreachable'});
  const registry=await resolveMergedContributionRegistry();
  input.signal?.throwIfAborted();input.port?.assertCurrent();
  return listRegistrySourcesV1({record:read.record.value,pluginSources:(registry.registrySources??[]).map(entry=>
    createPluginRegistrySourceDescriptorV1({pluginId:entry.pluginId,definition:entry.definition,suppliers:[]}))});
}
export function createCliRegistryHostV1(input:Readonly<{credentials?:StoredCredentials;port?:PromptLibraryStackActionPortV1;signal?:AbortSignal;
  secretSources?:TargetSecretSourcesV1;
  readSources?:()=>Promise<readonly RegistrySourceDescriptorV1[]>;
  operationContext?:SavedSecretOperationContextV1;machineAdmission?:SocketRpcMachineAdmissionContextV1;
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
  const readSources=input.readSources??(async()=>readCliRegistrySourcesV1({port:await resolvePort(),signal:input.signal}));
  const resolveToken=async(source:import('@happier-dev/protocol/registries').RegistrySourceV1)=>{
    const reference=source.token?.secretRef;if(!reference)return null;
    // A shared Machine grant reaches public registries, not the custodian's
    // private Account credential. Only authenticated ingress supplies this fact.
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
    http: createRegistryHttpV1({signal:input.signal,resolveToken:resolve}),
    git: createRegistryGitProtocolV1({signal:input.signal,resolveToken:resolve}) });
  const baseContext = createFetchContext(resolveToken);
  const admitSource: NonNullable<RegistryHostDepsV1['admitSource']> = async source => {
    if ('packageContent' in source || !source.token) return baseContext;
    const value = await resolveToken(source);
    if (value === null) throw new RegistryFetchErrorV1({state:'auth_failed'});
    const reference = source.token.secretRef;
    return createFetchContext(async selected => selected.token?.secretRef === reference ? value : null);
  };
  const fetchContext = { ...baseContext, admitSource };
  const host=createRegistryHostV1({host:'node',...fetchContext,
    readSources, updates: input.updates,
    ...(input.port||credentials?{mutateSources:async(mutation:Parameters<typeof updatePromptLibraryRegistrySourcesV1>[1])=>{
      const current=await resolvePort();if(!current)return {status:'unavailable' as const,reason:'account_credentials_unavailable'};
      return updatePromptLibraryRegistrySourcesV1(current,mutation,input.signal);
    }}:{}),
  });
  return {...host,readSources,fetchContext};
}
