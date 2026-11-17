import { createHash } from 'node:crypto';
import type { DaemonDatabaseTransaction, DaemonDatabaseMigration, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';
import type { NormalizedMetricPoint } from '../otlp/types.js';

/** Same emitter stream, independent of its samples and aggregation start/reset. */
export function metricSeriesKey(point: NormalizedMetricPoint): string {
 return JSON.stringify([point.name,point.unit,point.metricType,point.temporality,point.scopeName,point.scopeVersion,
  point.resourceSchemaUrl,point.scopeSchemaUrl,point.serviceName,point.serviceVersion,point.serviceInstanceId,point.streamIdentity,
  Object.entries(point.dimensions).sort(([a],[b]) => a.localeCompare(b)), point.metricType === 'sum' ? point.isMonotonic : null]);
}
export function metricPointId(point: NormalizedMetricPoint): string {
 return createHash('sha256').update(JSON.stringify([metricSeriesKey(point),point.startTimeUnixNano,point.timeUnixNano])).digest('hex');
}
export const metricMigration: DaemonDatabaseMigration = { version: 4, id: 'metric-points', async up(tx) {
 await tx.execute('CREATE TABLE metricPoints (worktree TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,series TEXT NOT NULL,name TEXT NOT NULL,serviceName TEXT,serviceVersion TEXT,body TEXT NOT NULL,PRIMARY KEY(worktree,id))');
 await tx.execute('CREATE INDEX metricPartitionWindow ON metricPoints(worktree,at,id)');
 await tx.execute('CREATE INDEX metricWindow ON metricPoints(worktree,name,serviceName,at,id)');
 await tx.execute('CREATE INDEX metricSeriesWindow ON metricPoints(worktree,series,at,id)');
 await tx.execute('CREATE TABLE metricBuckets (worktree TEXT NOT NULL,pointId TEXT NOT NULL,at INTEGER NOT NULL,ordinal INTEGER NOT NULL,bucketCount TEXT NOT NULL,bound REAL,PRIMARY KEY(worktree,pointId,ordinal))');
} };
export const metricRetention = [
 { table: 'metricBuckets', timeColumn: 'at', changeKeyColumn: 'worktree' },
 { table: 'metricPoints', timeColumn: 'at', changeKeyColumn: 'worktree' },
] as const;
export type MetricPointsInput = Readonly<{worktree:string;since:number;until:number;name?:string;serviceName?:string;serviceVersion?:string}>;

/** Bucket rows preserve full histograms within the host's per-statement bounds, without a detail preview. */
export async function writeMetricPoint(tx: DaemonDatabaseTransaction, worktree: string, point: NormalizedMetricPoint): Promise<boolean> {
 const id = metricPointId(point);
 const at = Number(BigInt(point.timeUnixNano)) / 1_000_000;
 const body = point.metricType === 'histogram' ? JSON.stringify({...point,bucketCounts:undefined,explicitBounds:undefined}) : JSON.stringify(point);
 const result = await tx.execute('INSERT INTO metricPoints(worktree,id,at,series,name,serviceName,serviceVersion,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(worktree,id) DO UPDATE SET body=excluded.body WHERE body IS NOT excluded.body',
  [worktree,id,at,metricSeriesKey(point),point.name,point.serviceName??null,point.serviceVersion??null,body]);
 let changed = result.changes > 0;
 if (point.metricType === 'histogram') {
  const statement = 'INSERT INTO metricBuckets(worktree,pointId,at,ordinal,bucketCount,bound) SELECT ?,?,?,json_extract(value,\'$[0]\'),json_extract(value,\'$[1]\'),json_extract(value,\'$[2]\') FROM json_each(?) WHERE true ON CONFLICT(worktree,pointId,ordinal) DO UPDATE SET bucketCount=excluded.bucketCount,bound=excluded.bound WHERE bucketCount IS NOT excluded.bucketCount OR bound IS NOT excluded.bound';
  const inputBytes = limits.maximumInputBytes - Buffer.byteLength(statement) - Buffer.byteLength(worktree) - Buffer.byteLength(id) - 8;
  let rows: string[] = [], bytes = 2;
  async function flush() {
   if (!rows.length) return;
   const bucket = await tx.execute(statement, [worktree,id,at,`[${rows.join(',')}]`]);
   changed ||= bucket.changes > 0;
   rows = []; bytes = 2;
  }
  for (let ordinal=0;ordinal<point.bucketCounts.length;ordinal++) {
   const row = JSON.stringify([ordinal,point.bucketCounts[ordinal]!,point.explicitBounds[ordinal]??null]);
   const rowBytes = Buffer.byteLength(row);
   if (rows.length && (rows.length === limits.maximumAffectedRows || bytes + 1 + rowBytes > inputBytes)) await flush();
   bytes += (rows.length ? 1 : 0) + rowBytes;
   rows.push(row);
  }
  await flush();
  let removed: number;
  do {
   const result = await tx.execute('DELETE FROM metricBuckets WHERE rowid IN(SELECT rowid FROM metricBuckets WHERE worktree=? AND pointId=? AND ordinal>=? LIMIT ?)', [worktree,id,point.bucketCounts.length,limits.maximumAffectedRows]);
   removed = result.changes; changed ||= removed > 0;
  } while (removed === limits.maximumAffectedRows);
 }
 return changed;
}

export function createMetricStore(queryPage: <T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[], requested: number) => Promise<{ rows: readonly T[]; pageSize: number }>) {
 return {
  /** Includes each selected series' last pre-window sample for cumulative differencing. */
  async metricPoints(input:MetricPointsInput):Promise<readonly NormalizedMetricPoint[]> {
   const filters=['worktree=?','at<=?','at>?'];
   const params:DaemonDatabaseValue[]=[input.worktree,input.until,input.since];
   for(const [column,value] of [['name',input.name],['serviceName',input.serviceName],['serviceVersion',input.serviceVersion]] as const) {
    if(value!==undefined){filters.push(`${column}=?`);params.push(value);}
   }
   const result:NormalizedMetricPoint[]=[];
   let cursor:{at:number;id:string}|undefined;
   while(true) {
    const cursorFilter=cursor?'AND (at>? OR (at=? AND id>?))':'';
    const args=[...params,input.since,...(cursor?[cursor.at,cursor.at,cursor.id]:[])];
    const selected=await queryPage(`WITH current AS (SELECT * FROM metricPoints WHERE ${filters.join(' AND ')}),
prior AS (SELECT (SELECT previous.id FROM metricPoints previous WHERE previous.worktree=current.worktree AND previous.series=current.series AND previous.at<=? ORDER BY previous.at DESC,previous.id DESC LIMIT 1) AS id FROM current GROUP BY series),
selected AS (SELECT id,at,body FROM current UNION SELECT id,at,body FROM metricPoints WHERE worktree=(SELECT worktree FROM current LIMIT 1) AND id IN(SELECT id FROM prior))
SELECT id,at,body FROM selected WHERE 1=1 ${cursorFilter} ORDER BY at,id LIMIT ?`,args,limits.maximumResultRows);
    for(const row of selected.rows) {
     // These rows have one producer; JSON and SQLite are the persistence boundary.
     const point=JSON.parse(String(row.body)) as NormalizedMetricPoint;
     if(point.metricType==='histogram') {
      const buckets:DaemonDatabaseRow[]=[];
      let after=-1;
      while(true) {
       const current=await queryPage('SELECT ordinal,bucketCount,bound FROM metricBuckets WHERE worktree=? AND pointId=? AND ordinal>? ORDER BY ordinal LIMIT ?',[input.worktree,String(row.id),after],limits.maximumResultRows);
       buckets.push(...current.rows);
       if(current.rows.length<current.pageSize)break;
       after=Number(current.rows.at(-1)!.ordinal);
      }
      const bucketCounts=buckets.map(bucket=>String(bucket.bucketCount));
      // The retention owner removes host-sized table chunks independently. A
      // surviving point must not reinterpret a partial bucket chunk as a smaller histogram.
      const complete=buckets.length>0&&buckets.every((bucket,index)=>Number(bucket.ordinal)===index)
       &&buckets.at(-1)!.bound===null&&bucketCounts.reduce((count,value)=>count+BigInt(value),0n)===BigInt(point.count);
      result.push({...point,...(complete?{}:{incompleteBuckets:true as const}),bucketCounts,
       explicitBounds:buckets.filter(bucket=>bucket.bound!==null).map(bucket=>Number(bucket.bound))});
     } else result.push(point);
    }
    if(selected.rows.length<selected.pageSize)break;
    const last=selected.rows.at(-1)!;
    cursor={at:Number(last.at),id:String(last.id)};
   }
   return result;
  },
 };
}
