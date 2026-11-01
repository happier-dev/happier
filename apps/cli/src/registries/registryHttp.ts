import type { RegistryHttpV1,RegistryHttpResultV1,RegistrySourceV1 } from '@happier-dev/protocol/registries';
import { readRegistryHttpRateLimitV1 } from '@happier-dev/protocol/registries';
import { registryTokenHeader } from './registryTokenHeader';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/release-runtime/httpRedirects';
type Memo=Readonly<{bytes:Uint8Array;etag?:string;lastModified?:string;fetchedAt:number}>;
const rateLimitedUntil=new Map<string,number>();
/** Node transport only. Token materialization is supplied by the incumbent Saved Secret owner. */
export function createRegistryHttpV1(input:Readonly<{signal?:AbortSignal;fetch?:typeof fetch;
  resolveToken?:(source:RegistrySourceV1)=>Promise<string|null>}>={}):RegistryHttpV1 {
  const memo=new Map<string,Memo>();
  const request=async(url:string,source?:RegistrySourceV1):Promise<RegistryHttpResultV1<Uint8Array>>=>{
    const original=new URL(url);const sourceOrigin=source?new URL(source.url).origin:null;
    const key=JSON.stringify([url,source?.id,source?.token?.secretRef]);const cached=memo.get(key);const seen=new Set<string>();
    let target=original;let token:string|null=null;
    if(source?.token){token=await input.resolveToken?.(source)??null;if(!token)return {ok:false,status:{state:'auth_failed'}};}
    while(true){
      input.signal?.throwIfAborted();
      if(seen.has(target.href))return {ok:false,status:{state:'unreachable'}};seen.add(target.href);
      const retryAt=rateLimitedUntil.get(target.origin);if(retryAt&&retryAt>Date.now())return {ok:false,status:{state:'rate_limited',retryAt}};
      const headers=new Headers();const credentialHeaderNames=new Set<string>();
      const githubSource=source&&/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\/|$)/.test(source.url);
      const repo=githubSource?'/'+new URL(source!.url).pathname.split('/').filter(Boolean).slice(0,2).join('/'):null;
      const githubTarget=repo&&(target.origin==='https://api.github.com'&&(target.pathname==='/repos'+repo||target.pathname.startsWith('/repos'+repo+'/'))
        ||target.origin==='https://raw.githubusercontent.com'&&target.pathname.startsWith(repo+'/'));
      const allowed=target.origin===sourceOrigin||githubTarget;
      if(token&&allowed&&source){try{const header=registryTokenHeader(source,token);headers.set(header.name,header.value);credentialHeaderNames.add(header.name.toLowerCase());}catch{return {ok:false,status:{state:'auth_failed'}};}}
      if(cached&&target.href===original.href){if(cached.etag)headers.set('If-None-Match',cached.etag);if(cached.lastModified)headers.set('If-Modified-Since',cached.lastModified);}
      let response:Response;
      try{response=token&&allowed
        ?await fetchWithCredentialRedirectRefusal(target.href,{headers,signal:input.signal},input.fetch??fetch,credentialHeaderNames)
        :await (input.fetch??fetch)(target,{headers,redirect:'manual',signal:input.signal});}
      catch(error){if(input.signal?.aborted||error instanceof CredentialRequestRedirectError)throw error;return {ok:false,status:{state:'unreachable'}};}
      if(response.status>=300&&response.status<400&&response.status!==304){const location=response.headers.get('location');if(!location)return {ok:false,status:{state:'unreachable'}};target=new URL(location,target);if(target.protocol!=='https:'||target.username||target.password)return {ok:false,status:{state:'invalid_source'}};continue;}
      if(response.status===304&&cached)return {ok:true,value:cached.bytes,fetchedAt:cached.fetchedAt};
      const rateLimit=readRegistryHttpRateLimitV1({status:response.status,headers:response.headers,nowMs:Date.now()});
      if(rateLimit){if(rateLimit.retryAt!==undefined)rateLimitedUntil.set(target.origin,rateLimit.retryAt);return {ok:false,status:rateLimit};}
      if(response.status===401||response.status===403)return {ok:false,status:{state:'auth_failed'}};
      if(!response.ok)return {ok:false,status:{state:response.status===404?'invalid_source':'unreachable'}};
      const bytes=new Uint8Array(await response.arrayBuffer());const fetchedAt=Date.now();
      memo.set(key,{bytes,fetchedAt,etag:response.headers.get('etag')??undefined,lastModified:response.headers.get('last-modified')??undefined});
      return {ok:true,value:bytes,fetchedAt};
    }
  };
  return {getBytes:(url,opts)=>request(url,opts?.source),getText:async(url,opts)=>{const r=await request(url,opts?.source);return r.ok?{...r,value:new TextDecoder().decode(r.value)}:r;},
    getJson:async(url,opts)=>{const r=await request(url,opts?.source);if(!r.ok)return r;try{return {...r,value:JSON.parse(new TextDecoder().decode(r.value)) as unknown};}catch{return {ok:false,status:{state:'invalid_source'}};}}};
}
