import { createHmac, randomBytes } from 'node:crypto';
import { isBaseCredentialDiagnosticKey, isUnsafeTelemetryDataKey } from '@happier-dev/protocol/common/sensitiveKeys';
import { parseDatabaseConnectionUrl } from '../connection.js';
import { PostgresqlInputError, type PostgresqlLexicalToken } from './input.js';
import { normalizePostgresqlStatement } from './statement.js';

export type PostgresqlObservationValue = null | boolean | number | string | PostgresqlObservationValue[] | { [key: string]: PostgresqlObservationValue };
export type PostgresqlObservation = Readonly<{
 shape: string | null; fingerprint: string | null; statementKind: 'select' | 'control' | 'other' | 'unknown';
 maskedSql: string | null; maskedParameters: PostgresqlObservationValue; parameterIdentity?: string;
}>;
function canonical(value: PostgresqlObservationValue): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
 return JSON.stringify(value);
}
function sensitive(name: string) { return isBaseCredentialDiagnosticKey(name) || isUnsafeTelemetryDataKey(name) || name.toLowerCase() === 'secret'; }
function credentialUrl(value: string): boolean {
 try { const url=new URL(value); return Boolean(url.username || url.password); }
 catch { return false; }
}
function mask(value: PostgresqlObservationValue, redact: boolean): PostgresqlObservationValue {
 if (Array.isArray(value)) return value.map(item => mask(item, redact));
 if (value !== null && typeof value === 'object') {
  // Wire values retain ordinal/type/format metadata; only their value is redacted.
  const typedParameter = typeof value.format === 'string' && Object.hasOwn(value, 'value');
  const binaryCredential = typedParameter && value.format === 'binary' && typeof value.value === 'string'
   && credentialUrl(Buffer.from(value.value, 'base64').toString('utf8'));
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,
   typedParameter && key !== 'value' ? mask(item, sensitive(key)) : mask(item, redact || sensitive(key) || binaryCredential)]));
 }
 if (redact && value !== null) return '[redacted]';
 if (typeof value === 'string' && credentialUrl(value)) return '[redacted]';
 return value;
}
/** Capture and analysis share the dialect's scanner and masking policy. The keyed
 * equality token permits comparison without persisting a guessable hash of a password. */
export function createPostgresqlObservationNormalizer() {
 const equalityKey = randomBytes(32);
 return (sql: string, parameters: Readonly<Record<string, PostgresqlObservationValue>> = {}): PostgresqlObservation => {
  const tokens: PostgresqlLexicalToken[] = [];
  let normalized: ReturnType<typeof normalizePostgresqlStatement>;
  try { normalized = normalizePostgresqlStatement(sql, { token: token => tokens.push(token) }); }
  catch (error) {
   if (!(error instanceof PostgresqlInputError)) throw error;
   return { shape:null, fingerprint:null, statementKind:'unknown', maskedSql:null, maskedParameters:mask({...parameters},true) };
  }
  const words = tokens.filter(token => token.kind === 'word' || token.kind === 'identifier')
   .map(token => sql.slice(token.start, token.end).replace(/^"|"$/g, '').toLowerCase());
  const hasSensitiveField = words.some(sensitive);
  let depth = 0;
  let command: string | undefined;
  for (const token of tokens) {
   const value = sql.slice(token.start, token.end).toLowerCase();
   if (token.kind === 'symbol') { if (value === '(') depth++; if (value === ')') depth--; }
   if (depth || token.kind !== 'word') continue;
   if (command === undefined) { command = value; if (command !== 'with') break; }
   else if (['select','insert','update','delete','merge'].includes(value)) { command = value; break; }
  }
  const statementKind = command === 'select' ? 'select' : command && ['begin','start','commit','end','rollback','abort','savepoint','release'].includes(command) ? 'control' : command ? 'other' : 'unknown';
  const literalValues = tokens.filter(token => token.kind === 'literal').map(token => sql.slice(token.start,token.end));
  const equality = { parameters: { ...parameters }, literals: literalValues } satisfies PostgresqlObservationValue;
  const parameterIdentity = Object.keys(parameters).length || literalValues.length ? createHmac('sha256', equalityKey).update(canonical(equality)).digest('hex') : undefined;
  // Comments are not copied into detail; they may contain tokens or credentials.
  const maskedSql = tokens.map(token => token.kind === 'literal' ? "'[redacted]'" : sql.slice(token.start, token.end)).join(' ');
  return { ...normalized, statementKind, maskedSql, maskedParameters: mask({ ...parameters }, hasSensitiveField), ...(parameterIdentity ? { parameterIdentity } : {}) };
 };
}
/** Free-form backend errors can echo uncaptured values, including server detail.
 * Structured code/severity/position remain useful and safe; text is redacted. */
export function maskPostgresqlObservationError(input: Readonly<{code?:string;severity?:string;position?:string|number;message?:string}>) {
 return { ...(input.code ? {code:input.code} : {}), ...(input.severity ? {severity:input.severity} : {}), ...(input.position ? {position:input.position} : {}), ...(input.message ? {message:'[redacted]'} : {}) };
}
export type PostgresqlCaptureUrl = Readonly<
 {eligible:false;reason:'unsupported_database_url'|'unsupported_loopback_authority'|'tls_required'|'host_override'} |
 {eligible:true;upstream:Readonly<{host:string;port:number}>;hostSpan:Readonly<{start:number;end:number}>}
>;
/** Eligibility and exact authority span belong beside the connection URL parser. */
export function postgresqlCaptureUrl(input: string): PostgresqlCaptureUrl {
 try {
  const connection = parseDatabaseConnectionUrl(input);
  if (connection.engine !== 'postgresql') return {eligible:false,reason:'unsupported_database_url'};
  const host = connection.hostname.replace(/^\[|\]$/g,'');
  if (!['localhost','127.0.0.1','::1'].includes(host)) return {eligible:false,reason:'unsupported_loopback_authority'};
  for (const [key,value] of Object.entries(connection.options)) {
   const name=key.toLowerCase();
   if (['host','hostaddr','port','service'].includes(name)) return {eligible:false,reason:'host_override'};
   if ((name==='sslmode' && !['disable','allow','prefer'].includes(value.toLowerCase()))
    || (name==='ssl' && value.toLowerCase()!=='false' && value!=='0') || ['sslcert','sslkey','sslrootcert'].includes(name)) return {eligible:false,reason:'tls_required'};
  }
  const authorityStart=input.indexOf('//')+2;
  const authorityEnd=input.slice(authorityStart).search(/[/?#]/);
  const end=authorityEnd<0 ? input.length : authorityStart+authorityEnd;
  const authority=input.slice(authorityStart,end);
  const start=authorityStart+authority.lastIndexOf('@')+1;
  return {eligible:true,upstream:{host,port:connection.port ?? 5432},hostSpan:{start,end}};
 } catch { return {eligible:false,reason:'unsupported_database_url'}; }
}
