import {vi} from 'vitest';
import {accountSettingsParse} from '@happier-dev/protocol/account/settings/accountSettings';
import {StoredPromptLibraryRecordV1Schema} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import {deriveMarketplaceSourceId} from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';
import {BUILT_IN_REGISTRY_SOURCES_V1,type RegistrySourceV1} from '@happier-dev/protocol/registries';
import {commitActiveAccountSettingsSnapshot,getActiveAccountSettingsSnapshot,setActiveAccountSettingsSnapshot} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import * as persistence from '@/persistence';
import {readMarketplaceInstallSources} from '@/plugins/store/marketplace/service';

let revision=0;
/** A persisted Account row fixture; all source projection/admission remains production logic. */
export function publishAccountRegistrySourcesFixture(sources:readonly RegistrySourceV1[]=[],disabledSourceIds:readonly string[]=[]):void {
  const record=StoredPromptLibraryRecordV1Schema.parse({key:'registry-sources',value:{v:2,sources,disabledSourceIds}});
  const next:NonNullable<Parameters<typeof setActiveAccountSettingsSnapshot>[0]>={source:'network',scopeKey:'account-marketplace-test',settings:accountSettingsParse({}),rawSettings:{},
    settingsVersion:++revision,loadedAtMs:1,settingsSecretsReadKeys:[],promptLibraryCatalog:{status:'ready',rows:[{record,revision}],tombstones:[],diagnostics:[]}};
  if(getActiveAccountSettingsSnapshot()?.scopeKey===next.scopeKey)commitActiveAccountSettingsSnapshot(next);
  else setActiveAccountSettingsSnapshot(next);
  // Credential-file IO is a system boundary. Never let a test read an operator's real Account credentials.
  vi.spyOn(persistence,'readStoredCredentials').mockResolvedValue(null);
}
export function accountMarketplaceUserSourceFixture(input:Readonly<{sourceUrl:string;title?:string;enabled?:boolean;registryProfileId?:string|null}>):RegistrySourceV1 {
  return {id:deriveMarketplaceSourceId(input.sourceUrl),title:input.title??'Team',format:'happier-catalog',kinds:['plugin'],url:input.sourceUrl,
    enabled:input.enabled??true,addedAt:0,...(input.registryProfileId?{npmRegistryProfileId:input.registryProfileId}:{})};
}
export const curatedMarketplaceSourceFixture=()=>{
  const source=BUILT_IN_REGISTRY_SOURCES_V1.find(source=>source.format==='happier-catalog'&&!('packageContent' in source));
  if(!source||'packageContent' in source)throw new Error('Curated registry source not registered');
  return {id:source.id,title:source.title,sourceUrl:source.url,enabled:source.enabled,origin:'curated' as const};
};
export const communityMarketplaceSourceFixture=()=>{
  const source=BUILT_IN_REGISTRY_SOURCES_V1.find(source=>source.format==='happier-npm'&&!('packageContent' in source));
  if(!source||'packageContent' in source)throw new Error('Community npm registry source not registered');
  return {id:source.id,title:source.title,sourceUrl:source.url,enabled:source.enabled,origin:'community-npm' as const};
};
export async function publishMarketplaceUserBindingFixture(input:Parameters<typeof accountMarketplaceUserSourceFixture>[0]) {
  const source=accountMarketplaceUserSourceFixture(input);
  publishAccountRegistrySourcesFixture([source]);
  const projected=(await readMarketplaceInstallSources()).find(entry=>entry.id===source.id);
  if(!projected)throw new Error('Published Account user source unavailable');
  return projected;
}
