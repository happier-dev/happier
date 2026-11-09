import { describe, expect, it } from 'vitest';
import { ScriptKind, ScriptTarget, createSourceFile, isIdentifier, isObjectLiteralExpression, isPropertyAssignment, isVariableStatement } from 'typescript';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';

import { renderUiBundledPluginEntriesTs } from './agentUi.ts';
import { renderRetainedUiBundledPluginEntriesTs } from './retainedUi.ts';
import type { BundledPluginPackage } from './projectionFacts.ts';

import { PLUGIN_MANIFEST as DEVIN_PLUGIN_MANIFEST } from '../../../../../packages/plugins/devin/src/manifest';
import { DEVIN_UI_DESCRIPTOR } from '../../../../../packages/plugins/devin/src/ui/descriptor';
import { DEVIN_ACP_RUNTIME_DECLARATION } from '../../../../../packages/plugins/devin/src/agent/acp/runtimeDeclaration';
import { PLUGIN_MANIFEST as DROID_PLUGIN_MANIFEST } from '../../../../../packages/plugins/droid/src/manifest';
import { DROID_UI_DESCRIPTOR } from '../../../../../packages/plugins/droid/src/ui/descriptor';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '../../../../../packages/plugins/claude/src/manifest';
import { CLAUDE_UI_DESCRIPTOR } from '../../../../../packages/plugins/claude/src/ui/descriptor';
import { PLUGIN_MANIFEST as QWEN_PLUGIN_MANIFEST } from '../../../../../packages/plugins/qwen/src/manifest';
import { QWEN_ACP_RUNTIME_DEFINITION } from '../../../../../packages/plugins/qwen/src/agent/acp/definition';
import { PLUGIN_MANIFEST as CODEBUDDY_PLUGIN_MANIFEST } from '../../../../../packages/plugins/codebuddy/src/manifest';
import { CODEBUDDY_UI_DESCRIPTOR } from '../../../../../packages/plugins/codebuddy/src/ui/descriptor';
import { CODEBUDDY_ACP_RUNTIME_DECLARATION } from '../../../../../packages/plugins/codebuddy/src/agent/acp/runtimeDeclaration';
import { PLUGIN_MANIFEST as FX_PLUGIN_MANIFEST } from '../../../../../packages/plugins/fx/src/manifest';
import { FX_UI_DESCRIPTOR } from '../../../../../packages/plugins/fx/src/ui/descriptor';
import { FX_PERMISSION_MODE_MAPPING } from '../../../../../packages/plugins/fx/src/agent/acp/permissionModes';


function emittedCorePermissionMapping(source: string, coreName: string): unknown {
    const file = createSourceFile('projection.ts', source, ScriptTarget.Latest, true, ScriptKind.TS);
    const property = (object: import('typescript').ObjectLiteralExpression, name: string) => (
        object.properties.filter(isPropertyAssignment).find((entry) => entry.name.getText(file).replace(/^['"]|['"]$/gu, '') === name)?.initializer
    );
    for (const statement of file.statements) {
        if (!isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!isIdentifier(declaration.name) || declaration.name.text !== coreName) continue;
            if (!declaration.initializer || !isObjectLiteralExpression(declaration.initializer)) throw new Error(`Missing ${coreName} object`);
            const permissions = property(declaration.initializer, 'permissions');
            if (!permissions || !isObjectLiteralExpression(permissions)) throw new Error(`Missing ${coreName} permissions`);
            const mapping = property(permissions, 'permissionModeMapping');
            return mapping ? JSON.parse(mapping.getText(file)) : undefined;
        }
    }
    throw new Error(`Missing ${coreName}`);
}

describe('bundled Agent permission mapping projection', () => {
    it.each([
        { agentId: 'codebuddy', manifest: CODEBUDDY_PLUGIN_MANIFEST, descriptor: CODEBUDDY_UI_DESCRIPTOR,
            expected: CODEBUDDY_ACP_RUNTIME_DECLARATION.definition.permissionModeMapping },
        { agentId: 'fx', manifest: FX_PLUGIN_MANIFEST, descriptor: FX_UI_DESCRIPTOR, expected: FX_PERMISSION_MODE_MAPPING },
    ] as const)('preserves $agentId permission controls through custom runtime admission and both UI publication paths', ({ agentId, manifest, descriptor, expected }) => {
        const parsed = ingestPluginManifestV2(manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const pluginPackage: BundledPluginPackage = {
            pluginPackageId: agentId, pluginId: parsed.manifest.id,
            packageName: `@happier-dev/plugins-${agentId}`, packageVersion: '0.0.0',
            agentId, manifest: parsed.manifest, agentUiDescriptor: descriptor,
        };
        const ui = renderUiBundledPluginEntriesTs({ packageNames: [pluginPackage.packageName], pluginPackages: [pluginPackage] });
        const coreName = `${agentId.toUpperCase()}_CORE`;
        expect(emittedCorePermissionMapping(ui, coreName)).toEqual(expected);
        expect(emittedCorePermissionMapping(renderRetainedUiBundledPluginEntriesTs(ui, [pluginPackage], 'projection.ts'), coreName)).toEqual(expected);
    });

    it('publishes declared ACP mappings from real manifests, including null policy, and omits unmapped/native Agents', () => {
        const inputs = [
            { agentId: 'devin', manifest: DEVIN_PLUGIN_MANIFEST, descriptor: DEVIN_UI_DESCRIPTOR },
            { agentId: 'droid', manifest: DROID_PLUGIN_MANIFEST, descriptor: DROID_UI_DESCRIPTOR },
            { agentId: 'claude', manifest: CLAUDE_PLUGIN_MANIFEST, descriptor: CLAUDE_UI_DESCRIPTOR },
            { agentId: 'qwen', manifest: QWEN_PLUGIN_MANIFEST },
        ] as const;
        const pluginPackages: readonly BundledPluginPackage[] = inputs.map((input) => {
            const parsed = ingestPluginManifestV2(input.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return {
                pluginPackageId: input.agentId, pluginId: parsed.manifest.id,
                packageName: `@happier-dev/plugins-${input.agentId}`, packageVersion: '0.0.0',
                agentId: input.agentId, manifest: parsed.manifest,
                ...('descriptor' in input ? { agentUiDescriptor: input.descriptor } : {}),
            };
        });
        const ui = renderUiBundledPluginEntriesTs({
            packageNames: pluginPackages.map((entry) => entry.packageName), pluginPackages,
        });
        expect(emittedCorePermissionMapping(ui, 'DEVIN_CORE')).toEqual(DEVIN_ACP_RUNTIME_DECLARATION.definition.permissionModeMapping);
        expect(emittedCorePermissionMapping(ui, 'QWEN_CORE')).toEqual(QWEN_ACP_RUNTIME_DEFINITION.permissionModeMapping);
        expect(emittedCorePermissionMapping(ui, 'DROID_CORE')).toBeUndefined();
        expect(emittedCorePermissionMapping(ui, 'CLAUDE_CORE')).toBeUndefined();
    });
});
