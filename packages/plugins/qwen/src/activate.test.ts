import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './manifest.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Qwen activation', () => {
  it('registers native history beside the account-aware ACP runtime', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(activation.registration('agents', 'qwen')?.externalSessions).toBeDefined();
      expect(activation.registration('agents', 'qwen')?.factory).toBeTypeOf('function');
    } finally {
      await activation.dispose();
    }
  });

  it('proves native resume through the shared ACP inspection owner', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const verify = activation.registration('agents', 'qwen')?.connectedAccountLaunch?.continuity?.verifyResumeReachable;
      const methods: string[] = [];
      await expect(verify?.({ vendorResumeId: 'qwen-session', sessionFiles: {
        verifyDeclaredPaths: async () => ({ found: false }), findDeclaredCandidate: async () => ({ found: false }),
      }, nativeInspection: { cwd: '/real/qwen/workspace', withDeclaredJsonRpcClient: async (_command, inspect) => await inspect({
        request: async method => { methods.push(method); return {}; }, notify: async () => undefined,
        onNotification: () => () => undefined, onRequest: () => () => undefined,
      }, new AbortController().signal) } })).resolves.toEqual({ ok: true, proof: 'native_session' });
      expect(methods).toEqual(['initialize', 'session/load']);
    } finally { await activation.dispose(); }
  });
});
