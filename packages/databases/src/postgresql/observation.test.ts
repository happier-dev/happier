import { createHash, createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createPostgresqlObservationNormalizer, postgresqlCaptureUrl } from './observation.js';
describe('canonical PostgreSQL observation boundary', () => {
 it('preserves the HMAC-SHA256 equality encoding without an unkeyed secret digest', () => {
  const key = new Uint8Array(32).fill(0x5a);
  // Randomness is the external boundary; masking and HMAC remain real.
  vi.stubGlobal('crypto', { getRandomValues(value: Uint8Array) { value.set(key); return value; } });
  try {
   const result = createPostgresqlObservationNormalizer()('SELECT $1', { '1': 'private-value' });
   expect(result.fingerprint).toBe(createHash('sha256').update(result.shape!).digest('hex'));
   expect(result.parameterIdentity).toBe(createHmac('sha256', key)
    .update('{"literals":[],"parameters":{"1":"private-value"}}').digest('hex'));
  } finally { vi.unstubAllGlobals(); }
 });
 it.each([
  'password', String.raw`U&"\0070assword"`, String.raw`U&"!0070assword" UESCAPE '!'`,
 ].flatMap(identifier => ['text', 'binary'].map(format => ({ identifier, format }))))('redacts $format parameters for equivalent sensitive identifier $identifier', ({ identifier, format }) => {
  const value = format === 'binary' ? Buffer.from('private-identifier-value').toString('base64') : 'private-identifier-value';
  const result = createPostgresqlObservationNormalizer()(`INSERT INTO users (${identifier}) VALUES ($1)`, {
   '1': { ordinal: 1, typeOid: 25, format, value },
  });
  expect(result.maskedParameters).toEqual({ '1': { ordinal: 1, typeOid: 25, format, value: '[redacted]' } });
 });
 it.each(['text', 'binary'])('redacts database URL query credentials in $format parameters through the shared URL policy', format => {
  const url = 'postgresql://localhost/db?password=private-url-value&sslmode=prefer';
  const value = format === 'binary' ? Buffer.from(url).toString('base64') : url;
  const normalize = createPostgresqlObservationNormalizer();
  expect(normalize('SELECT $1', { '1': { ordinal: 1, format, value } }).maskedParameters)
   .toEqual({ '1': { ordinal: 1, format, value: '[redacted]' } });
  expect(normalize('SELECT $1', { '1': 'postgresql://localhost/db' }).maskedParameters)
   .toEqual({ '1': 'postgresql://localhost/db' });
 });
 it('classifies SELECT-like CTE and control statements, removes sensitive values and preserves parameter equality without publishing it', () => {
  const normalize = createPostgresqlObservationNormalizer();
  const first = normalize('WITH x AS (SELECT $1) SELECT * FROM users WHERE password=$2', { '1': { ordinal: 1, format: 'text', value: 'alice' }, '2': { ordinal: 2, format: 'text', value: 'private-password' } });
  const same = normalize('WITH x AS (SELECT $1) SELECT * FROM users WHERE password=$2', { '1': { ordinal: 1, format: 'text', value: 'alice' }, '2': { ordinal: 2, format: 'text', value: 'private-password' } });
  expect(first.statementKind).toBe('select');
  expect(first.parameterIdentity).toBeTruthy();
  expect(first.parameterIdentity).toBe(same.parameterIdentity);
  expect(first.parameterIdentity).toMatch(/^[a-f0-9]{64}$/);
  expect(createPostgresqlObservationNormalizer()('WITH x AS (SELECT $1) SELECT * FROM users WHERE password=$2', {
   '1': { ordinal: 1, format: 'text', value: 'alice' }, '2': { ordinal: 2, format: 'text', value: 'private-password' },
  }).parameterIdentity).not.toBe(first.parameterIdentity);
  expect(first.maskedParameters).toMatchObject({ '2': { ordinal: 2, format: 'text', value: '[redacted]' } });
  expect(JSON.stringify(first)).not.toContain('private-password');
  expect(normalize("ALTER ROLE alice PASSWORD $tag$secret-value$tag$").maskedSql).not.toContain('secret-value');
  expect(normalize('SAVEPOINT s').statementKind).toBe('control');
  expect(normalize('SELECT $1', { '1': 'a' }).parameterIdentity).not.toBe(normalize('SELECT $1', { '1': 'b' }).parameterIdentity);
 });
 it('admits only eligible loopback non-required-TLS URLs and returns the original authority byte span', () => {
  const original = 'postgresql://user:p%40ss@[::1]:5439/db?sslmode=prefer&application_name=test';
  const result = postgresqlCaptureUrl(original);
  expect(result.eligible).toBe(true);
  if (!result.eligible) throw new Error('Expected eligible URL');
  expect(result.upstream).toEqual({ host: '::1', port: 5439 });
  expect(original.slice(result.hostSpan.start, result.hostSpan.end)).toBe('[::1]:5439');
  for (const value of ['postgres://db.example/db', 'postgres://127.0.0.1/db?sslmode=require', 'postgres://localhost/db?ssl=true', 'postgres://localhost/db?sslmode=verify-full']) expect(postgresqlCaptureUrl(value).eligible).toBe(false);
  expect(postgresqlCaptureUrl('postgres://127.42.1.2/db').eligible).toBe(false);
 });
 it('never copies SQL literals or credential URLs into captured detail', () => {
  const normalize = createPostgresqlObservationNormalizer();
  const result=normalize("SELECT 'postgresql://alice:private-password@localhost/db'", { target: 'postgresql://alice:private-password@localhost/db' });
  expect(JSON.stringify(result)).not.toContain('private-password');
  expect(JSON.stringify(normalize('SELECT $1', { '1': {format:'text',value:'safe',password:'private-password'} }))).not.toContain('private-password');
 });
 it('retains an unknown observation when canonical SQL parsing refuses incomplete input', () => {
  const result=createPostgresqlObservationNormalizer()("SELECT 'unterminated-private-value", { '1': { ordinal: 1, format: 'text', value: 'private-password' } });
  expect(result).toMatchObject({ shape:null, fingerprint:null, maskedSql:null, statementKind:'unknown', maskedParameters:{'1':{ordinal:1,format:'text',value:'[redacted]'}} });
  expect(JSON.stringify(result)).not.toContain('private-');
 });
 it('redacts credential URLs carried by binary wire parameters while preserving ordinary binary values and metadata', () => {
  const normalize=createPostgresqlObservationNormalizer();
  const credential=Buffer.from('postgresql://alice:private-password@localhost/db').toString('base64');
  const ordinary=Buffer.from([0,1,2,255]).toString('base64');
  const result=normalize('SELECT $1,$2', {'1':{ordinal:1,typeOid:17,format:'binary',value:credential},'2':{ordinal:2,typeOid:17,format:'binary',value:ordinary}});
  expect(result.maskedParameters).toEqual({'1':{ordinal:1,typeOid:17,format:'binary',value:'[redacted]'},'2':{ordinal:2,typeOid:17,format:'binary',value:ordinary}});
  expect(JSON.stringify(result)).not.toContain(credential);
 });

});
