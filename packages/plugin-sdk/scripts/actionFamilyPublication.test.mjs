import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { readCurrentApiSurfaceInventory } from './apiSurfaceCli.mjs';
import { projectActionDtoDeclarations } from './generateActionTypeMap.mjs';

test('new generated Action families enter the author inventory without changing its publication spec', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-action-family-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'packages/plugin-sdk');
  const actions = join(root, 'packages/protocol/src/actions');
  await mkdir(actions, { recursive: true });
  await mkdir(join(sdk, 'src/actions'), { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugin-sdk', type: 'module', exports: {},
  }));
  // Keep unrelated mandatory host contracts in this isolated package fixture;
  // never disable inventory validation to test the author publication path.
  const current = JSON.parse(await readFile(new URL('../api-surface.json', import.meta.url), 'utf8'));
  for (const entrypoint of current.entrypoints.filter(entry => entry.visibility === 'host')) {
    const rows = current.symbols.filter(row => row.specifier === entrypoint.specifier);
    const specPath = join(sdk, entrypoint.sourceModule.replace(/index\.ts$/u, 'index.public.ts'));
    await mkdir(dirname(specPath), { recursive: true });
    await writeFile(specPath, rows.map(row => {
      const module = relative(dirname(specPath), join(sdk, row.sourceModule)).replaceAll('\\', '/').replace(/\.ts$/u, '.js');
      return `export ${row.kind === 'type' ? 'type ' : ''}{ ${row.sourceExport} as ${row.exportName} } from '${module.startsWith('.') ? module : `./${module}`}';`;
    }).join('\n'));
    for (const module of new Set(rows.map(row => row.sourceModule))) {
      const declarations = rows.filter(row => row.sourceModule === module);
      const path = join(sdk, module);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, [`/** @moduleRealm ${entrypoint.realm} */`,
        ...declarations.map(row => row.kind === 'type'
          ? `export type ${row.sourceExport} = {};`
          : `export const ${row.sourceExport} = true;`),
      ].join('\n'));
    }
  }
  const spec = "export type * from './dtos/familyExports.generated.js';\n";
  await writeFile(join(sdk, 'src/actions/index.public.ts'), spec);
  await writeFile(join(actions, 'pluginActionSurface.ts'),
    'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;\n');

  for (const families of [['existing'], ['existing', 'future']]) {
    await writeFile(join(actions, 'actionIds.ts'),
      `export const ACTION_ID_FAMILIES_V1 = ${JSON.stringify(Object.fromEntries(
        families.map(family => [family, [`${family}.read`]]),
      ))} as const;\n`);
    const names = families.map(family => `${family[0].toUpperCase()}${family.slice(1)}Action`);
    const declarations = new Map([
      [join(actions, 'pluginActionDtos.ts'), [
        ...families.map((family, index) =>
          `import type { ${names[index]}InputById, ${names[index]}ResultById } from './${family}ActionDtos.js';`),
        `export type PluginActionInputById = ${names.map(name => `${name}InputById`).join(' & ')};`,
        `export type PluginActionResultById = ${names.map(name => `${name}ResultById`).join(' & ')};`,
      ].join('\n')],
      ...families.map((family, index) => [join(actions, `${family}ActionDtos.ts`), [
        `export type ${names[index]}InputById = { '${family}.read': { id: string } };`,
        `export type ${names[index]}ResultById = { '${family}.read': { found: boolean } };`,
      ].join('\n')]),
    ]);
    const generated = projectActionDtoDeclarations({ repoRoot: root, declarations });
    assert.ok(generated.outputs.has('packages/plugin-sdk/src/actions/dtos/familyExports.generated.ts'),
      'the DTO producer publishes its selected family exports');
    for (const [path, contents] of generated.outputs) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), contents);
    }
    const inventory = await readCurrentApiSurfaceInventory({ packageRoot: sdk });
    for (const [index, family] of families.entries()) {
      for (const direction of ['Input', 'Result']) {
        const name = `${names[index]}${direction}ById`;
        const homes = inventory.symbols.filter(row => row.exportName === name);
        assert.equal(homes.length, 1, `${name} has one public home`);
        assert.equal(homes[0].specifier, './actions');
        assert.equal(homes[0].sourceModule, `src/actions/dtos/${family}ActionDtos.generated.ts`);
      }
    }
    assert.equal(await readFile(join(sdk, 'src/actions/index.public.ts'), 'utf8'), spec);
  }

  // Automatic type publication must not widen the authored runtime surface.
  await writeFile(join(sdk, 'src/actions/index.public.ts'), spec.replace('export type *', 'export *'));
  await assert.rejects(readCurrentApiSurfaceInventory({ packageRoot: sdk }), /only named re-export declarations/u);
  await writeFile(join(sdk, 'src/actions/index.public.ts'), "export type * from './runtimeExportList.js';\n");
  await writeFile(join(sdk, 'src/actions/runtimeExportList.ts'), "export { runtimeValue } from './runtime.js';\n");
  await writeFile(join(sdk, 'src/actions/runtime.ts'), 'export const runtimeValue = true;\n');
  await assert.rejects(readCurrentApiSurfaceInventory({ packageRoot: sdk }), /type-only re-export list contains a value export/u);
  await writeFile(join(sdk, 'src/actions/index.public.ts'), "export type * from './circular.js';\n");
  await writeFile(join(sdk, 'src/actions/circular.ts'), "export type * from './circular.js';\n");
  await assert.rejects(readCurrentApiSurfaceInventory({ packageRoot: sdk }), /circular type-only export/u);
  await writeFile(join(sdk, 'src/actions/index.public.ts'), spec);
  const exportList = join(sdk, 'src/actions/dtos/familyExports.generated.ts');
  await writeFile(exportList, `${await readFile(exportList, 'utf8')}\n/** @since 0.1.0 */\n`);
  await assert.rejects(readCurrentApiSurfaceInventory({ packageRoot: sdk }), /publisher-owned @since/u);
});
