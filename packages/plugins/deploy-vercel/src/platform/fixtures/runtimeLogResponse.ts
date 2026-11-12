/** Recorded documentation example, retrieved 2026-11-12; not tenant traffic.
 * https://vercel.com/docs/rest-api/logs/get-logs-for-a-deployment
 * The rendered example quotes boolean/numeric values. The OpenAPI response
 * schema at https://openapi.vercel.sh requires boolean/number respectively;
 * tests label the corresponding typed replay as derived rather than captured.
 * NDJSON representation: official CLI c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb
 * util/logs.ts:162–193, immediately before main84878e5 removed the legacy CLI.
 * https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/util/logs.ts
 * OpenAPI omits its format=lines query; this pinned primary consumer establishes
 * that representation. Live provider compatibility remains a release check.
 */
export const recordedVercelRuntimeLog = {
  domain: 'string', level: 'debug', message: 'string', messageTruncated: 'false',
  requestMethod: 'string', requestPath: 'string', responseStatusCode: '123',
  rowId: 'example_id', source: 'delimiter', timestampInMs: '123',
} as const;
export const openApiTypedRuntimeLog = { ...recordedVercelRuntimeLog,
  messageTruncated: false, responseStatusCode: 123, timestampInMs: 123 } as const;
