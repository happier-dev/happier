import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { cursorConnectedAccountRuntime } from './runtime.js';

type Context = Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0];
// Only credential custody and HTTP are boundary fixtures; quota dispatch/parsing stay real.
function context(body: unknown, status = 200, kind = 'oauth') {
  const requests: string[] = [];
  const ctx = { invokedAtMs: 123, signal: new AbortController().signal,
    credentials: { async get(key: string) { return ({credentialKind:kind,accessToken:'fake-token'} as Record<string,string>)[key] ?? null; } },
    services: { http: createPluginHttpFixture({ async request(input) {
      requests.push(input.url);
      expect(input.method).toBe('POST');
      expect(input.headers).toMatchObject({Authorization:'Bearer fake-token','Content-Type':'application/json','Connect-Protocol-Version':'1'});
      expect(new TextDecoder().decode(input.body)).toBe('{}');
      return {status,headers:{'retry-after':'30'},body:new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))};
    } }) },
  } as Context;
  return {ctx,requests};
}
// Recorded-shape fixture: OpenUsage 35e88e93, CursorCurrentPeriodUsageTests.swift.
const usage = { enabled:true, billingCycleStart:'1761955200000', billingCycleEnd:'1764547200000',
  planUsage:{limit:2000,remaining:1500,totalPercentUsed:25,autoPercentUsed:3.25,apiPercentUsed:12.5},
  spendLimitUsage:{individualLimit:5000,individualRemaining:4000,limitType:'user'} };
describe('Cursor account quota', () => {
  it('reads the stored OAuth token and preserves sourced allowance, spend and cycle', async () => {
    const {ctx,requests}=context(usage);
    const snapshot=await cursorConnectedAccountRuntime.quota!(ctx);
    expect(requests).toEqual(['https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage']);
    expect(snapshot).toMatchObject({observedAtMs:123,limits:expect.arrayContaining([
      expect.objectContaining({id:'plan_usage',limit:20,remaining:15,utilizationPct:25,unit:'usd',resetsAtMs:1764547200000}),
      expect.objectContaining({id:'on_demand',limit:50,remaining:40,unit:'usd'}),
    ])});
  });
  it('keeps team pooled spend distinct from a personal allowance', async () => {
    const {ctx}=context({...usage,spendLimitUsage:{limitType:'team',pooledLimit:50000,pooledUsed:12000,pooledRemaining:38000}});
    expect((await cursorConnectedAccountRuntime.quota!(ctx)).limits).toContainEqual(expect.objectContaining({id:'on_demand',label:'Team spend',used:120,limit:500,remaining:380}));
  });
  it('does not call a dashboard with an API key', async () => {
    const {ctx,requests}=context(usage,200,'token');
    await expect(cursorConnectedAccountRuntime.quota!(ctx)).rejects.toMatchObject({quotaFetchErrorCode:'missing_auth'});
    expect(requests).toEqual([]);
  });
  it.each([[401,'auth_failure'],[404,'network'],[429,'provider_backoff'],[500,'provider_backoff']])('keeps HTTP %s typed', async (status, code) => {
    const {ctx}=context({},Number(status));
    await expect(cursorConnectedAccountRuntime.quota!(ctx)).rejects.toMatchObject({status,quotaFetchErrorCode:code});
  });
  it.each([{},'invalid-json',{enabled:false,planUsage:usage.planUsage}])('rejects unavailable or malformed usage', async body => {
    await expect(cursorConnectedAccountRuntime.quota!(context(body).ctx)).rejects.toMatchObject({quotaFetchErrorCode:'malformed'});
  });
});

describe('Cursor quota transport lifecycle', () => {
  it('preserves cancellation instead of converting it into an unavailable snapshot', async () => {
    const controller=new AbortController();
    const reason=new Error('fixture cancellation');
    const ctx={...context(usage).ctx,signal:controller.signal,services:{http:createPluginHttpFixture({async request(){controller.abort(reason);throw reason;}})}};
    await expect(cursorConnectedAccountRuntime.quota!(ctx)).rejects.toBe(reason);
  });
  it('classifies a transport failure without exposing its raw message', async () => {
    const ctx={...context(usage).ctx,services:{http:createPluginHttpFixture({async request(){throw new Error('private transport detail');}})}};
    await expect(cursorConnectedAccountRuntime.quota!(ctx)).rejects.toMatchObject({quotaFetchErrorCode:'network',message:'Cursor usage request failed'});
  });
  it('keeps percentage-only subscriptions usable without manufacturing money or a reset', async () => {
    const snapshot=await cursorConnectedAccountRuntime.quota!(context({enabled:true,planUsage:{totalPercentUsed:25}}).ctx);
    expect(snapshot.limits[0]).toMatchObject({utilizationPct:25});
    expect(snapshot.limits[0]).not.toHaveProperty('limit');
    expect(snapshot.limits[0]).not.toHaveProperty('remaining');
    expect(snapshot.limits[0]).not.toHaveProperty('resetsAtMs');
  });
});
