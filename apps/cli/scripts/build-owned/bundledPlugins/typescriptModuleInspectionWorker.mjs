import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';

await import('@happier-dev/agents');
const { tsImport } = await import('tsx/esm/api');

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
    const imported = await tsImport(pathToFileURL(request.path).href, import.meta.url);
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
