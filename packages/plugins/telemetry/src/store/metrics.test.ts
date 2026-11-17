import { describe, expect, it } from 'vitest';
import { analyzeMetricWindow } from '../analysis/metrics.js';
import type { NormalizedMetricPoint } from '../otlp/types.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { captureMigrations, createCaptureStore, type CaptureEvent } from './capture.js';
import { metricPointId } from './metrics.js';

async function fixture() {
 const sqlite=createCaptureSqliteFixture();
 for(const migration of captureMigrations)await migration.up(sqlite.db);
 const publications:string[][]=[];
 const store=createCaptureStore(sqlite.db,keys=>publications.push([...keys]));
 return {...sqlite,store,publications};
}
function event(worktree:string,metric:NormalizedMetricPoint):CaptureEvent {
 return {id:metricPointId(metric),worktree,kind:'metric',source:'otlp',at:Number(BigInt(metric.timeUnixNano))/1e6,metric};
}
describe('metric retained storage contracts',()=> {
 it('marks an incomplete retained bucket chunk instead of calculating plausible false percentiles',async()=> {
  const f=await fixture();
  try {
   const metric:NormalizedMetricPoint={metricType:'histogram',name:'http.server.request.duration',unit:'s',temporality:'delta',dimensions:{},
    startTimeUnixNano:'1000000000',timeUnixNano:'2000000000',count:'100',explicitBounds:[0.1,0.5],bucketCounts:['90','10','0']};
   await f.store.write([event('environment',metric)]);
   expect(f.statements.filter(statement=>statement.startsWith('INSERT INTO metricBuckets'))).toHaveLength(1); // one host-sized bucket write, not one worker call per bucket
   expect(analyzeMetricWindow(await f.store.metricPoints({worktree:'environment',since:1000,until:2000}),{since:1000,until:2000})).toMatchObject({status:'complete',count:100});
   // The real host retention owner deletes table chunks independently. A point
   // may remain readable between its bucket deletion and the point deletion.
   await f.db.execute('DELETE FROM metricBuckets WHERE worktree=? AND ordinal=0',['environment']);
   const observed=analyzeMetricWindow(await f.store.metricPoints({worktree:'environment',since:1000,until:2000}),{since:1000,until:2000});
   expect(observed).toMatchObject({status:'inconclusive',reasons:['missing_histogram_buckets']});
   expect(observed.value).toBeUndefined();
  } finally {f.close();}
 });
 it('reads selected series through one scoped projection among 100 Environments and 1000 emitter series, and publishes zero on replay',async()=> {
  const f=await fixture();
  try {
   let replay:CaptureEvent[]=[];
   for(let environment=0;environment<100;environment++) {
    const worktree=`environment-${environment}`;
    const events:CaptureEvent[]=[];
    for(let instance=0;instance<10;instance++)for(const at of [500,1000,2000,3000]) {
     const point:NormalizedMetricPoint={metricType:'sum',name:'request_count',unit:'{request}',temporality:'cumulative',isMonotonic:true,
      serviceName:instance<5?'api':'worker',serviceInstanceId:`instance-${environment}-${instance}`,dimensions:{},
      startTimeUnixNano:'100000000',timeUnixNano:String(at*1e6),value:String(at/100)};
     events.push(event(worktree,point));
    }
    await f.store.write(events);
    if(environment===42)replay=events;
   }
   const publications=f.publications.length;
   await f.store.write(replay);
   expect(f.publications).toHaveLength(publications);
   const statementsBefore=f.statements.length,rowsBefore=f.queryRows.length;
   const points=await f.store.metricPoints({worktree:'environment-42',name:'request_count',serviceName:'api',since:1000,until:3000});
   expect(points).toHaveLength(15); // five selected series, two samples + one boundary predecessor each
   expect([...new Set(points.map(point=>point.serviceInstanceId))]).toHaveLength(5);
   expect(f.queryRows.slice(rowsBefore)).toEqual([15]);
   expect(f.statements.length-statementsBefore).toBe(1); // one window projection, no Environment/series read fan-out
   expect(analyzeMetricWindow(points,{since:1000,until:3000,statistic:'sum'})).toMatchObject({status:'complete',value:100});
   console.info('metric selected-read shape',{environments:100,series:1000,storedPoints:4000,selectedSeries:5,projectedRows:15,statements:1,replayPublications:f.publications.length-publications});
  } finally {f.close();}
 });
});
