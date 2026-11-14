import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { deriveActionDtoBindings } from './deriveActionDtos.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('projected buffer DTOs compile against consumer libraries without Node ambient types', t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'buffer-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const protocol = resolve(root, 'packages/protocol/src');
  mkdirSync(protocol, { recursive: true });
  writeFileSync(resolve(protocol, 'payload.ts'), 'export type Payload = { bytes: Uint8Array<ArrayBufferLike> };');
  const projected = deriveActionDtoBindings({ repoRoot: root, bindings: [['payload.ts', 'Payload']] });
  writeFileSync(resolve(root, 'payload.d.ts'), projected.declarations.map(([, text]) => text).join('\n'));
  writeFileSync(resolve(root, 'consumer.ts'), `
    import type { Payload } from './payload.js';
    declare const bytes: Uint8Array<ArrayBufferLike>;
    export const payload: Payload = { bytes };
  `);
  writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true, target: 'ESNext',
    module: 'NodeNext', moduleResolution: 'NodeNext', types: [],
  }, files: ['consumer.ts'] }));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: resolve('packages/plugin-sdk') });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, '-p', resolve(root, 'tsconfig.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
