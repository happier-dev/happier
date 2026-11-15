import { describe, expect, it } from 'vitest';
import { SessionStatusResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { listPendingRequests, projectSessionStatusPendingRequestsV1 } from '@happier-dev/session-core/pending';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { compileActionCliCommands } from '@/cli/actions/compiledCommands';
import { captureStdout } from '@/testkit/logger/captureOutput';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { summarizeSessionRecord } from '@/cli/output/session/sessionSummary';
import { SESSION_STATUS_PRESENTATION } from './sessionLeafPresentation';

describe('Session status presentation', () => {
  it('prints the pending permission address needed to answer it, without private arguments', async () => {
    const pendingRequests = projectSessionStatusPendingRequestsV1(listPendingRequests({
      sessionId: 'session', active: true, permissionRelationship: 'owner',
      agentState: AgentStateSchema.parse({ requests: {
        'permission-address': { tool: 'mcp__fixture__echo', kind: 'permission', arguments: { private: 'content' }, createdAt: 1 },
      } }),
      actionConfirmations: null, presentationCompletedRequests: null, projected: null,
    }));
    const session = summarizeSessionRecord({ credentials: { token: 'test-token', encryption: null }, accountEncryptionMode: 'plain',
      session: createSessionRecordFixture({ id: 'session', active: true, encryptionMode: 'plain', metadata: '{}' }) });
    const payload = SessionStatusResultSchema.parse({ session, pendingRequests });
    const command = compileActionCliCommands().find(candidate => candidate.actionId === 'session.status.get');
    if (!command) throw new Error('Missing status command');
    const output = captureStdout();
    try {
      await SESSION_STATUS_PRESENTATION.presentSuccess!(payload, { command, json: true, input: { sessionId: 'session' }, callerInput: {} });
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, kind: 'session_status', data: {
        pendingRequests: [{ requestId: 'permission-address', kind: 'permission', tool: 'mcp__fixture__echo' }],
      } });
      expect(output.text()).not.toContain('private');
    } finally {
      output.restore();
    }
  });
});
