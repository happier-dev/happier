import { ARTIFACT_HTML_BUNDLE_MIME_V1, artifactHtmlBundleFromBodyV1, type ArtifactHtmlBundleV1 } from './artifactHtmlV1.js';
import { ArtifactWorkspaceSourceV1Schema } from './artifactBinaryV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ArtifactHtmlBundleV1Schema } from './artifactHtmlV1.js';
import { UiSurfaceCapabilityRequestV1Schema, type UiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { resolveHostedWebAssetContentTypeV1 } from '../plugins/ui/hostedWebAssetMime.js';
import { encodeBase64 } from '../crypto/base64.js';

/** Acquisition intent is Action input only; stored HTML always carries a by-value bundle. */
export const ArtifactWorkspacePublicationSourceV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.minLength(1)),
  entrypoint: z.optional(z.lazy(() => ArtifactHtmlBundleV1Schema.shape.entrypoint)),
  workspace: z.optional(z.strictObject({
    machineId: z.string().check(z.minLength(1)), rootPath: z.string().check(z.minLength(1)),
  })),
}));

function forbiddenWorkspaceSource(): Error {
  return Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
}

/** Whether a folder's named entrypoint is a confined HTML page key, checked before any byte is read. */
export function isArtifactHtmlBundleEntrypointV1(entrypoint: string): boolean {
  const parsed = ArtifactHtmlBundleV1Schema.shape.entrypoint.safeParse(entrypoint);
  return parsed.success && resolveHostedWebAssetContentTypeV1(parsed.data)?.split(';', 1)[0] === 'text/html';
}

/**
 * One bundle assembly for every keyholding host that acquires a confined HTML folder (CLI from its
 * filesystem, UI through the daemon's confined transfer): bundle-relative keys, served content types,
 * and an HTML entrypoint that is one of the files. Anything else is refused, never repaired.
 */
export function assembleArtifactHtmlBundleV1(input: Readonly<{
  entrypoint: string;
  files: ReadonlyArray<Readonly<{ key: string; bytes: Uint8Array }>>;
}>): ArtifactHtmlBundleV1 {
  if (!isArtifactHtmlBundleEntrypointV1(input.entrypoint)) throw forbiddenWorkspaceSource();
  const files: ArtifactHtmlBundleV1['files'] = {};
  for (const file of input.files) {
    if (!ArtifactHtmlBundleV1Schema.shape.entrypoint.safeParse(file.key).success || Object.hasOwn(files, file.key)) throw forbiddenWorkspaceSource();
    files[file.key] = { mime: resolveHostedWebAssetContentTypeV1(file.key)?.split(';', 1)[0] ?? 'application/octet-stream',
      contentBase64: encodeBase64(file.bytes) };
  }
  if (!Object.hasOwn(files, input.entrypoint)) throw forbiddenWorkspaceSource();
  const parsed = ArtifactHtmlBundleV1Schema.safeParse({ v: 1, entrypoint: input.entrypoint, files });
  if (!parsed.success) throw forbiddenWorkspaceSource();
  return parsed.data;
}

/** File classification and provenance shared by the keyholding publication hosts. */
export function prepareArtifactWorkspaceFileV1(params: Readonly<{
  caller: Readonly<{ machineId: string } & (
    { sessionId: string; runId?: string; rootPath?: never }
    | { rootPath: string; sessionId?: never; runId?: never }
  )>;
  file: Readonly<{ bytes: Uint8Array; name: string; path: string; sha: string; bundle?: ArtifactHtmlBundleV1 }>;
  input: Readonly<{ title?: string; mime?: string; kind?: string; requestedCapabilities?: UiSurfaceCapabilityRequestV1 }>;
}>) {
  const { file, input, caller } = params;
  const declaredMime = input.mime?.split(';', 1)[0].trim().toLowerCase();
  if (file.bundle && ((input.kind !== undefined && input.kind !== 'html')
    || (declaredMime !== undefined && declaredMime !== 'text/html' && declaredMime !== ARTIFACT_HTML_BUNDLE_MIME_V1))) {
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
  const source = ArtifactWorkspaceSourceV1Schema.parse({ ...(caller.rootPath !== undefined ? { rootPath: caller.rootPath }
    : { sessionId: caller.sessionId, ...(caller.runId ? { runId: caller.runId } : {}) }),
    machineId: caller.machineId, path: file.path, sha: file.sha });
  let bundle = acquiredBundle;
  if (!bundle && kind === 'html') {
    try { bundle = artifactHtmlBundleFromBodyV1(file.bytes, mime); }
    catch { /* Ordinary file publication retains its existing unavailable-preview result. */ }
  }
  if (input.requestedCapabilities !== undefined) {
    if (!bundle || kind !== 'html') throw Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
    bundle = ArtifactHtmlBundleV1Schema.parse({ ...bundle,
      requestedCapabilities: UiSurfaceCapabilityRequestV1Schema.parse(input.requestedCapabilities) });
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    return { header: { ...header, mime: ARTIFACT_HTML_BUNDLE_MIME_V1, sizeBytes: bytes.length }, source,
      binary: { bytes, mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }, bundle };
  }
  return body === undefined ? { header, source, binary: { bytes: file.bytes, mime }, bundle } : { header, source, body, bundle };
}
