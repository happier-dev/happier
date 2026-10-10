import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';

const { tsImport } = await import('tsx/esm/api');
const runtimeTsconfigPath = fileURLToPath(new URL('../tsconfig.generator-runtime.json', import.meta.url));

function serializeModule(imported) {
  const selected = imported && typeof imported === 'object'
    && imported.default && typeof imported.default === 'object'
    && !Array.isArray(imported.default)
    ? imported.default
    : imported;
  const exportNames = selected && typeof selected === 'object' ? Object.keys(selected) : [];
  const values = Object.create(null);
  for (const exportName of exportNames) {
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
    const imported = await tsImport(pathToFileURL(request.path).href, {
      parentURL: import.meta.url,
      tsconfig: runtimeTsconfigPath,
    });
    process.stdout.write(`${OUTPUT_MARKER}${JSON.stringify({
      id: request.id,
      ok: true,
      payload: serializeModule(imported),
    })}\n`);
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
