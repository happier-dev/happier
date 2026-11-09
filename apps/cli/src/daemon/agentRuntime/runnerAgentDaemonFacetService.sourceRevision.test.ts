import { expect, it } from 'vitest';
import { accountSettingsParse, ingestPluginManifestV2 } from '@happier-dev/protocol';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { createExternalSessionFollowTargetHostOperation } from '@/session/external/followTargetHostOperation';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { createRunnerAgentDaemonFacetService } from './runnerAgentDaemonFacetService';
import { RunnerAgentDaemonFacetOperationV1Schema, RunnerAgentDaemonFacetResultV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonFacetProtocol';

it('admits provider source following through the daemon facet with the configured-source Account revision', async () => {
  setActiveAccountSettingsSnapshot({ source:'network',settings:accountSettingsParse({}),settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],scopeKey:'source-test' });
  const owner=createExternalSessionHostOperationOwner();
  const binding=createAgentSessionRunnerFactoryBinding({v:1,pluginId:PLUGIN_MANIFEST.id,pluginVersion:PLUGIN_MANIFEST.version,
    agentId:'claude',localAgentId:'claude',sourceCustody:{kind:'managed',immutableGenerationId:'generation',installSource:'localPath'},
    locator:{module:'./agent/factory.js',export:'createAgentRuntime',runtimeApiVersion:1},normalizedModulePath:'agent/factory.js',loadMode:'immutable-js'});
  const manifest=ingestPluginManifestV2(PLUGIN_MANIFEST);
  if(!manifest.ok)throw Error('Manifest unavailable');
  const definition=manifest.manifest.contributes.agents?.find(agent=>agent.id==='claude');
  if(!definition)throw Error('Agent unavailable');
  const agent={id:'claude',identity:{pluginId:PLUGIN_MANIFEST.id,localId:'claude'},richDefinition:{provenance:'first_party' as const,definition}};
  const target=createExternalSessionFollowTargetHostOperation({machineId:'machine',dependencies:{
    readAccount:async()=>({connectedServicesV2:[]}),
    readAgentSettings:()=>getActiveAccountSettingsSnapshot()?.settings,readActiveServerId:()=>null}});
  await owner.install({followTargetOperation:target,followOperation:{execute:async()=>({status:'following',startingCursor:'native-tail',subscription:{dispose(){}}})}});
  const service=createRunnerAgentDaemonFacetService({machineId:'machine',externalSessionHostOperationOwner:owner,
    authorizeCurrent:async()=>true,authorizeActiveTurn:async()=>true,resolveRetainedExternalSessionAgentContribution:async()=>agent,
    snapshotVoiceAuthority:async()=>({agentSourceCustody:binding.sourceCustody,providers:[]}),waitVoiceAuthorityRetired:async()=>{}});
  const runner={pid:42,processStartTimeMs:1,processCommandHash:'a'.repeat(64),snapshotIdentity:'snapshot'};
  const base={sessionId:'session',runner,retainedAgent:binding};
  try {
    let result=RunnerAgentDaemonFacetResultV1Schema.parse(await service.dispatch({...base,operation:RunnerAgentDaemonFacetOperationV1Schema.parse({kind:'external_session.follow.open',requestId:'open',followId:'follow',target:{kind:'providerSession',agentId:'claude',providerSessionId:'native-session'},projection:'terminal',initialReplay:true})}));
    while(result.kind==='external_session.follow.provider_request') {
      const request=result.request;
      if(request.kind!=='validateSource'&&request.kind!=='resolveLinkIdentity')throw Error('unexpected_request');
      const response=request.kind==='validateSource'?{kind:request.kind,value:{ok:true,source:request.source}}:{kind:request.kind,value:{source:request.source,remoteSessionId:request.remoteSessionId,externalSessionMetadata:{linkData:{}}}};
      result=RunnerAgentDaemonFacetResultV1Schema.parse(await service.dispatch({...base,operation:RunnerAgentDaemonFacetOperationV1Schema.parse({kind:'external_session.follow.next',requestId:'next',followId:'follow',providerResponse:{providerRequestId:result.providerRequestId,status:'success',result:response}})}));
    }
    expect(result).toMatchObject({kind:'external_session.follow.open',result:{status:'following',startingCursor:'native-tail'}});
  } finally {await service.dispose();await owner.retire();resetActiveAccountSettingsSnapshotForTests();}
});
