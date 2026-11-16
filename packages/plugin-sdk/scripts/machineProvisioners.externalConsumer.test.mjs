import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('provisioner setup prerequisites remain nameable in inferred public plugin declarations', t => {
  const repoRoot = process.cwd();
  const root = mkdtempSync(resolve(tmpdir(), 'machine-prerequisite-declaration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'node_modules/@happier-dev'), { recursive: true });
  symlinkSync(resolve(repoRoot, 'packages/plugin-sdk'), resolve(root, 'node_modules/@happier-dev/plugin-sdk'), 'dir');
  // Project the actual authored boundary type, while the consumer and its
  // definePlugin inference use the prepared public SDK declarations unchanged.
  const ownerPath = resolve(repoRoot, 'packages/plugin-sdk/src/machineProvisioners.ts');
  const owner = ts.createSourceFile(ownerPath, readFileSync(ownerPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = owner.statements.find(node => ts.isTypeAliasDeclaration(node)
    && node.name.text === 'MachineProvisionerCheckResultV1');
  assert.ok(declaration);
  writeFileSync(resolve(root, 'owner.d.ts'), `
    import type * as canonical from '${resolve(repoRoot, 'packages/plugin-sdk/node_modules/@happier-dev/protocol/dist/plugins/contributions/machineProvisioners.js')}';
    import type { ManagedLocalResourceFactsV1 } from '${resolve(repoRoot, 'packages/plugin-sdk/node_modules/@happier-dev/protocol/dist/machines/managed/providerFactsV1.js')}';
    import type { MachineProvisionerContributionV1, MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
    import type { PluginLocalizedStringV2, PluginContributionRef } from '@happier-dev/plugin-sdk';
    import type { ProtocolJsonValue, ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
    import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
    ${ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, owner)}
    export declare const checkSchema: ProtocolComposableSchema<MachineProvisionerCheckResultV1>;
  `);
  writeFileSync(resolve(root, 'consumer.ts'), `
    import { definePlugin } from '@happier-dev/plugin-sdk';
    import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
    import { checkSchema } from './owner.js';
    const inputSchema = defineProtocolObject({}, { policy: 'closed' });
    export const plugin = definePlugin({ id: 'test.setup-prerequisites', version: '1.0.0', actions: {
      check: { title: 'Check', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema, resultSchema: checkSchema, run: async () => ({ available: true }) },
    } });
  `);
  const args = ['--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--declaration', '--emitDeclarationOnly',
    '--outDir', resolve(root, 'declarations'), resolve(root, 'consumer.ts')];
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: resolve(repoRoot, 'packages/plugin-sdk'),
    invocationKind: 'build', args });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const emitted = readFileSync(resolve(root, 'declarations/consumer.d.ts'), 'utf8');
  assert.match(emitted, /export declare const plugin/u);
  assert.doesNotMatch(emitted, /agents\/node_modules|@happier-dev\/protocol/u);
});
