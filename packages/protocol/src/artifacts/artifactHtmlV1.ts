import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';

export const ARTIFACT_HTML_BUNDLE_MIME_V1 = 'application/vnd.happier.html-bundle+json';

/** Executable declarations are closed. Assets share the existing single blob's custody. */
const safePath = z.string().min(1).refine(path => !/[\\%?#:\u0000-\u001f\u007f]/u.test(path)
  && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
    && part !== '__proto__' && part !== 'constructor' && part !== 'prototype'), 'Unsafe HTML bundle path');
export const ArtifactHtmlBundleV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), entrypoint: safePath,
  files: z.record(safePath, z.object({
    mime: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u),
    contentBase64: z.string().refine(value => readCanonicalPaddedBase64DecodedLength(value) !== null, 'Invalid asset bytes'),
  }).strict()),
}).strict().superRefine((bundle, context) => {
  if (!Object.hasOwn(bundle.files, bundle.entrypoint) || bundle.files[bundle.entrypoint].mime.toLowerCase() !== 'text/html') {
    context.addIssue({ code: 'custom', message: 'HTML entrypoint is unavailable' });
  }
}));
export type ArtifactHtmlBundleV1 = z.infer<typeof ArtifactHtmlBundleV1Schema>;

function readArtifactHtmlPreviewUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && /^\/a\/[^/]+$/u.test(url.pathname) ? url : null;
  } catch { return null; }
}

export const ArtifactHtmlPreviewResponseV1Schema = lazyZodSchema(() => z.object({ url: z.string().refine(value => readArtifactHtmlPreviewUrl(value) !== null,
  'Invalid isolated HTML preview URL') }).strict());

export function isArtifactHtmlHeaderV1(header: unknown): boolean {
  return header !== null && typeof header === 'object' && !Array.isArray(header) && Reflect.get(header, 'kind') === 'html';
}

export function artifactHtmlBundleFromBodyV1(body: string | Uint8Array, mime = 'text/html'): ArtifactHtmlBundleV1 {
  const text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body);
  const essence = mime.split(';', 1)[0].trim().toLowerCase();
  if (essence === ARTIFACT_HTML_BUNDLE_MIME_V1) return ArtifactHtmlBundleV1Schema.parse(JSON.parse(text));
  if (essence !== 'text/html') throw new Error('Unsupported HTML Artifact MIME');
  return { v: 1, entrypoint: 'index.html', files: { 'index.html': {
    mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode(text)),
  } } };
}
