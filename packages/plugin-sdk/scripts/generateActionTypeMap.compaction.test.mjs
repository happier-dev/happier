import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { projectActionDtoDeclarations } from './generateActionTypeMap.mjs';

test('shares closed DTO shapes across roots while keeping family exports and bound types', () => {
  const repoRoot = resolve('fixture');
  const protocol = resolve(repoRoot, 'packages/protocol/src/actions');
  const shape = '{ readonly kind: "page"; readonly names?: readonly string[]; readonly total: number }';
  const declarations = new Map([
    [resolve(protocol, 'actionIds.ts'), "export const ACTION_ID_FAMILIES_V1 = Object.freeze({ alpha: ['alpha.read'], beta: ['beta.read'] } as const);"],
    [resolve(protocol, 'pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = Object.freeze({} as const);'],
    [resolve(protocol, 'pluginActionDtos.ts'), `
      import type { AlphaActionInputById, AlphaActionResultById } from './alpha.js';
      import type { BetaActionInputById, BetaActionResultById } from './beta.js';
      export type PluginActionInputById = AlphaActionInputById & BetaActionInputById;
      export type PluginActionResultById = AlphaActionResultById & BetaActionResultById;
    `],
    [resolve(protocol, 'alpha.ts'), `
      type Scoped<T> = { readonly value: T; readonly label: string };
      export type AlphaActionInputById = { 'alpha.read': Scoped<string> };
      export type AlphaActionResultById = { 'alpha.read': ${shape} };
    `],
    [resolve(protocol, 'beta.ts'), `
      type Scoped<T> = { readonly value: T; readonly label: string };
      export type BetaActionInputById = { 'beta.read': Scoped<number> };
      export type BetaActionResultById = { 'beta.read': ${shape} };
    `],
  ]);
  const project = () => projectActionDtoDeclarations({ repoRoot, declarations, readSource: path => declarations.get(path) });
  const { outputs, inputKeys, resultKeys } = project();
  const dtos = 'packages/plugin-sdk/src/actions/dtos';
  assert.deepEqual(inputKeys, ['alpha.read', 'beta.read']);
  assert.deepEqual(resultKeys, inputKeys);
  const alpha = outputs.get(`${dtos}/alpha.generated.ts`);
  const beta = outputs.get(`${dtos}/beta.generated.ts`);
  assert.match(alpha, /Scoped<string>/);
  assert.match(beta, /Scoped<number>/);
  assert.match(alpha, /export type AlphaActionResultById/);
  assert.match(beta, /export type BetaActionResultById/);
  const closure = [...outputs.values()].join('\n');
  assert.equal(closure.match(/readonly total: number/g)?.length, 1);
  assert.deepEqual([...project().outputs], [...outputs]);
});
