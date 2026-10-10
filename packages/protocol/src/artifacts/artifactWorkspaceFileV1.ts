import { ARTIFACT_HTML_BUNDLE_MIME_V1, artifactHtmlBundleFromBodyV1, type ArtifactHtmlBundleV1 } from './artifactHtmlV1.js';
import { ArtifactWorkspaceSourceV1Schema } from './artifactBinaryV1.js';
import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ArtifactHtmlBundleV1Schema } from './artifactHtmlV1.js';

/** Acquisition intent is Action input only; stored HTML always carries a by-value bundle. */
export const ArtifactWorkspacePublicationSourceV1Schema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  entrypoint: z.lazy(() => ArtifactHtmlBundleV1Schema.shape.entrypoint).optional(),
}).strict());

/** File classification and provenance shared by the keyholding publication hosts. */
export function prepareArtifactWorkspaceFileV1(params: Readonly<{
  caller: Readonly<{ sessionId: string; machineId: string; runId?: string }>;
  file: Readonly<{ bytes: Uint8Array; name: string; path: string; sha: string; bundle?: ArtifactHtmlBundleV1 }>;
  input: Readonly<{ title?: string; mime?: string; kind?: string }>;
}>) {
  const { file, input, caller } = params;
  const declaredMime = input.mime?.split(';', 1)[0].trim().toLowerCase();
  if (file.bundle && ((input.kind !== undefined && input.kind !== 'html')
    || (declaredMime !== undefined && declaredMime !== ARTIFACT_HTML_BUNDLE_MIME_V1))) {
    throw Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
  }
  const acquiredBundle = file.bundle ? ArtifactHtmlBundleV1Schema.parse(file.bundle) : undefined;
  const inferredHtml = input.kind === undefined && (declaredMime === 'text/html'
    || declaredMime === ARTIFACT_HTML_BUNDLE_MIME_V1
    || (!input.mime && file.name.lastIndexOf('.') > 0 && /\.html?$/i.test(file.name)));
  const kind = input.kind ?? (acquiredBundle || inferredHtml ? 'html' : 'published.v1');
  const allowsText = !acquiredBundle && (!declaredMime || declaredMime.startsWith('text/')
    || ['application/json', 'application/javascript', 'application/xml'].includes(declaredMime));
  let body: string | undefined;
  if (allowsText) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
      if (!decoded.includes('\0')) body = decoded;
    } catch { /* Non-UTF8 content uses the binary body path. */ }
  }
  const mime = acquiredBundle ? ARTIFACT_HTML_BUNDLE_MIME_V1
    : input.mime ?? (kind === 'html' ? 'text/html' : body === undefined ? 'application/octet-stream' : 'text/plain');
  const header = { title: input.title ?? file.name, kind, mime, sizeBytes: file.bytes.length };
  const source = ArtifactWorkspaceSourceV1Schema.parse({ sessionId: caller.sessionId, ...(caller.runId ? { runId: caller.runId } : {}),
    machineId: caller.machineId, path: file.path, sha: file.sha });
  let bundle = acquiredBundle;
  if (!bundle && kind === 'html') {
    try { bundle = artifactHtmlBundleFromBodyV1(file.bytes, mime); }
    catch { /* Ordinary file publication retains its existing unavailable-preview result. */ }
  }
  return body === undefined ? { header, source, binary: { bytes: file.bytes, mime }, bundle } : { header, source, body, bundle };
}
