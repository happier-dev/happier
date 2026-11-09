import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedServiceRuntimeAuthNativeHome } from './createRuntimeAuthNativeHome';

describe('requester native authentication admission', () => {
  it('finishes admitted native persistence without a requester permission dependency', async () => {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
    try {
      const root = join(runtime.happyHomeDir, 'requester-native');
      const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({ agentId: 'claude', root });
      expect(nativeHome, JSON.stringify({ diagnostics: runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'],
        declarations: runtime.registry.contributes.agents.filter(agent => agent.pluginId === 'happier.agent.claude')
          .map(agent => ({ manifestPath: agent.manifestPath, cliMetadata: agent.cliMetadata })) })).not.toBeNull();
      const bytes = new TextEncoder().encode('{"credential":"admitted-bob"}');
      await nativeHome!.replaceFiles({ '.credentials.json': bytes });
      await expect(nativeHome!.readFiles(['.credentials.json'])).resolves.toEqual({ '.credentials.json': bytes });
      const replacement = new TextEncoder().encode('{"credential":"applied-bob"}');
      await expect(nativeHome!.replaceFiles({ '.credentials.json': replacement })).resolves.toBeUndefined();
      await expect(readFile(join(root, '.credentials.json'))).resolves.toEqual(Buffer.from(replacement));
    } finally {
      await runtime.dispose();
    }
  });
});
