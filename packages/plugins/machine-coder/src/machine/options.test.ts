import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoderClient } from './nativeClient.js';
import { coderOptions } from './options.js';
import { CoderLaunchSchema, type CoderOptions } from './schemas.js';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function options(query:CoderOptions){
 const paths:string[]=[];const server=createServer((req,res)=>{paths.push(req.url!);res.setHeader('content-type','application/json');
  const value=req.url?.endsWith('/templates')?[{id:'template',name:'Docker development',organization_id:'org',active_version_id:'version'}]
    :req.url?.endsWith('/rich-parameters')?[{name:'project',required:true,default_value:''},{name:'region',required:false,default_value:'native-region'}]
    :req.url?.endsWith('/presets')?[{id:'preset',name:'Team default',parameters:[{name:'project',value:'preset-project'}]}]
    :{id:'version',template_id:'template',organization_id:'org'};res.end(JSON.stringify(value));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing address');
 cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const client=createCoderClient({request:(path,init)=>fetch(`http://127.0.0.1:${address.port}`+path,init),signal:new AbortController().signal,observedAt:1,waitForObservation:async()=>{}});
 return {result:MachineProvisionerOptionsResultV1Schema.parse(await coderOptions(client,query)),paths};
}
describe('Coder existing options/editor launch projection',()=>{
 it('keeps required values explicit, uses native template image choices and leaves inapplicable dimensions empty',async()=>{
  const h=await options({organizationId:'org',templateId:'template',agentName:'main'});
  expect(h.result.dimensions).toMatchObject({size:[],location:[],network:[],duration:[]});
  expect(h.result.dimensions.image).toMatchObject([{id:'template',assignments:[{path:'templateId',value:'template'},{path:'templateVersionId',value:'version'}]}]);
  expect(h.result.base).toMatchObject({available:false,unavailableReason:{fieldPath:'parameterValues'}});
  expect(JSON.stringify(h.result.base?.launch)).not.toContain('"project","value":""');
 });
 it('merges documented defaults and preset values while preserving explicit required overrides through the shared selector',async()=>{
  const h=await options({organizationId:'org',templateId:'template',agentName:'main',presetId:'preset',parameterValues:[{name:'project',value:'explicit project'}]});
  const selected=projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'template'},launchSchema:CoderLaunchSchema.jsonSchema});
  expect(selected).toMatchObject({kind:'ready',launch:{templateId:'template',templateVersionId:'version',presetId:'preset',agentName:'main',parameterValues:[{name:'region',value:'native-region'},{name:'project',value:'explicit project'}]}});
  expect(h.paths.filter(path=>path.endsWith('/rich-parameters'))).toHaveLength(1);
 });
 it('does not fabricate an agent or template version for an incomplete query',async()=>{
  const h=await options({organizationId:'org'});
  expect(h.result.base?.launch??{}).not.toHaveProperty('agentName');
  expect(projectMachineProvisionerSelectionV1({options:h.result,selection:{image:'template'},launchSchema:CoderLaunchSchema.jsonSchema}).kind).not.toBe('ready');
 });
});
