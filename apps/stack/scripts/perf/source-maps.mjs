import { SourceMap } from 'node:module';
import { frameKey, safeUrl } from './analysis.mjs';

// scriptParsed associates inline map bytes with the parsed script, not a URL
// that a development server can later reuse. An external URL proves no such
// association, even if fetched before profiling. Never guess from that URL.
export function symbolicateFrames(frames, scripts) {
  const symbols = new Map(), sourceMaps = new Map(), scriptMaps = [], mapFailures = [];
  for (const frame of frames) {
    if (!frame.scriptId || frame.scriptId === '0') continue; // Native/root frames.
    if (!sourceMaps.has(frame.scriptId)) {
      const script = scripts.get(frame.scriptId);
      const identity = { scriptId: frame.scriptId, url: safeUrl(script?.url ?? frame.url),
        hash: script?.hash ?? null, length: script?.length ?? null };
      let map = null, reason;
      if (!script) reason = 'script-identity-unavailable';
      else if (!script.sourceMapURL) reason = 'source-map-unavailable';
      else if (!/^data:/i.test(script.sourceMapURL)) reason = 'external-map-pairing-unproven';
      else {
        try {
          const [, metadata, body] = /^data:([^,]*),(.*)$/is.exec(script.sourceMapURL);
          const decoded = decodeURIComponent(body);
          const json = JSON.parse(/;base64(?:;|$)/i.test(metadata) ? Buffer.from(decoded, 'base64').toString('utf8') : decoded);
          map = new SourceMap(json);
        } catch { reason = 'inline-map-invalid'; }
      }
      sourceMaps.set(frame.scriptId, map);
      scriptMaps.push({ ...identity, pairing: reason ? 'unproven' : 'cdp-inline-source-map' });
      if (reason) mapFailures.push({ ...identity, reason });
    }
    const mapped = sourceMaps.get(frame.scriptId)?.findEntry(frame.lineNumber, frame.columnNumber);
    if (mapped?.originalSource) symbols.set(frameKey(frame), { source: mapped.originalSource.split(/[?#]/)[0],
      name: mapped.name ?? frame.functionName, line: mapped.originalLine, column: mapped.originalColumn });
  }
  return { symbols, attribution: { sourceMaps: [...sourceMaps.values()].filter(Boolean).length,
    attemptedSourceMaps: sourceMaps.size, mappedFrames: symbols.size, scriptMaps, mapFailures, mapResponses: [] } };
}
