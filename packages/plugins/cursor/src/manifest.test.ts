import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Cursor plugin manifest', () => {
  it('declares the custom session runtime and finite Cursor access', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'cursor', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create', 'resume'], cancel: true } },
    });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth.nonInteractiveStatusProbe).toBe(true);
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cursor-api-key', capability: 'environment', scope: { keys: ['CURSOR_API_KEY'] } }),
      expect.objectContaining({
        id: 'cursor-process',
        capability: 'process',
        scope: expect.objectContaining({
          executables: [
            { kind: 'systemTool', id: 'cursor-agent' },
            { kind: 'systemTool', id: 'cursor-agent-no-fallback' },
          ],
        }),
      }),
    ]));
    expect(PLUGIN_MANIFEST.contributes.systemTools).toEqual([
      expect.objectContaining({
        id: 'cursor-agent',
        executableNames: ['cursor-agent', 'agent'],
      }),
      expect.objectContaining({
        id: 'cursor-agent-no-fallback',
        executableNames: ['cursor-agent'],
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      expect.objectContaining({
        target: { kind: 'agent', agent: 'cursor' },
        scope: 'daemon',
        fields: expect.arrayContaining([
          expect.objectContaining({ id: 'cursorBinaryPath' }),
          expect.objectContaining({ id: 'cursorAgentFallbackEnabled' }),
          expect.objectContaining({ id: 'cursorApiEndpoint' }),
        ]),
      }),
    ]);
  });
});
