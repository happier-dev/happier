import { expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import { runRequesterAttributionCase, withAdmittedSessionRun } from './testkit/admittedSessionRun.composed';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

it('captures the actual owning Account report preference before native Run creation and retains it', async () => {
  await withAdmittedSessionRun({ runReportPolicy: { preset: 'quiet' }, run: async fixture => {
    const started = await fixture.start({ runReportPolicy: { preset: 'everything' } });
    expect((await readRetainedExecutionRunRecord(started.runId))?.state).toMatchObject({ runReportPolicy: { preset: 'quiet' } });
  } });
});

it('refuses fresh parent report creation when the owning Account preferences read fails', async () => {
  await withAdmittedSessionRun({ runReportPreferencesUnavailable: true, run: async fixture => {
    const response = await fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId: fixture.session.sessionId, intent: 'delegate', backendTarget: { kind: 'agent', identity: fixture.agentIdentity },
      instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', modelSelection: null, connectedServices: null,
    }, { verifiedPeerAuthority: 'present_user' });
    expect(response).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(fixture.nativeOpen).not.toHaveBeenCalled();
  } });
});

it.each(['protected child', 'ordinary accepted marker', 'legacy metadata only'] as const)(
  'carries protected child admission through actual Session Run startup into the sole inventory without metadata inference (%s)',
  source => runRequesterAttributionCase(source),
);

it('carries admitted Bob Workflow custody through its real detached Action child Run into the sole inventory', async () => {
  await runRequesterAttributionCase('admitted Workflow');
});

it('delivers a public Session-owned Run its own Agent-qualified workspace skills and supporting files', async () => {
  await runRequesterAttributionCase('ordinary accepted marker', true);
});
