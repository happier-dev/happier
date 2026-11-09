import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2 } from '../../../../../packages/protocol/src/plugins/manifest';
import { QWEN_UI_DESCRIPTOR } from '../../../../../packages/plugins/qwen/src/ui/descriptor';
import { renderBundledBrandAssetsTs } from './brandAssets';

describe('bundled plugin brand assets', () => {
  it('publishes packaged themed SVGs without changing masks or separate service identity', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-brand-assets-'));
    try {
      const assetsDir = join(rootDir, 'packages/plugins/qwen/assets');
      mkdirSync(assetsDir, { recursive: true });
      const agentXml = '<svg viewBox="0 0 24 24"><mask id="mark-mask"><path fill="white" d="M0 0h24v24H0z"/></mask><path mask="url(#mark-mask)" fill="{{text.primary}}" d="M1 1h8v8H1z"/></svg>';
      const serviceXml = '<svg viewBox="0 0 16 16"><path fill="{{accent.orange}}" d="M2 2h8v8H2z"/></svg>';
      writeFileSync(join(assetsDir, 'agent.svg'), agentXml);
      writeFileSync(join(assetsDir, 'service.svg'), serviceXml);
      const admitted = ingestPluginManifestV2({
        schemaVersion: 2, id: 'example.qwen', version: '0.0.0', displayName: 'Qwen',
        runtime: { apiVersion: 1 },
        contributes: {
          resources: [{ id: 'service-mark', kind: 'asset', path: 'assets/service.svg', contentType: 'image/svg+xml' }],
          connectedAccountDescriptors: [{ id: 'account', title: 'Account', ui: { iconResourceId: 'service-mark' },
            authentication: { defaultModeId: 'key', modes: [{ id: 'key', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] } }],
        },
      });
      if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
      const source = renderBundledBrandAssetsTs({ rootDir, pluginPackages: [{
        pluginPackageId: 'qwen', pluginId: admitted.manifest.id, packageName: '@happier-dev/plugins-qwen',
        packageVersion: '0.0.0', manifest: admitted.manifest,
        agentUiDescriptor: { ...QWEN_UI_DESCRIPTOR, assets: { svgIcon: { path: 'assets/agent.svg' } } },
      }] });
      type Resolver = (theme: { colors: { text: { primary: string }; accent: { orange: string } } }) => string;
      const exports: { AGENT_LOGO_SVG_XML?: Record<string, Resolver>; CONNECTED_SERVICE_LOGO_SVG_XML?: Record<string, Resolver> } = {};
      runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
      const theme = { colors: { text: { primary: '#123456' }, accent: { orange: '#fedcba' } } };
      expect(exports.AGENT_LOGO_SVG_XML?.qwen?.(theme)).toBe(agentXml.replace('{{text.primary}}', '#123456'));
      expect(exports.CONNECTED_SERVICE_LOGO_SVG_XML?.['example.qwen/account']?.(theme)).toBe(serviceXml.replace('{{accent.orange}}', '#fedcba'));
      expect(exports.CONNECTED_SERVICE_LOGO_SVG_XML?.['example.other/account']).toBeUndefined();
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });
});
