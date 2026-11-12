/** Recorded excerpts of Cloudflare's published HTTP 200 response examples, 2026-11-12.
 * Literal field values are unchanged; unrelated response fields are omitted.
 * These are documentation examples, not captured tenant traffic. Tests separately
 * construct identity/envelope fields and mutation/error scenarios.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
 */
export const pagesDeploymentConfigExample = {
  compatibility_date: '2025-01-01T00:00:00Z',
  env_vars: { foo: { type: 'plain_text', value: 'hello world' } },
  wrangler_config_hash: 'abc123def456',
} as const;

export const workerSettingsExample = {
  annotations: { 'workers/message': 'Fixed bug.', 'workers/tag': 'v1.0.1', 'workers/triggered_by': 'upload' },
  bindings: [{ name: 'MY_ENV_VAR', text: 'my_data', type: 'plain_text' }],
  compatibility_date: '2021-01-01T00:00:00Z',
  compatibility_flags: ['nodejs_compat'],
} as const;

/** Recorded official OpenAPI workers_env example, checked 2026-11-12.
 * workers_PreviewDeploymentConfig references this schema for its env field and
 * documents that GET returns both env and bindings. No tenant traffic captured.
 * https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json
 */
export const workerPreviewEnvExample = {
  MY_ENV_VAR: { text: 'my_data', type: 'plain_text' },
} as const;
