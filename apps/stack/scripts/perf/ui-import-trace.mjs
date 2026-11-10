import { appendFileSync, writeFileSync } from 'node:fs';

// Vitest resolves transformed modules through Vite rather than Node hooks.
// This reporter observes the existing graph; it neither loads nor runs tests.
export default class ImportTraceReporter {
  onInit(context) { this.context = context; }

  onTestRunEnd(modules, unhandledErrors) {
    const edges = new Set();
    for (const project of this.context.projects) {
      for (const module of project.vite.moduleGraph.idToModuleMap.values()) {
        if (!module.file) continue;
        for (const imported of module.importedModules) {
          if (imported.file) edges.add(JSON.stringify([module.file, imported.file]));
        }
      }
    }
    if (edges.size) appendFileSync(process.env.HAPPIER_ENTRY_IMPORT_TRACE, `${[...edges].join('\n')}\n`);
    const error = modules.flatMap(module => module.errors()).concat(unhandledErrors)[0];
    if (error) writeFileSync(process.env.HAPPIER_ENTRY_IMPORT_FAILURE, JSON.stringify({
      name: error.name, code: error.code, message: error.message, stack: error.stackStr ?? error.stack,
    }), { mode: 0o600 });
  }
}
