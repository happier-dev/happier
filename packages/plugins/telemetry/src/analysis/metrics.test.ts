import { describe, expect, it } from 'vitest';
import { analyzeMetricWindow } from './metrics.js';
import type { NormalizedMetricPoint } from '../otlp/types.js';

function sum(value: number, end: number, start = 0, instance = 'a'): NormalizedMetricPoint {
 return { metricType: 'sum', name: 'requests', unit: '{request}', temporality: 'cumulative', isMonotonic: true,
  value, startTimeUnixNano: String(start * 1e6), timeUnixNano: String(end * 1e6), serviceName: 'api', serviceInstanceId: instance, dimensions: {} };
}
function histogram(counts: string[], end: number, start: number, instance = 'a'): NormalizedMetricPoint {
 return { metricType: 'histogram', name: 'http.server.request.duration', unit: 's', temporality: 'delta',
  count: counts.reduce((a,b) => a+BigInt(b),0n).toString(), bucketCounts: counts, explicitBounds: [0.1,0.5],
  startTimeUnixNano: String(start*1e6), timeUnixNano: String(end*1e6), serviceName: 'api', serviceInstanceId: instance, dimensions: {} };
}

describe('retained metric window arithmetic', () => {
 it('differences cumulative samples instead of summing snapshots and preserves independent instances', () => {
  const result = analyzeMetricWindow([sum(20,1000),sum(25,2000),sum(35,3000),sum(4,1000,0,'b'),sum(14,3000,0,'b')],{since:1000,until:3000,statistic:'sum'});
  expect(result).toMatchObject({status:'complete',value:25,unit:'{request}',reasons:[]});
  expect(result.producers).toHaveLength(2);
  expect(result.producers).toEqual([{serviceName:'api',serviceInstanceId:'a'},{serviceName:'api',serviceInstanceId:'b'}]);
  expect(Object.values(result.producers[0]!)).not.toContain(undefined);
  expect(analyzeMetricWindow([{...sum(0,1000),value:'9223372036854775700'},{...sum(0,3000),value:'9223372036854775715'}],{since:1000,until:3000,statistic:'sum'})).toMatchObject({status:'complete',value:15});
 });
 it('uses observed complete emitter intervals inside arbitrary person windows without inventing boundary data', () => {
  const result=analyzeMetricWindow([sum(20,1000),sum(25,2000),sum(35,3000)],{since:500,until:3500,statistic:'sum'});
  expect(result).toMatchObject({status:'partial',value:15,reasons:['boundary_gap'],observedWindow:{since:1000,until:3000}});
  const latency=analyzeMetricWindow([histogram(['90','10','0'],2000,1000),histogram(['90','10','0'],3000,2000)],{since:500,until:3500,statistic:'p95'});
  expect(latency).toMatchObject({status:'partial',count:200,value:expect.closeTo(0.3),observedWindow:{since:1000,until:3000}});
 });
 it('exposes resets, expired baselines, gaps and non-comparable windows instead of returning plausible totals', () => {
  for (const [points, reason] of [
   [[sum(20,1000),sum(5,3000,2000)],'reset'],
   [[sum(25,2000)],'missing_baseline'],
   [[{...sum(2,2000,1000),temporality:'delta' as const},{...sum(3,3000,2500),temporality:'delta' as const}],'gap'],
   [[sum(20,1000),sum(10,3000)],'reset'],
  ] as const) {
   const result = analyzeMetricWindow(points,{since:1000,until:3000,statistic:'sum'});
   expect(result.status).toBe('inconclusive');
   expect(result.reasons).toContain(reason);
   expect(result.value).toBeUndefined();
  }
 });
 it('aggregates compatible histogram buckets before quantiles and subtracts cumulative histogram buckets', () => {
  const a = histogram(['90','10','0'],3000,1000);
  const b = histogram(['0','100','0'],3000,1000,'b');
  const result = analyzeMetricWindow([a,b],{since:1000,until:3000,statistic:'p95'});
  expect(result).toMatchObject({status:'complete',count:200,p50:expect.closeTo(0.136363636),p95:expect.closeTo(0.46363636)});
  expect(result.value).toBeCloseTo(result.p95!);
  const before = {...histogram(['100','20','0'],1000,0),temporality:'cumulative' as const};
  const after = {...histogram(['190','30','0'],3000,0),temporality:'cumulative' as const};
  expect(analyzeMetricWindow([before,after],{since:1000,until:3000})).toMatchObject({status:'complete',count:100});
  expect(analyzeMetricWindow([a,{...b,explicitBounds:[0.2,0.5]}],{since:1000,until:3000})).toMatchObject({status:'inconclusive',reasons:['incompatible_histograms']});
 });
 it('measures histogram counts independently of undefined zero-traffic or unbounded percentiles', () => {
  const before={...histogram(['5','0','0'],1000,500),temporality:'cumulative' as const};
  const unchanged={...before,timeUnixNano:'2000000000'};
  expect(analyzeMetricWindow([before,unchanged],{since:1000,until:2000,statistic:'count'})).toMatchObject({
   status:'complete',value:0,count:0,unit:'1',reasons:[],intervals:[{since:1000,until:2000,value:0,count:0,unit:'1'}],
  });
  const unbounded=histogram(['0','0','100'],2000,1000);
  expect(analyzeMetricWindow([unbounded],{since:1000,until:2000,statistic:'count'})).toMatchObject({status:'complete',value:100,count:100,unit:'1',reasons:[]});
  expect(analyzeMetricWindow([unbounded],{since:1000,until:2000,statistic:'p95'})).toMatchObject({status:'inconclusive',reasons:['unbounded_quantile']});
 });
 it('keeps count-only windows unknown when interval evidence is missing, reset, gapped or incomplete', () => {
  const before={...histogram(['5','0','0'],1000,500),temporality:'cumulative' as const};
  const unchanged={...before,timeUnixNano:'2000000000'};
  for(const [points,reason] of [
   [[unchanged],'missing_baseline'],
   [[before,{...unchanged,startTimeUnixNano:'1500000000'}],'reset'],
   [[histogram(['0','0','0'],1500,1000),histogram(['0','0','0'],2000,1700)],'gap'],
   [[before,{...unchanged,incompleteBuckets:true as const}],'missing_histogram_buckets'],
   [[{...histogram(['0','0','0'],2000,1000),temporality:'unspecified' as const}],'unspecified_temporality'],
   [[sum(2,2000,1000)],'unsupported_statistic'],
  ] as const) {
   const result=analyzeMetricWindow(points,{since:1000,until:2000,statistic:'count'});
   expect(result.status).toBe('inconclusive');
   expect(result.reasons).toContain(reason);
   expect(result.value).toBeUndefined();
  }
  expect(analyzeMetricWindow([],{since:1000,until:2000,statistic:'count'})).toMatchObject({status:'inconclusive',reasons:['no_traffic']});
 });
 it('keeps latest non-monotonic active requests independent of trace sampling and treats no traffic/unknown values honestly', () => {
  const point = {...sum(4,3000),name:'http.server.active_requests',isMonotonic:false};
  expect(analyzeMetricWindow([point],{since:1000,until:3000,statistic:'latest'})).toMatchObject({status:'complete',value:4});
  const gauge={...point,metricType:'gauge' as const};
  expect(analyzeMetricWindow([gauge,{...gauge,timeUnixNano:'2000000000',value:8}],{since:1000,until:3000,statistic:'latest'}).intervals).toHaveLength(2);
  expect(analyzeMetricWindow([gauge,{...gauge,serviceInstanceId:'b'}],{since:1000,until:3000,statistic:'latest'})).toMatchObject({status:'inconclusive',reasons:['multiple_gauge_series']});
  expect(analyzeMetricWindow([],{since:1000,until:3000})).toMatchObject({status:'inconclusive',reasons:['no_traffic']});
  expect(analyzeMetricWindow([{...point,unit:''}],{since:1000,until:3000,statistic:'latest'})).toMatchObject({status:'inconclusive',reasons:['unknown_unit']});
  expect(analyzeMetricWindow([{...point,value:'9223372036854775807'}],{since:1000,until:3000,statistic:'latest'})).toMatchObject({status:'inconclusive',reasons:['numeric_precision']});
 });
});
