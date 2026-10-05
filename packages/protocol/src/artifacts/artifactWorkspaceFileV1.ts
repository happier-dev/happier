import { ARTIFACT_HTML_BUNDLE_MIME_V1 } from './artifactHtmlV1.js';

/** File classification and provenance shared by the keyholding publication hosts. */
export function prepareArtifactWorkspaceFileV1(params: Readonly<{
  caller: Readonly<{ sessionId: string; machineId: string; runId?: string }>;
  file: Readonly<{ bytes: Uint8Array; name: string; path: string; sha: string }>;
  input: Readonly<{ title?: string; mime?: string; kind?: string }>;
}>) {
  const { file, input, caller } = params;
  const declaredMime = input.mime?.split(';', 1)[0].trim().toLowerCase();
  const inferredHtml = input.kind === undefined && (declaredMime === 'text/html'
    || declaredMime === ARTIFACT_HTML_BUNDLE_MIME_V1
    || (!input.mime && file.name.lastIndexOf('.') > 0 && /\.html?$/i.test(file.name)));
  const kind = input.kind ?? (inferredHtml ? 'html' : 'published.v1');
  const allowsText = !declaredMime || declaredMime.startsWith('text/')
    || ['application/json', 'application/javascript', 'application/xml'].includes(declaredMime);
  let body: string | undefined;
  if (allowsText) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
      if (!decoded.includes('\0')) body = decoded;
    } catch { /* Non-UTF8 content uses the binary body path. */ }
  }
  const mime = input.mime ?? (kind === 'html' ? 'text/html' : body === undefined ? 'application/octet-stream' : 'text/plain');
  const header = { title: input.title ?? file.name, kind, mime, sizeBytes: file.bytes.length,
    source: { sessionId: caller.sessionId, ...(caller.runId ? { runId: caller.runId } : {}),
      machineId: caller.machineId, path: file.path, sha: file.sha } };
  return body === undefined ? { header, binary: { bytes: file.bytes, mime } } : { header, body };
}
