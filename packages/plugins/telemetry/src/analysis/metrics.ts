import { metricSeriesKey } from '../store/metrics.js';
import type { NormalizedMetricPoint } from '../otlp/types.js';
import type { DatabaseTelemetryMetricIntervalV1 } from '@happier-dev/database-protocol';
export type MetricInterval = DatabaseTelemetryMetricIntervalV1;
export type MetricWindowOptions = Readonly<{since:number;until:number;statistic?:'latest'|'sum'|'mean'|'p50'|'p95'|'count'}>;
export type MetricWindowAnalysis = Readonly<{
 status:'complete'|'partial'|'inconclusive';value?:number;unit:string;p50?:number;p95?:number;count?:number;
 reasons:readonly string[];window:Readonly<{since:number;until:number}>;observedWindow?:Readonly<{since:number;until:number}>;
 producers:readonly Readonly<{serviceName?:string;serviceVersion?:string;serviceInstanceId?:string}>[];
 intervals:readonly MetricInterval[];
}>;

type IntervalPoint = { point: NormalizedMetricPoint; since: number; until: number };
const time = (value:string) => Number(BigInt(value)) / 1_000_000;
function numeric(value:number|string,reasons:Set<string>):number|undefined {
 const result=Number(value);
 if(!Number.isFinite(result)||(typeof value==='string'&&!Number.isSafeInteger(result))){reasons.add('numeric_precision');return undefined;}
 return result;
}
function quantile(counts:readonly number[],bounds:readonly number[],fraction:number):number|undefined {
 const total=counts.reduce((a,b)=>a+b,0);
 if(!total)return undefined;
 const rank=total*fraction;
 let before=0;
 for(let index=0;index<counts.length;index++) {
  const count=counts[index]!;
  if(before+count>=rank&&count>0) {
   const upper=bounds[index];
   if(upper===undefined)return undefined;
   const lower=index===0?Math.min(0,upper):bounds[index-1]!;
   return lower+(upper-lower)*(rank-before)/count;
  }
  before+=count;
 }
 return undefined;
}
function summarize(intervals:readonly IntervalPoint[],statistic:MetricWindowOptions['statistic'],reasons:Set<string>):Pick<MetricInterval,'value'|'p50'|'p95'|'count'> {
 const first=intervals[0]?.point;
 if(!first)return {};
 if(first.metricType!=='histogram') {
  if(statistic==='count'){reasons.add('unsupported_statistic');return {};}
  const values=intervals.map(item=>item.point.metricType==='histogram'?undefined:numeric(item.point.value,reasons));
  if(values.some(value=>value===undefined))return {};
  const numbers=values as number[];
  const total=numbers.reduce((a,b)=>a+b,0);
  if(!Number.isFinite(total)){reasons.add('numeric_precision');return {};}
  return {value:statistic==='mean'?total/numbers.length:total};
 }
 const histograms=intervals.map(item=>item.point).filter((point):point is Extract<NormalizedMetricPoint,{metricType:'histogram'}>=>point.metricType==='histogram');
 if(statistic==='count') {
  const count=numeric(histograms.reduce((total,point)=>total+BigInt(point.count),0n).toString(),reasons);
  return count===undefined?{}:{value:count,count};
 }
 if(histograms.some(point=>JSON.stringify(point.explicitBounds)!==JSON.stringify(first.explicitBounds))){reasons.add('incompatible_histograms');return {};}
 if(histograms.some(point=>point.bucketCounts.length!==point.explicitBounds.length+1)){reasons.add('missing_histogram_buckets');return {};}
 const counts=first.bucketCounts.map((_count,index)=>numeric(histograms.reduce((count,point)=>count+BigInt(point.bucketCounts[index]!),0n).toString(),reasons));
 if(counts.some(count=>count===undefined))return {};
 const buckets=counts as number[];
 const count=buckets.reduce((a,b)=>a+b,0);
 if(!Number.isSafeInteger(count)){reasons.add('numeric_precision');return {};}
 if(!count){reasons.add('no_traffic');return {count};}
 const p50=quantile(buckets,first.explicitBounds,0.5),p95=quantile(buckets,first.explicitBounds,0.95);
 let value:number|undefined;
 if(statistic==='mean'||statistic==='sum') {
  if(histograms.some(point=>point.sum===undefined))reasons.add('missing_sum');
  else {const sum=histograms.reduce((total,point)=>total+point.sum!,0);value=statistic==='mean'?sum/count:sum;}
 } else if(statistic==='latest')reasons.add('unsupported_statistic');
 else {value=statistic==='p50'?p50:p95;if(value===undefined)reasons.add('unbounded_quantile');}
 return {count,...(p50!==undefined?{p50}:{}),...(p95!==undefined?{p95}:{}),...(value!==undefined?{value}:{})};
}

/** Converts each emitter's intervals once; never sums cumulative snapshots or averages quantiles.
 * A retained predecessor establishes cumulative deltas. Person windows need not match export edges;
 * measured complete intervals remain usable with explicit partial boundary coverage. No interpolation fills gaps.
 */
export function analyzeMetricWindow(points:readonly NormalizedMetricPoint[],options:MetricWindowOptions):MetricWindowAnalysis {
 const reasons=new Set<string>();
 const window={since:options.since,until:options.until};
 const selected=points.filter(point=>time(point.timeUnixNano)<=options.until);
 const inWindow=selected.filter(point=>time(point.timeUnixNano)>options.since);
 const first=inWindow[0];
 const unit=first?.unit??'';
 const outputUnit=options.statistic==='count'?'1':unit;
 const producers=[...new Map(inWindow.map(point=>{const producer={...(point.serviceName!==undefined?{serviceName:point.serviceName}:{}),...(point.serviceVersion!==undefined?{serviceVersion:point.serviceVersion}:{}),...(point.serviceInstanceId!==undefined?{serviceInstanceId:point.serviceInstanceId}:{})};return [JSON.stringify(producer),producer];})).values()];
 const result=(measurements:Pick<MetricInterval,'value'|'p50'|'p95'|'count'>,intervals:readonly MetricInterval[]):MetricWindowAnalysis=> {
  const inconclusive=[...reasons].some(reason=>reason!=='boundary_gap');
  const {value,...otherMeasurements}=measurements;
  return {status:inconclusive?'inconclusive':reasons.size?'partial':'complete',unit:outputUnit,...otherMeasurements,...(!inconclusive&&value!==undefined?{value}:{}),reasons:[...reasons],window,
   ...(intervals.length?{observedWindow:intervals.reduce((bounds,interval)=>({since:Math.min(bounds.since,interval.since),until:Math.max(bounds.until,interval.until)}),{since:intervals[0]!.since,until:intervals[0]!.until})}:{}),producers,intervals};
 };
 if(!first){reasons.add('no_traffic');return result({},[]);}
 const statistic=options.statistic??(first.metricType==='gauge'||(first.metricType==='sum'&&!first.isMonotonic)?'latest':first.metricType==='histogram'?'p95':'sum');
 if(!unit&&statistic!=='count')reasons.add('unknown_unit');
 if(inWindow.some(point=>point.name!==first.name||(statistic!=='count'&&point.unit!==unit)||point.metricType!==first.metricType))reasons.add('incompatible_series');
 const series=new Map<string,NormalizedMetricPoint[]>();
 for(const point of selected){const key=metricSeriesKey(point);const group=series.get(key)??[];group.push(point);series.set(key,group);}
 if(first.metricType==='gauge'&&statistic==='latest'&&new Set(inWindow.map(metricSeriesKey)).size>1)reasons.add('multiple_gauge_series');
 const intervals:IntervalPoint[]=[];
 const naturalIntervals:IntervalPoint[]=[];
 for(const group of series.values()) {
  group.sort((a,b)=>BigInt(a.timeUnixNano)<BigInt(b.timeUnixNano)?-1:BigInt(a.timeUnixNano)>BigInt(b.timeUnixNano)?1:0);
  const observed=group.filter(point=>time(point.timeUnixNano)>options.since);
  if(!observed.length)continue;
  if(observed.some(point=>point.incompleteBuckets)){reasons.add('missing_histogram_buckets');continue;}
  if(observed.some(point=>point.noRecordedValue)){reasons.add('no_recorded_value');continue;}
  if(statistic==='latest'||first.metricType==='gauge') {
   if(first.metricType==='histogram'||(first.metricType==='gauge'&&statistic!=='latest'&&statistic!=='mean')){reasons.add('unsupported_statistic');continue;}
   for(const point of observed){const at=time(point.timeUnixNano);naturalIntervals.push({point,since:at,until:at});}
   const samples=statistic==='latest'?[observed.at(-1)!]:observed;
   for(const point of samples){const at=time(point.timeUnixNano);intervals.push({point,since:at,until:at});}
   continue;
  }
  let coveredUntil:number|undefined;
  let needsBaseline=false;
  for(let index=0;index<group.length;index++) {
   const point=group[index]!;
   const until=time(point.timeUnixNano);
   if(until<=options.since)continue;
   if(point.temporality==='unspecified'){reasons.add('unspecified_temporality');continue;}
   let since=time(point.startTimeUnixNano),delta=point;
   if(point.temporality==='cumulative') {
    if(!point.serviceInstanceId){reasons.add('unknown_instance');continue;}
    const previous=group[index-1];
    if(previous) {
     if(previous.incompleteBuckets){reasons.add('missing_histogram_buckets');continue;}
     if(previous.noRecordedValue){reasons.add('no_recorded_value');continue;}
     if(previous.startTimeUnixNano!==point.startTimeUnixNano){reasons.add('reset');continue;}
     since=time(previous.timeUnixNano);
     if(point.metricType==='histogram'&&previous.metricType==='histogram') {
      if(previous.bucketCounts.length!==point.bucketCounts.length||JSON.stringify(previous.explicitBounds)!==JSON.stringify(point.explicitBounds)){reasons.add('incompatible_histograms');continue;}
      const bucketCounts=point.bucketCounts.map((count,i)=>BigInt(count)-BigInt(previous.bucketCounts[i]??'0'));
      const count=BigInt(point.count)-BigInt(previous.count);
      if(count<0n||bucketCounts.some(count=>count<0n)){reasons.add('reset');continue;}
      delta={...point,count:count.toString(),bucketCounts:bucketCounts.map(count=>count.toString()),
       sum:point.sum!==undefined&&previous.sum!==undefined?point.sum-previous.sum:undefined,min:undefined,max:undefined};
     } else if(point.metricType==='sum'&&previous.metricType==='sum') {
      if(typeof point.value==='string'&&typeof previous.value==='string') {
       const change=BigInt(point.value)-BigInt(previous.value);
       if(point.isMonotonic&&change<0n){reasons.add('reset');continue;}
       const value=numeric(change.toString(),reasons);if(value===undefined)continue;
       delta={...point,value};
      } else {
       const current=numeric(point.value,reasons),before=numeric(previous.value,reasons);
       if(current===undefined||before===undefined)continue;
       if(point.isMonotonic&&current<before){reasons.add('reset');continue;}
       delta={...point,value:current-before};
      }
     }
    } else if(since===0||since<options.since) {needsBaseline=true;reasons.add('boundary_gap');continue;}
   }
   if(since<options.since){reasons.add('boundary_gap');continue;}
   if(coveredUntil===undefined) {if(since>options.since)reasons.add('boundary_gap');}
   else {
    if(since>coveredUntil)reasons.add('gap');
    if(since<coveredUntil)reasons.add('overlap');
   }
   if(until<=since){reasons.add('invalid_interval');continue;}
   coveredUntil=until;
   intervals.push({point:delta,since,until});
   naturalIntervals.push({point:delta,since,until});
  }
  if(coveredUntil===undefined)reasons.add(needsBaseline?'missing_baseline':'no_complete_interval');
  else if(coveredUntil<options.until)reasons.add('boundary_gap');
 }
 if(statistic==='latest'&&new Set(intervals.map(interval=>interval.until)).size>1)reasons.add('incomparable_intervals');
 const measurements=summarize(intervals,statistic,reasons);
 const grouped=new Map<string,IntervalPoint[]>();
 for(const interval of naturalIntervals){const key=JSON.stringify([interval.since,interval.until]);const group=grouped.get(key)??[];group.push(interval);grouped.set(key,group);}
 const trend:MetricInterval[]=[];
 for(const group of grouped.values()) {
  const intervalReasons=new Set<string>();
  const values=summarize(group,statistic,intervalReasons);
  if(!intervalReasons.size)trend.push({since:group[0]!.since,until:group[0]!.until,unit:outputUnit,...values});
 }
 trend.sort((a,b)=>a.until-b.until||a.since-b.since);
 return result(measurements,trend);
}
