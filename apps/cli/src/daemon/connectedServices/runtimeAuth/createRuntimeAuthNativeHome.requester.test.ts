import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedServiceRuntimeAuthNativeHome } from './createRuntimeAuthNativeHome';

describe('requester native authentication admission', () => {
  it('refuses native disclosure and replacement after requester admission is lost', async () => {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
    try {
      let current = true;
      const root = join(runtime.happyHomeDir, 'requester-native');
      const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({ agentId: 'claude', root,
        isCurrent: async () => current });
      expect(nativeHome, JSON.stringify({ diagnostics: runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'],
        declarations: runtime.registry.contributes.agents.filter(agent => agent.pluginId === 'happier.agent.claude')
          .map(agent => ({ manifestPath: agent.manifestPath, cliMetadata: agent.cliMetadata })) })).not.toBeNull();
      const bytes = new TextEncoder().encode('{"credential":"admitted-bob"}');
      await nativeHome!.replaceFiles({ '.credentials.json': bytes });
      current = false;
      await expect(nativeHome!.readFiles(['.credentials.json'])).rejects.toThrow('requester_session_not_current');
      await expect(nativeHome!.replaceFiles({ '.credentials.json': new TextEncoder().encode('retired') }))
        .rejects.toThrow('requester_session_not_current');
      await expect(readFile(join(root, '.credentials.json'))).resolves.toEqual(Buffer.from(bytes));
    } finally {
      await runtime.dispose();
    }
  });
});
