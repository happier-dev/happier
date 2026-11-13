import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionStop, type SessionStopInput } from './sessionStop';
import { evaluateSessionEligibility } from '../sessionEligibility';
import type { GuardCandidate } from '../guardPlanner';
import type { TrackedSession } from '../../types';
import { createGuardSessionStopReceipt } from '../sessionStopReceipt';
import { createSessionSystemRecordPayloadService } from '@/session/systemRecords/sessionSystemRecordPayloadService';
import type { LegacyHostSessionSystemRecord } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => { await runtime?.dispose(); });

describe('memory guard Session stop admission', () => {
  it.each(['pid', 'birth', 'promoted_runner', 'equal_promoted_runner'] as const)('pins the captured target through same tracked object %s final admission', async change => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(10), pid: 10, happySessionId: 's', startedBy: 'daemon', processStartTimeMs: 1 };
    if (change === 'equal_promoted_runner') {
      tracked.sessionRunnerPid = 11; tracked.runnerProcessIdentity = { pid: 11, processStartTimeMs: 2, processCommandHash: 'runner-11' };
    }
    const root = { owner: { kind: 'session' as const, sessionId: 's' }, pid: change === 'equal_promoted_runner' ? 11 : 10,
      start: { startTimeMs: change === 'equal_promoted_runner' ? 2 : 1 }, live: true, ownerCreatedAtMs: 0 };
    const inventory = { coverage: 'complete' as const, items: [{ category: 'session' as const, ownerRef: tracked,
      attribution: { kind: 'unknown' as const }, state: 'settled' as const, settledAt: 0 }] };
    const resume = { sessionId: 's', rawSession: { machineId: 'm', path: '/project' },
      metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } },
        machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' } };
    const eligibility = await evaluateSessionEligibility({ tracked, inventory, resume, draft: { status: 'absent' } });
    const candidate: GuardCandidate = { kind: 'session', rung: 'idleSessions', step: 3, root,
      target: { kind: 'session', root, tracked, eligibility, label: 'Session' }, footprintBytes: 0, settledAt: 0, attribution: { kind: 'unknown' } };
    if (change === 'pid') tracked.pid = 11;
    else if (change === 'birth') tracked.processStartTimeMs = 2;
    else if (change === 'promoted_runner') { tracked.sessionRunnerPid = 11; tracked.runnerProcessIdentity = { pid: 11, processStartTimeMs: 2, processCommandHash: 'runner-11' }; }
    let nativeStops = 0;
    const result = await sessionStop({ candidate, signal: new AbortController().signal,
      readCurrentTracked: () => tracked,
      readCurrentEligibility: async () => evaluateSessionEligibility({ tracked, inventory, resume, draft: { status: 'absent' } }),
      stopSession: async () => { nativeStops++; return true; } });
    expect(result).toEqual(change === 'equal_promoted_runner' ? { status: 'stopped' } : { status: 'failed', reason: 'identity_changed' });
    expect(nativeStops).toBe(change === 'equal_promoted_runner' ? 1 : 0);
  });
  it.each(['refused', 'error', 'draft', 'cancelled'] as const)('settles the original intent when native admission is %s', async mode => {
    let content: LegacyHostSessionSystemRecord['content'] = { t: 'plain', v: {
      v: 1, at: 1000, status: 'requested', rule: 'memory_guard',
    } };
    const addresses: string[] = [];
    const records = createSessionSystemRecordPayloadService({ sessionId: 's',
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      fetchSessionSystemRecord: async request => ({ id: 'record', sessionId: 's',
        createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
        namespace: request.namespace, localId: request.localId, kind: 'session_stop.v1', content }),
      upsertSessionSystemRecord: async request => { content = request.content; addresses.push(request.localId); },
    });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(10), pid: 10, happySessionId: 's', startedBy: 'daemon',
      guardStopReceipt: createGuardSessionStopReceipt({ records, at: 1000 }) };
    const root = { owner: { kind: 'session' as const, sessionId: 's' }, pid: 10, start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 0 };
    const eligibilityInput = { tracked,
      resume: { sessionId: 's', rawSession: { machineId: 'm', path: '/project' },
        metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' } },
      inventory: { coverage: 'complete' as const, items: [{ category: 'session' as const, ownerRef: tracked,
        attribution: { kind: 'unknown' as const }, state: 'settled' as const, settledAt: 0 }] } };
    const eligibility = (await evaluateSessionEligibility({ ...eligibilityInput, draft: { status: 'absent' } }));
    const candidate: GuardCandidate = { kind: 'session', rung: 'idleSessions', step: 3, root,
      target: { kind: 'session', root, tracked, eligibility, label: 'Session' }, settledAt: 0, footprintBytes: 80, attribution: { kind: 'unknown' } };
    const controller = new AbortController(); if (mode === 'cancelled') controller.abort();
    const result = await sessionStop({ candidate, signal: controller.signal, readCurrentTracked: () => tracked,
      readCurrentEligibility: async () => (await evaluateSessionEligibility({ ...eligibilityInput,
        draft: mode === 'draft' ? { status: 'present', updatedAt: 1 } : { status: 'absent' } })),
      // Native stop adapter boundary; cancelled admissions must not reach it.
      stopSession: async () => { if (mode !== 'refused') throw new Error('Native stop failed'); return false; } });
    expect(result.status).toBe('failed');
    expect(content).toMatchObject({ t: 'plain', v: { status: mode === 'refused' || mode === 'error' ? 'failed' : 'cancelled' } });
    expect(addresses).toEqual(['activity:session_stop:v1:1000']);
  });
  it('does not stop a replaced occurrence, fresh draft, or newly settled interval', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(10), pid: 10, happySessionId: 's', startedBy: 'daemon' };
    const root = { owner: { kind: 'session' as const, sessionId: 's' }, pid: 10, start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 0 };
    const resume = { sessionId: 's', rawSession: { machineId: 'm', path: '/project' },
      metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' } };
    const inventory = { coverage: 'complete' as const, items: [{ category: 'session' as const, ownerRef: tracked,
      attribution: { kind: 'unknown' as const }, state: 'settled' as const, settledAt: 0 }] };
    const eligibility = (await evaluateSessionEligibility({ tracked, inventory, resume, draft: { status: 'absent' } }));
    const candidate: GuardCandidate = { kind: 'session', rung: 'idleSessions', step: 3, root,
      target: { kind: 'session', root, tracked, eligibility, label: 'Session' }, settledAt: 0, footprintBytes: 80, attribution: { kind: 'unknown' } };
    const input: SessionStopInput = { candidate, signal: new AbortController().signal,
      readCurrentTracked: () => tracked,
      readCurrentEligibility: async () => (await evaluateSessionEligibility({ tracked, inventory, resume, draft: { status: 'present', updatedAt: 1 } })),
      // No signal boundary is reached for these denied admissions. Full canonical stop intent is integration-owned.
      stopSession: async () => { throw new Error('unexpected native stop'); } };
    expect(await sessionStop(input)).toEqual({ status: 'failed', reason: 'unsent_draft' });
    expect(await sessionStop({ ...input, readCurrentTracked: () => ({ ...tracked }) }))
      .toEqual({ status: 'failed', reason: 'identity_changed' });
    expect(await sessionStop({ ...input, readCurrentEligibility: async () => (await evaluateSessionEligibility({ tracked,
      inventory: { ...inventory, items: inventory.items.map(item => ({ ...item, settledAt: 1 })) }, resume, draft: { status: 'absent' } })) }))
      .toEqual({ status: 'failed', reason: 'activity_changed' });
  });
});
