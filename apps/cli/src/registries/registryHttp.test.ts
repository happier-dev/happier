import {describe,expect,it,vi} from 'vitest';
import {createRegistryHttpV1} from './registryHttp';
import type {RegistrySourceV1} from '@happier-dev/protocol/registries';
import {RegistrySourceStatusV1Schema} from '@happier-dev/protocol/registries';
const source:RegistrySourceV1={id:'repo',title:'Repo',url:'https://github.com/a/b',format:'git',kinds:['skill'],enabled:true,addedAt:0,token:{secretRef:'secret'}};
describe('registry HTTP boundary',()=>{
  it('allows a rejected-token check at the upstream reset across Action host factories',async()=>{
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let calls=0;
      const transport:typeof fetch=async()=>++calls===1
        ?new Response(null,{status:429,headers:{'retry-after':'2'}}):new Response(null,{status:401});
      const url='https://registry-token-expiry.example/catalog';
      const binding={source:{...source,url}};
      const host=()=>createRegistryHttpV1({fetch:transport,resolveToken:async()=> 'rejected-fixture'});
      expect(await host().getJson(url,binding)).toMatchObject({status:{state:'rate_limited',retryAt:3_000}});
      vi.setSystemTime(2_999);
      expect(await host().getJson(url,binding)).toMatchObject({status:{state:'rate_limited'}});
      expect(calls).toBe(1);
      vi.setSystemTime(3_000);
      expect(await host().getJson(url,binding)).toEqual({ok:false,status:{state:'auth_failed'}});
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('uses an unprefixed custom header when no scheme is declared',async()=>{
    let observed:string|null=null;
    const http=createRegistryHttpV1({resolveToken:async()=> 'value',fetch:async(_url,init)=>{
      observed=new Headers(init?.headers).get('x-api-key');return new Response('ok');
    }});
    await http.getText(source.url,{source:{...source,token:{secretRef:'secret',header:{name:'X-Api-Key'}}}});
    expect(observed).toBe('value');
  });
  it('retains a credential-authenticated cached document on HTTP 304',async()=>{
    let calls=0;
    const http=createRegistryHttpV1({resolveToken:async()=> 'fixture',fetch:async()=>++calls===1
      ?new Response('cached',{headers:{etag:'"fixture"'}}):new Response(null,{status:304})});
    await expect(http.getText(source.url,{source})).resolves.toMatchObject({ok:true,value:'cached'});
    await expect(http.getText(source.url,{source})).resolves.toMatchObject({ok:true,value:'cached'});
  });
  it('keeps a custom credential on a same-origin redirect',async()=>{
    const observations:(string|null)[]=[];
    const http=createRegistryHttpV1({resolveToken:async()=> 'value',fetch:async(url,init)=>{
      observations.push(new Headers(init?.headers).get('x-api-key'));
      return String(url).endsWith('/redirect')?new Response(null,{status:302,headers:{location:'/file'}}):new Response('ok');
    }});
    await expect(http.getText('https://github.com/redirect',{source:{...source,token:{secretRef:'secret',header:{name:'X-Api-Key'}}}}))
      .resolves.toMatchObject({ok:true,value:'ok'});
    expect(observations).toEqual(['value','value']);
  });
  it('never sends a custom credential to a redirected origin',async()=>{
    const observations:{url:string;credential:string|null}[]=[];
    const http=createRegistryHttpV1({resolveToken:async()=> 'value',fetch:async(url,init)=>{
      observations.push({url:String(url),credential:new Headers(init?.headers).get('x-api-key')});
      return String(url).endsWith('/redirect')?new Response(null,{status:302,headers:{location:'https://other.example/file'}}):new Response('ok');
    }});
    await expect(http.getText('https://github.com/redirect',{source:{...source,token:{secretRef:'secret',header:{name:'X-Api-Key'}}}}))
      .resolves.toMatchObject({ok:true,value:'ok'});
    expect(observations).toEqual([
      {url:'https://github.com/redirect',credential:'value'},
      {url:'https://other.example/file',credential:null},
    ]);
  });
  it('passes tokens only to admitted paths and follows cross-origin redirects without credentials',async()=>{
    const observations:{url:string;authorization:string|null}[]=[];
    const transport:typeof fetch=async(url,init)=>{
      const target=String(url);observations.push({url:target,authorization:new Headers(init?.headers).get('authorization')});
      return target.endsWith('/redirect')?new Response(null,{status:302,headers:{location:'https://other.example/file'}}):new Response('ok');
    };
    const http=createRegistryHttpV1({fetch:transport,resolveToken:async()=> 'value'});
    await http.getText('https://api.github.com/repos/a/b',{source});
    await http.getText('https://api.github.com/repos/a/b/commits/HEAD',{source});
    await http.getText('https://raw.githubusercontent.com/a/b/sha/SKILL.md',{source});
    await http.getText('https://api.github.com/repos/a/b2/commits/HEAD',{source});
    await http.getText('http://api.github.com/repos/a/b/commits/HEAD',{source});
    await http.getText('https://api.github.com:8443/repos/a/b/commits/HEAD',{source});
    await expect(http.getText('https://github.com/redirect',{source})).resolves.toMatchObject({ok:true,value:'ok'});
    expect(observations.map(item=>item.authorization)).toEqual(['Bearer value','Bearer value','Bearer value',null,null,null,'Bearer value',null]);
    expect(observations.at(-1)).toEqual({url:'https://other.example/file',authorization:null});
  });
  it.each<{status:number;headers:Record<string,string>;state:string}>([{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'2000000000'},state:'rate_limited'},
    {status:403,headers:{},state:'auth_failed'},{status:429,headers:{'retry-after':'2'},state:'rate_limited'}])('classifies HTTP $status with $state without empty success',async({status,headers,state})=>{
    const http=createRegistryHttpV1({fetch:async()=>new Response(null,{status,headers})});
    expect(await http.getJson(`https://registry-${status}-${state}.example/index`)).toMatchObject({ok:false,status:{state}});
  });
  it('does not invent a reset time for a headerless 429 (RFC6585 section 4)',async()=>{
    let calls=0;
    const http=createRegistryHttpV1({fetch:async()=>{calls++;return calls===1?new Response(null,{status:429}):Response.json({items:[]});}});
    const response=await http.getJson('https://registry-headerless.example/index');
    expect(response).toEqual({ok:false,status:{state:'rate_limited'}});
    if(response.ok)throw new Error('Expected rate-limit observation');
    expect(RegistrySourceStatusV1Schema.parse(response.status)).toEqual({state:'rate_limited'});
    expect(await http.getJson('https://registry-headerless.example/index')).toMatchObject({ok:true,value:{items:[]}});
    expect(calls).toBe(2);
  });
  it('retains a header-proven throttle across separate Action host factories',async()=>{
    let calls=0;const transport:typeof fetch=async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'60'}});};
    await createRegistryHttpV1({fetch:transport}).getJson('https://registry-shared-rate.example/first');
    expect(await createRegistryHttpV1({fetch:transport}).getJson('https://registry-shared-rate.example/second')).toMatchObject({ok:false,status:{state:'rate_limited'}});
    expect(calls).toBe(1);
  });
});
