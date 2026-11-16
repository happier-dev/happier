import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoderClient } from './nativeClient.js';
import { coderOptions } from './options.js';
import { CoderLaunchSchema, CoderOptionsSchema, type CoderOptions } from './schemas.js';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { readMachineProvisionerSessionPlacementV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MACHINE_PROVISIONER } from '../manifest.js';
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function options(query:CoderOptions,desiredPrebuildInstances:number|null=1){
 const paths:string[]=[];const server=createServer((req,res)=>{paths.push(req.url!);res.setHeader('content-type','application/json');
  const value=req.url?.endsWith('/templates')?[{id:'template',name:'Docker development',organization_id:'org',active_version_id:'version'},
    {id:'remote-template',name:'Cloud development',organization_id:'org',active_version_id:'remote-version'}]
    :req.url?.endsWith('/rich-parameters')?[{name:'project',required:true,default_value:''},{name:'region',required:false,default_value:'native-region'}]
    // Coder v2.39.0 codersdk/presets.go has no JSON tags: encoding/json
    // emits these exported field names, including nested parameters.
    :req.url?.endsWith('/presets')?[{ID:'preset',Name:'Team default',Parameters:[{Name:'project',Value:'preset-project'}],DesiredPrebuildInstances:desiredPrebuildInstances}]
    :{id:'version',template_id:'template',organization_id:'org'};res.end(JSON.stringify(value));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing address');
 cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const client=createCoderClient({request:(path,init)=>fetch(`http://127.0.0.1:${address.port}`+path,init),signal:new AbortController().signal,observedAt:1,waitForObservation:async()=>{}});
 return {result:MachineProvisionerOptionsResultV1Schema.parse(await coderOptions(client,query)),paths};
}
describe('Coder existing options/editor launch projection',()=>{
 it.each([null,0,1])('publishes native template guidance without disabling ordinary acquire for prebuild target %s',async count=>{
  const h=await options({organizationId:'org',templateId:'template',agentName:'main',presetId:'preset'},count);
  const selected=projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'template'},launchSchema:CoderLaunchSchema.jsonSchema});
  expect(selected.kind).toBe('ready');
  if(selected.kind!=='ready')throw new Error('Missing ordinary Coder launch');
  expect(selected.launch).toMatchObject({presetId:'preset'});
  expect(selected.nativeFacts.image).toMatchObject({id:'template',title:'Docker development',description:expect.any(String)});
  expect(h.paths.filter(path=>path.endsWith('/presets'))).toHaveLength(1);
 });
 it.each(['controller-local','remote','unknown',undefined] as const)('uses explicit template-host configuration for seam B (%s)',async workspaceHost=>{
  const query=CoderOptionsSchema.parse({organizationId:'org',templateId:'template',agentName:'main',presetId:'preset',
    ...(workspaceHost?{workspaceHost}:{})});
  const h=await options(query);
  const selected=projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'template'},launchSchema:CoderLaunchSchema.jsonSchema});
  expect(selected.kind).toBe('ready');
  if(selected.kind!=='ready')throw new Error('Missing configured launch');
  const placement=readMachineProvisionerSessionPlacementV1({id:'coder',...MACHINE_PROVISIONER},selected.launch);
  expect(placement?.kind??null).toBe(workspaceHost==='controller-local'?'controller-local':null);
  if(workspaceHost)expect(selected.launch).toMatchObject({workspaceHost});
 });
 it('clears the selected template host when choosing a different template',async()=>{
  const h=await options(CoderOptionsSchema.parse({organizationId:'org',templateId:'template',agentName:'main',presetId:'preset',workspaceHost:'controller-local'}));
  const selected=projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'remote-template'},launchSchema:CoderLaunchSchema.jsonSchema});
  expect(selected.kind).toBe('ready');
  if(selected.kind!=='ready')throw new Error('Missing remote launch');
  expect(selected.launch).toMatchObject({templateId:'remote-template',workspaceHost:'unknown'});
  expect(selected.nativeFacts.image?.id).toBe('remote-template');
  expect(readMachineProvisionerSessionPlacementV1({id:'coder',...MACHINE_PROVISIONER},selected.launch)).toBeNull();
 });
 it('keeps required values explicit, uses native template image choices and leaves inapplicable dimensions empty',async()=>{
  const h=await options({organizationId:'org',templateId:'template',agentName:'main'});
  expect(h.result.dimensions).toMatchObject({size:[],location:[],network:[],duration:[]});
  expect(h.result.dimensions.image).toEqual(expect.arrayContaining([expect.objectContaining({id:'template',assignments:[{path:'templateId',value:'template'},{path:'templateVersionId',value:'version'}]})]));
  expect(h.result.base).toMatchObject({available:false,unavailableReason:{fieldPath:'parameterValues'}});
  expect(JSON.stringify(h.result.base?.launch)).not.toContain('"project","value":""');
 });
 it.each(['preset-project','explicit project'])('merges native preset values and preserves explicit overrides through the shared selector (%s)',async project=>{
  const h=await options({organizationId:'org',templateId:'template',agentName:'main',presetId:'preset',
    ...(project==='explicit project'?{parameterValues:[{name:'project',value:project}]}:{})});
  const selected=projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'template'},launchSchema:CoderLaunchSchema.jsonSchema});
  expect(selected).toMatchObject({kind:'ready',launch:{templateId:'template',templateVersionId:'version',presetId:'preset',agentName:'main',parameterValues:[{name:'region',value:'native-region'},{name:'project',value:project}]}});
  expect(h.paths.filter(path=>path.endsWith('/rich-parameters'))).toHaveLength(1);
 });
 it('does not fabricate an agent or template version for an incomplete query',async()=>{
  const h=await options({organizationId:'org'});
  expect(h.result.base?.launch??{}).not.toHaveProperty('agentName');
  expect(projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'template'},launchSchema:CoderLaunchSchema.jsonSchema}).kind).not.toBe('ready');
 });
});
