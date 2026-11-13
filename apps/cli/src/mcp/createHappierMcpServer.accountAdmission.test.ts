import { expect, it } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHappierMcpServer } from './createHappierMcpServer';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';

it('retains the native realtime caller refusal at the native Action tool entry', async () => {
  const sessionId = 'caller-session';
  const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
    agentStartPolicy: accountSettingsParse({}),
    execute: async () => { throw new Error('Invalid caller must not reach Action execution'); },
  });
  const session = createMutableApiSessionClientFixture({ sessionId, metadata: createTestMetadata(), overrides: {
    getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
      features: FeaturesResponseSchema.parse({ features: { workflows: { enabled: true } }, capabilities: {} }) }),
    getActiveTurnAdmissionWitness: () => ({ turnId: 'native-turn', inputId: 'different-input',
      nativeRealtimeAdmission: { admissionId: 'admitted-input', occurrenceId: 'provider-occurrence', attemptId: 'live-attempt' },
      userMessageSeq: null, userMessageSeqs: [], signal: new AbortController().signal,
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    }),
  } });
  const runtime = createHappierMcpServer(session, { sessionCredentials: { token: 'test-session-transport', encryption: null } });
  try {
    // Native host tools use this same public dispatcher. External MCP auth is
    // a separate daemon operation, not the Action caller guard under test.
    const result = await runtime.executeTool({ toolName: 'action_execute', args: {
      actionId: 'workflow.definition.edit', input: {
        definitionId: '1113a111-1113-4113-8113-111311131113', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
        ops: [{ kind: 'rename', name: 'Updated recipe' }],
      },
    } });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { code: 'target_unavailable', diagnostic: { reason: 'native_realtime_caller_invalid' } } });
    expect(daemon.actionRequestCount).toBe(0);
  } finally {
    await runtime.mcp.close();
    await daemon.close();
  }
});
