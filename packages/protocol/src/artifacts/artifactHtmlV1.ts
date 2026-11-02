import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { UiSurfaceCapabilityRequestV1Schema } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { isPortableRelativePath } from '../filesystem/portablePathSegment.js';

export const ARTIFACT_HTML_BUNDLE_MIME_V1 = 'application/vnd.happier.html-bundle+json';

/** Executable declarations are closed. Assets share the existing single blob's custody. */
const safePath = z.string().check(z.minLength(1), z.refine(path => !/[\\%?#:\u0000-\u001f\u007f]/u.test(path)
  && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
    && part !== '__proto__' && part !== 'constructor' && part !== 'prototype'), 'Unsafe HTML bundle path'));
function defineHtmlBundleSchema(pathSchema: typeof safePath) {
  return z.strictObject({
    v: z.literal(1), entrypoint: pathSchema,
    files: z.record(pathSchema, z.strictObject({
      mime: z.string().check(z.regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u)),
      contentBase64: z.string().check(z.refine(value => readCanonicalPaddedBase64DecodedLength(value) !== null, 'Invalid asset bytes')),
    })),
    /** Saved copies keep their admitted policy independently of viewer settings. */
    requestedCapabilities: z.optional(UiSurfaceCapabilityRequestV1Schema),
  }).check(z.superRefine((bundle, context) => {
    if (!Object.hasOwn(bundle.files, bundle.entrypoint) || bundle.files[bundle.entrypoint].mime.toLowerCase() !== 'text/html') {
      context.addIssue({ code: 'custom', message: 'HTML entrypoint is unavailable' });
    }
  }));
}
export const ArtifactHtmlBundleV1Schema = lazyZodSchema(() => defineHtmlBundleSchema(safePath));
/** Verified generated graphs retain their producer's portable physical filenames. */
export const GeneratedArtifactHtmlBundleV1Schema = lazyZodSchema(() => defineHtmlBundleSchema(
  z.string().check(z.refine(isPortableRelativePath, 'Unsafe generated HTML bundle path')),
));
export type ArtifactHtmlBundleV1 = z.infer<typeof ArtifactHtmlBundleV1Schema>;

function readArtifactHtmlPreviewUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && /^\/a\/[^/]+$/u.test(url.pathname) ? url : null;
  } catch { return null; }
}

export const ArtifactHtmlPreviewResponseV1Schema = lazyZodSchema(() => z.strictObject({ url: z.string().check(z.refine(value => readArtifactHtmlPreviewUrl(value) !== null, 'Invalid isolated HTML preview URL')) }));

export function isArtifactHtmlHeaderV1(header: unknown): boolean {
  return header !== null && typeof header === 'object' && !Array.isArray(header) && Reflect.get(header, 'kind') === 'html';
}

export function artifactHtmlBundleFromBodyV1(body: string | Uint8Array, mime = 'text/html',
  purpose: 'input' | 'stored' = 'input'): ArtifactHtmlBundleV1 {
  const text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body);
  const essence = mime.split(';', 1)[0].trim().toLowerCase();
  if (essence === ARTIFACT_HTML_BUNDLE_MIME_V1) return (purpose === 'stored'
    ? createStoredReadSchema(ArtifactHtmlBundleV1Schema)
    : ArtifactHtmlBundleV1Schema).parse(JSON.parse(text));
  if (essence !== 'text/html') throw new Error('Unsupported HTML Artifact MIME');
  return { v: 1, entrypoint: 'index.html', files: { 'index.html': {
    mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode(text)),
  } } };
}
