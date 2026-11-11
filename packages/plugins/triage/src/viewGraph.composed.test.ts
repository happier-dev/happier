import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { compileUniversalPluginUiCommonJs } from '../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js';
// The generator owns workspace source resolution; exercise its actual compiler inputs.
import { sourcePluginUiBuildOptions } from '../../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const projectRoot = resolve(repoRoot, 'packages/plugins/triage');

describe('Triage views exclude handlers; executables retain only their activation graph', () => {
  it.each([
    ['latest-widget-native', 'src/ui/widget/latestWidget.tsx', 'renderSurface', true],
    ['tasks-widget-native', 'src/ui/widget/tasksWidget.tsx', 'renderSurface', true],
    ['entity-drag-drop-native', 'src/ui/list/entryDragDrop.ts', 'activate', false],
    ['account-runtime', 'src/accountRuntime.ts', 'activate', false],
  ] as const)('%s does not retain the plugin definition graph', async (id, entryPath, exportName, view) => {
    const compiled = await compileUniversalPluginUiCommonJs({
      projectRoot, entryPath, artifactId: `triage-${id}`, requestedExports: [exportName],
      ...await sourcePluginUiBuildOptions({ repoRoot }),
    });
    const modules = Object.keys(compiled.metafile.inputs).map(path => path.replaceAll('\\', '/'));
    expect(compiled.exports).toContain(exportName);
    expect(compiled.bytes.byteLength).toBeGreaterThan(0);
    expect(modules.filter(path => path === 'src/definition.ts')).toEqual([]);
    if (id === 'entity-drag-drop-native') {
      expect(modules).toContain('src/workItems/runtime.ts');
      expect(modules).not.toContain('src/accountDefinition.ts');
    } else if (!view) {
      expect(modules).toContain('src/accountDefinition.ts');
      expect(modules).not.toContain('src/ui/list/entryDragDrop.ts');
    }
    const actionHandlers = modules.filter(path => /^src\/actions\/(?!.*Protocol\.ts$|dataContext\.ts$|taskWriteFailure\.ts$)/u.test(path)).sort();
    if (id === 'entity-drag-drop-native') {
      // Work Items reads and refreshes its linked rows through these two handlers.
      expect(actionHandlers).toEqual(['src/actions/listEntries.ts', 'src/actions/reobserveEntry.ts']);
    }
    if (view) {
      // Protocol declarations and the pure transport-failure mapper are consumed view data, not handlers.
      expect(actionHandlers).toEqual([]);
      expect(modules.filter(path => path === 'src/workItems/runtime.ts')).toEqual([]);
    }
  });
});
