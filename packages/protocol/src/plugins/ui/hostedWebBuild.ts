import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const PluginHostedWebRuntimeModeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('installedStaticAssets'),
    artifactId: z.string().check(z.trim(), z.minLength(1)),
    assetRootId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('registeredSessionEndpoint'),
    endpointIdPath: z.string().check(z.trim(), z.minLength(1)),
  }),
]));
export type PluginHostedWebRuntimeModeV1 =
  z.infer<typeof PluginHostedWebRuntimeModeV1Schema>;

/**
 * Canonical preview-id scheme for an `installedStaticAssets` hosted-web surface.
 *
 * The daemon static-asset server registers a local-service preview under this id
 * when it serves a plugin's installed static bundle; the UI builds a matching
 * `localServicePreview` browser target from the same id to correlate the served
 * loopback endpoint back into the surface. The id is scoped to the session and
 * machine because the same installed plugin surface can be served concurrently
 * for multiple sessions/machines. Both sides MUST derive the id from this single
 * owner so the correlation never silently misses or crosses sessions (Phase 6.1).
 */
export function sanitizePluginHostedWebPreviewIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/gu, '-');
}

export function buildPluginHostedWebStaticAssetPreviewId(input: Readonly<{
  pluginId: string;
  contributionId: string;
  sessionId: string;
  machineId: string;
}>): string {
  return [
    'plugin-static',
    sanitizePluginHostedWebPreviewIdPart(input.pluginId),
    sanitizePluginHostedWebPreviewIdPart(input.contributionId),
    sanitizePluginHostedWebPreviewIdPart(input.sessionId),
    sanitizePluginHostedWebPreviewIdPart(input.machineId),
  ].join(':');
}
