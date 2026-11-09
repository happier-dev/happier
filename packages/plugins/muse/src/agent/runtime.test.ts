import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createMuseAgentRuntime } from './runtime.js';
import { createMuseMspProcessFixture, readMuseMspProcessAudit } from './testkit/mspProcess.js';

describe('Muse native conversation runtime', () => {
  it('lists models from one scoped native catalog process and closes it', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-models-'));
    const auditPath = join(scratch, 'native-audit.json');
    const fixture = await createMuseMspProcessFixture({ auditPath, cwd: process.cwd() });
    const signal = new AbortController().signal;
    const exec = createStablePluginExecService({ ...fixture, signal, isOccurrenceCurrent: () => true });
    // The OS process boundary remains real; the control's admitted context supplies its native scope.
    const context = { signal, services: { exec }, session: {
      id: 'host-session', cwd: process.cwd(), activity: 'active', connectedAccounts: [],
      providerSessionId: '01a1bf87-da7f-7ce0-a4ff-bab34925049f',
      launchEnvironment: { values: { MUSE_TEST_SELECTED_HOME: '/selected/catalog/home' }, unset: [] },
    } } as unknown as AgentSessionControlContext;
    try {
      const control = createMuseAgentRuntime().sessions.catalog;
      expect(control).toBeDefined();
      const result = await control?.list({ kind: 'models' }, context);
      expect(result).toMatchObject({ status: 'ok', kind: 'models', defaultModelId: 'meta/muse-wonder-1.0' });
      if (result?.status !== 'ok' || result.kind !== 'models') throw new Error('Native models were unavailable');
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'meta/muse-wonder-1.0' })]));
      const audit = await readMuseMspProcessAudit(auditPath);
      expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1, commandCount: 0,
        cwd: process.cwd(), autoUpdate: '1', selectedHome: '/selected/catalog/home' });
      expect(audit.methods.filter(method => method === 'model/list')).toHaveLength(1);
      expect(audit.modelListSessionIds).toEqual(['01a1bf87-da7f-7ce0-a4ff-bab34925049f']);
      expect(audit.methods.filter(method => method === 'session/start' || method === 'turn/start')).toHaveLength(0);
      expect(await control?.list({ kind: 'vendorPlugins' }, context)).toMatchObject({ status: 'unsupported' });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

});
