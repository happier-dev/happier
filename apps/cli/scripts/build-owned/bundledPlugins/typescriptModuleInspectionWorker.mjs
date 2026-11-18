import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';

// Exiting closes this process's esbuild service, whose exit the session also
// hears (esbuildServiceExit.sh). Announce the worker's own exit first, with a
// synchronous write, so the session does not mistake it for a dead service.
process.on('exit', code => {
  try { writeSync(2, `\n__HAPPIER_INSPECTION_WORKER_EXIT__ ${code}\n`); } catch { /* stderr already closed */ }
});

// The session's process already preloads the canonical source runtime. Its
// module cache shares dependencies within this session; the process isolates
// the next session without adding a second namespaced loader.

function serializeModule(imported, requestedExports) {
  const selected = imported && typeof imported === 'object'
    && imported.default && typeof imported.default === 'object'
    && !Array.isArray(imported.default)
    ? imported.default
    : imported;
  const exportNames = selected && typeof selected === 'object' ? Object.keys(selected) : [];
  const values = Object.create(null);
  const wanted = Array.isArray(requestedExports) ? new Set(requestedExports) : null;
  for (const exportName of exportNames) {
    if (wanted && !wanted.has(exportName)) continue;
    try {
      const serialized = JSON.stringify(selected[exportName]);
      if (serialized !== undefined) values[exportName] = JSON.parse(serialized);
    } catch {
      // Preserve export existence. The existing caller validation rejects an
      // absent/non-JSON value when that particular projection requires it.
    }
  }
  return { exportNames, values };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    if (!Number.isSafeInteger(request?.id) || typeof request?.path !== 'string') {
      throw new Error('invalid inspection request');
    }
    const imported = await import(pathToFileURL(request.path).href);
    const payload = serializeModule(imported, request.exports);
    const response = JSON.stringify({ id: request.id, ok: true, payload });
    process.stdout.write(`${OUTPUT_MARKER}${response}\n`);
  } catch (error) {
    process.stdout.write(`${OUTPUT_MARKER}${JSON.stringify({
      id: Number.isSafeInteger(request?.id) ? request.id : -1,
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })}\n`);
  }
}

// EOF is the inspection owner's terminal signal. Authored imports can retain
// runtime handles; drain the response pipe before ending this isolated worker.
await new Promise((resolve, reject) => {
  process.stdout.write('', error => error ? reject(error) : resolve());
});
process.exit(0);
