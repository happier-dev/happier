import { gzipSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { analyzeMetricWindow } from '../analysis/metrics.js';
import { createCaptureRuntime } from '../runtime.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { otlpSchema } from './schema.js';

const attributes = [{ key: 'http.route', value: { stringValue: '/users/{id}' } },
 { key: 'http.request.method', value: { stringValue: 'GET' } },
 { key: 'url.full', value: { stringValue: 'https://private.test/?token=secret' } },
 { key: 'user.id', value: { stringValue: 'secret-user' } }];
const request = { resourceMetrics: [{ resource: { attributes: [
 { key: 'service.name', value: { stringValue: 'api' } }, { key: 'service.version', value: { stringValue: 'build-1' } },
 { key: 'service.instance.id', value: { stringValue: 'instance-a' } },
] }, scopeMetrics: [{ scope: { name: '@opentelemetry/instrumentation-http', version: '0.208.0' }, metrics: [
 { name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{
  attributes, startTimeUnixNano: '1000000000', timeUnixNano: '2000000000', count: '4', sum: 1.2,
  bucketCounts: ['1', '2', '1'], explicitBounds: [0.1, 0.5],
 }] } },
 { name: 'http.server.active_requests', unit: '{request}', sum: { aggregationTemporality: 2, isMonotonic: false,
  dataPoints: [{ attributes, startTimeUnixNano: '1000000000', timeUnixNano: '2000000000', asInt: '-2' }] } },
 { name: 'v8js.memory.used', unit: 'By', gauge: { dataPoints: [{ timeUnixNano: '2000000000', asInt: '4096' }] } },
] }] }] };

describe('OTLP metrics through the shared HTTP receiver and real SQLite', () => {
 it('preserves distinct emitter streams when only non-retained dimensions differ', async () => {
  const sqlite=createCaptureSqliteFixture();
  for(const migration of captureMigrations)await migration.up(sqlite.db);
  const runtime=createCaptureRuntime({database:sqlite.db,publish:()=>{},normalizeStatement:()=>{throw new Error('No SQL');}});
  const receiver=await runtime.acquireReceiver({port:0,context:{partition:'selected',capabilities:{metrics:true}}});
  try {
   const payload={resourceMetrics:[{resource:request.resourceMetrics[0]!.resource,scopeMetrics:[{metrics:[{
    name:'http.server.request.duration',unit:'s',histogram:{aggregationTemporality:1,dataPoints:[{stringValue:'1'},{stringValue:'2'},{intValue:'1'}].map(value=>({attributes:[...attributes,{key:'emitter.variant',value}],startTimeUnixNano:'1000000000',timeUnixNano:'2000000000',count:'100',explicitBounds:[0.1,0.5],bucketCounts:['90','10','0']}))}
   }]}]}]};
   for(const json of [true,false]) {
    const type=protobuf.Root.fromJSON(otlpSchema).lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest');
    const body=json?JSON.stringify(payload):Buffer.from(type.encode(type.fromObject(payload)).finish());
    const response=await fetch(`${receiver.endpoint}/v1/metrics`,{method:'POST',headers:{'content-type':json?'application/json':'application/x-protobuf'},body});
    expect(response.status).toBe(200);
    for(const point of payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.histogram.dataPoints)point.attributes.reverse();
   }
   await runtime.ingest.settled();
   const points=await runtime.store.metricPoints({worktree:'selected',since:1000,until:2000});
   expect(points).toHaveLength(3);
   expect(analyzeMetricWindow(points,{since:1000,until:2000})).toMatchObject({status:'complete',count:300});
   expect(JSON.stringify(points)).not.toMatch(/secret|url.full|user.id|emitter.variant/);
  } finally {await receiver.release();await runtime.ingest.settled();sqlite.close();}
 });
 it('retains JSON/protobuf/gzip metrics exactly once, rejects unsupported points, scopes reads and clears partitions containing only metrics', async () => {
  const sqlite = createCaptureSqliteFixture();
  for (const migration of captureMigrations) await migration.up(sqlite.db);
  const publications: string[][] = [];
  const runtime = createCaptureRuntime({ database: sqlite.db, publish: keys => publications.push([...keys]),
   normalizeStatement: () => { throw new Error('No SQL in metric fixture'); } });
  let metricsEnabled = true;
  let selectedPartition = 'selected';
  const receiver = await runtime.acquireReceiver({ port: 0, context: { partition: 'selected', capabilities: { metrics: true, appLlmCost: false, exceptions: false } },
   admit: () => ({ accepted: true, context: { partition: selectedPartition, capabilities: { metrics: metricsEnabled, appLlmCost: false, exceptions: false } } }) });
  try {
   const control = await fetch(`${receiver.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '2000000000', body: { stringValue: 'control' } }] }] }] }) });
   expect(control.status).toBe(200);
   for (const json of [true, false]) for (const compressed of [false, true]) {
    const type = !json ? protobuf.Root.fromJSON(otlpSchema).lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest') : undefined;
    const body = json ? Buffer.from(JSON.stringify(request)) : Buffer.from(type!.encode(type!.fromObject(request)).finish());
    const response = await fetch(`${receiver.endpoint}/v1/metrics`, { method: 'POST', headers: {
     'content-type': json ? 'application/json' : 'application/x-protobuf', ...(compressed ? { 'content-encoding': 'gzip' } : {}),
    }, body: compressed ? gzipSync(body) : body });
    expect(response.status).toBe(200);
   }
   const points = await runtime.store.metricPoints({ worktree: 'selected', since: 1000, until: 3000 });
   expect(points).toHaveLength(3);
   expect(points.find(point => point.name === 'http.server.request.duration')).toMatchObject({
    metricType: 'histogram', unit: 's', temporality: 'delta', count: '4', sum: 1.2, bucketCounts: ['1','2','1'], explicitBounds: [0.1,0.5],
    serviceName: 'api', serviceVersion: 'build-1', serviceInstanceId: 'instance-a', scopeName: '@opentelemetry/instrumentation-http',
    dimensions: { 'http.route': '/users/{id}', 'http.request.method': 'GET' },
   });
   expect(points.find(point => point.name === 'http.server.active_requests')).toMatchObject({ value: '-2', isMonotonic: false, temporality: 'cumulative' });
   expect(JSON.stringify(points)).not.toMatch(/secret|url.full|user.id/);
   expect(await runtime.store.metricPoints({ worktree: 'other', since: 0, until: 3000 })).toEqual([]);
   expect(publications).toHaveLength(2); // one log batch, one genuinely changed metric batch
   const cumulative = await fetch(`${receiver.endpoint}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceMetrics: [{ resource: request.resourceMetrics[0]!.resource, scopeMetrics: [{ metrics: [{ name: 'request_count', unit: '{request}', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [
     { startTimeUnixNano: '100000000', timeUnixNano: '500000000', asInt: '10' },
     { startTimeUnixNano: '100000000', timeUnixNano: '1000000000', asInt: '20' },
     { startTimeUnixNano: '100000000', timeUnixNano: '2000000000', asInt: '25' },
     { startTimeUnixNano: '100000000', timeUnixNano: '3000000000', asInt: '35' },
    ] } }] }] }] }) });
   expect(cumulative.status).toBe(200);
   const counted = await runtime.store.metricPoints({ worktree: 'selected', name: 'request_count', since: 1000, until: 3000 });
   expect(counted).toHaveLength(3);
   expect(analyzeMetricWindow(counted, {since:1000,until:3000,statistic:'sum'})).toMatchObject({status:'complete',value:15});
   metricsEnabled = false;
   const disabled = await fetch(`${receiver.endpoint}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
   expect(disabled.status).toBe(403);
   const stillLogging = await fetch(`${receiver.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '2500000000', body: { stringValue: 'still logging' } }] }] }] }) });
   expect(stillLogging.status).toBe(200);
   const stillTracing = await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[{traceId:'0123456789abcdef0123456789abcdef',spanId:'0123456789abcdef',name:'GET /control',startTimeUnixNano:'2000000000',endTimeUnixNano:'2500000000'}]}]}]}) });
   expect(stillTracing.status).toBe(200);
   expect(await runtime.store.list({worktree:'selected',kind:'span',limit:10})).toHaveLength(1);
   expect(await runtime.store.metricPoints({ worktree: 'selected', since: 1000, until: 3000 })).toHaveLength(6);
   metricsEnabled = true;
   const unsupported = await fetch(`${receiver.endpoint}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [
     { name: 'exponential', exponentialHistogram: { dataPoints: [{ count: '2' }, { count: '1' }] } },
     { name: 'bad', histogram: { aggregationTemporality: 1, dataPoints: [{ count: '3', explicitBounds: [1], bucketCounts: ['1','1'] }] } },
    ] }] }] }) });
   expect(unsupported.status).toBe(200);
   expect(await unsupported.json()).toMatchObject({ partialSuccess: { rejectedDataPoints: '3', errorMessage: expect.stringContaining('exponentialHistogram') } });
   selectedPartition = 'metric-only';
   const bounds = Array.from({ length: 1501 }, (_, index) => index);
   const large = await fetch(`${receiver.endpoint}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'runtime.gc.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{
     startTimeUnixNano: '1000000000', timeUnixNano: '2000000000', count: String(bounds.length + 1), explicitBounds: bounds, bucketCounts: Array.from({length:bounds.length+1}, () => '1'),
    }] } }] }] }] }) });
   expect(large.status).toBe(200);
   expect((await runtime.store.metricPoints({worktree:'metric-only',since:1000,until:3000}))[0]).toMatchObject({explicitBounds:bounds,bucketCounts:Array.from({length:bounds.length+1}, () => '1')});
   expect(await runtime.store.listPartitions()).toContain('metric-only');
   await runtime.clear('metric-only');
   expect(await runtime.store.listPartitions()).not.toContain('metric-only');
   expect(await sqlite.db.query('SELECT COUNT(*) AS count FROM metricBuckets WHERE worktree=?', ['metric-only'])).toEqual([{count:0}]);
   expect(await runtime.store.metricPoints({ worktree: 'selected', since: 0, until: 3000 })).toHaveLength(7);
   expect(await runtime.store.list({ worktree: 'selected', kind: 'log', limit: 10 })).toHaveLength(2);
   await runtime.clear('selected');
   expect(await runtime.store.metricPoints({ worktree: 'selected', since: 0, until: 3000 })).toEqual([]);
  } finally { await receiver.release(); await runtime.ingest.settled(); sqlite.close(); }
 });
});
