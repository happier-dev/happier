const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';

const modulePath = process.argv[2];
if (!modulePath) {
  console.error('Missing TypeScript module path');
  process.exitCode = 2;
} else {
  try {
    // Match the generator's canonical workspace-module cache for manifests, which
    // import the plugin SDK. Some package-manager symlink layouts otherwise make
    // the SDK's transitive agents dependency resolve relative to the plugin.
    if (modulePath.replaceAll('\\', '/').endsWith('/src/manifest.ts')) {
      await import('@happier-dev/agents');
    }
    const { tsImport } = await import('tsx/esm/api');
    const imported = await tsImport(modulePath, import.meta.url);
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
        // Preserve the export's existence below. Callers that require a JSON value
        // will reject the undefined projection at their existing validation boundary.
      }
    }
    process.stdout.write(`${OUTPUT_MARKER}${JSON.stringify({ exportNames, values })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
