import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { readPendingCapabilityApplyV1, readSessionCapabilitySelectionFromMetadataV1 } from '../reach/sessionCapabilityMetadataV1.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { resolveSessionCapabilityItemIdentityV1, type SessionCapabilitiesActionPortV1 } from './executor/sessionCapabilities.js';
import type { CapabilityLaunchRestartV1 } from '../reach/capabilityApplyTimingV1.js';
import { createProfileOperations } from '../profiles/profileOperations.js';
import { createProfileActionExecuteV1 } from '../profiles/profileActionsV1.js';
import { ProfileRecordV1Schema } from '../profiles/profileRecordSchemaV1.js';
import { resolveSessionCapabilitiesV1 } from '../reach/resolveSessionCapabilitiesV1.js';
import { SessionSkillPlanV1Schema } from '../prompts/library/skills/resolveSessionSkillPlanV1.js';

const presentUser = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
function fixture(options: { vendorResume?: 'supported' | 'unsupported'; liveReload?: 'supported' | 'unsupported'; stopped?: boolean; conflict?: boolean; readFailure?: boolean; absent?: boolean; launchRestart?: CapabilityLaunchRestartV1 } = {}) {
  let metadata: object = { unrelated: 'kept' };
  let writes = 0;
  const approvals: ApprovalRequest[] = [];
  const port = {
    readSession: async () => {
      if (options.readFailure) throw new Error('Home unavailable');
      if (options.absent) return null;
      return { metadata, sessionRunning: !options.stopped,
        agent: { vendorResume: options.vendorResume ?? 'supported', skillsLiveReload: options.liveReload ?? 'supported' }, launchRestart: options.launchRestart ?? 'automatic' };
    },
    resolveItem: async ({ id }: { id: string }) => id === 'missing' ? null : id,
    writeMetadata: async ({ update }: { update: (metadata: object) => object }) => {
      if (options.conflict) return 'conflict';
      metadata = update(metadata); writes++; return 'updated';
    },
  } satisfies SessionCapabilitiesActionPortV1;
  // The substituted boundary is Account Session metadata persistence; unrelated executor ports are unused.
  const deps = { sessionCapabilities: port,
    approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { approvals.push(request); return { artifactId: 'approval-1' }; },
  } as unknown as ActionExecutorDeps;
  return { executor: createActionExecutor(deps), metadata: () => metadata, writes: () => writes, approvals };
}
describe('session capability Actions at the metadata CAS owner', () => {
  it('previews admitted Profile seeds through the real Profile reader and keeps explicit Session exclusions', async () => {
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'profile', definition: { kind: 'inline', profile: {
      v: 2, id: 'profile', name: 'Project work', createdAt: 1, updatedAt: 1,
    } }, enabled: true, skillSeeds: ['seeded', 'excluded'], secretBindings: {}, promptStack: [] });
    // Private Account row persistence and the remote Machine process are the only substituted boundaries.
    const operations = createProfileOperations({
      readCatalog: () => ({ source: 'destination', authority: 'active', controlRevision: 1,
        control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } },
        status: 'ready', records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 }),
      artifactsById: () => new Map(),
      writeRecord: async () => { throw new Error('Preview must not change Profiles'); },
      deleteRecord: async () => { throw new Error('Preview must not delete Profiles'); },
    });
    const deps = { profileActionExecute: createProfileActionExecuteV1({ operations }),
      spawnCapabilitiesPreview: async (input: { machineId: string; agentId: string; capabilitySelection?: Parameters<typeof resolveSessionCapabilitiesV1>[0]['selection'] }) => {
        const resolved = resolveSessionCapabilitiesV1({ context: { machineId: input.machineId, agentId: input.agentId,
          machinePlatform: 'posix', directory: null, projectKey: null }, mcp: null,
          skills: { items: ['seeded', 'excluded', 'explicit'].map(id => ({ skillId: id, name: id })), rules: [] },
          selection: input.capabilitySelection ?? {}, agentAcceptsUserMcp: false });
        return { ok: true, machinePlatform: 'posix', mcp: { strictMode: false, items: [], detected: [] },
          skills: { items: resolved.skills.items.map(item => ({ ...item, kind: 'skill' })),
            plan: SessionSkillPlanV1Schema.parse({ plan: 'none', items: [], nativeDisables: [], diagnostics: [] }) },
          applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } };
      },
    } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const input = { machineId: 'machine', agentId: 'codex', profileId: 'profile', capabilitySelection: {
      skills: { forceIncludeSkillIds: ['explicit'], forceExcludeSkillIds: ['excluded'] },
    } };
    expect(await executor.execute('sessions.spawn.capabilities.preview', input, presentUser)).toMatchObject({ ok: true, result: {
      ok: true, skills: { items: [{ id: 'seeded', selected: true }, { id: 'excluded', selected: false }, { id: 'explicit', selected: true }] },
    } });
    expect(await executor.execute('sessions.spawn.capabilities.preview', { ...input, profileId: 'missing' }, presentUser))
      .toEqual({ ok: true, result: { ok: false, reason: 'invalid_input' } });
  });
  it('resolves exact identities before names and refuses ambiguous name matches', () => {
    const items = [{ id: 'lint-id', name: 'lint' }, { id: 'lint', name: 'other' }, { id: 'second', name: 'lint' }];
    expect(resolveSessionCapabilityItemIdentityV1(items, 'lint')).toBe('lint');
    expect(resolveSessionCapabilityItemIdentityV1(items.filter(item => item.id !== 'lint'), 'lint')).toBeNull();
    expect(resolveSessionCapabilityItemIdentityV1(items, 'other')).toBe('lint');
    expect(resolveSessionCapabilityItemIdentityV1(items, 'missing')).toBeNull();
  });
  it('writes desired MCP selection with an applied baseline and restores previous override for Undo', async () => {
    const f = fixture();
    const input = { sessionId: 's', kind: 'mcp_server', id: 'linear', state: 'on', reason: 'Need issue context' };
    expect(await f.executor.execute('session.capabilities.set', input, presentUser)).toEqual({ ok: true, result: {
      ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' },
    } });
    expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).mcp.forceIncludeServerIds).toEqual(['linear']);
    expect(readPendingCapabilityApplyV1(f.metadata())).toEqual({ mcp: true, skills: false });
    expect(f.metadata()).toMatchObject({ unrelated: 'kept' });
    const removed = await f.executor.execute('session.capabilities.set', { ...input, state: 'off' }, presentUser);
    expect(removed).toMatchObject({ ok: true, result: { previous: 'on' } });
    expect(await f.executor.execute('session.capabilities.set', input, presentUser)).toMatchObject({ ok: true, result: { previous: 'off' } });
  });
  it('predicts live library skills but never live native overlay changes', async () => {
    const f = fixture();
    expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'skill', id: 'lint', state: 'on' }, presentUser))
      .toMatchObject({ ok: true, result: { applyTiming: { t: 'applied_now' } } });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'native_skill', id: 'native-lint', state: 'off' }, presentUser))
      .toMatchObject({ ok: true, result: { applyTiming: { t: 'next_turn' } } });
    expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).skills.excludeNativeSkillNames).toEqual(['native-lint']);
  });
  it('refuses a running no-resume change before any metadata write, but saves stopped edits', async () => {
    const f = fixture({ vendorResume: 'unsupported', liveReload: 'unsupported' });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'mcp_server', id: 'linear', state: 'on' }, presentUser))
      .toEqual({ ok: true, result: { ok: false, code: 'applies_to_new_sessions_only' } });
    expect(f.writes()).toBe(0);
    const stopped = fixture({ stopped: true, vendorResume: 'unsupported' });
    expect(await stopped.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'skill', id: 'lint', state: 'off' }, presentUser))
      .toMatchObject({ ok: true, result: { applyTiming: { t: 'session_not_running' } } });
    expect(readPendingCapabilityApplyV1(stopped.metadata()).skills).toBe(false);
  });
  it('returns missing identity and lost CAS without mutating selection', async () => {
    const f = fixture({ conflict: true });
    for (const [id, code] of [['missing', 'not_found'], ['linear', 'conflict']]) {
      expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'mcp_server', id, state: 'on' }, presentUser))
        .toEqual({ ok: true, result: { ok: false, code, ...(code === 'not_found' ? { diagnostic: { reason: 'capability_identity_unresolved' } } : {}) } });
    }
    expect(f.writes()).toBe(0);
  });
  it('distinguishes an absent Session from an unresolved capability identity', async () => {
    const f = fixture({ absent: true });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'skill', id: 'lint', state: 'on' }, presentUser))
      .toEqual({ ok: true, result: { ok: false, code: 'not_found', diagnostic: { reason: 'session_absent' } } });
    expect(f.writes()).toBe(0);
  });
  it('reports unavailable read authority as a typed refusal before a write', async () => {
    const f = fixture({ readFailure: true });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'skill', id: 'lint', state: 'on' }, presentUser))
      .toEqual({ ok: true, result: { ok: false, code: 'session_unavailable' } });
    expect(f.writes()).toBe(0);
  });
  it.each([
    ['windows_hosted_runner', 'user'], ['not_daemon_started', 'terminal'], ['not_remote_started', 'terminal'],
  ] as const)('saves a %s Session override and publishes the D34 restart instruction', async (refused, restartBy) => {
    const f = fixture({ launchRestart: { refused } });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: 's', kind: 'mcp_server', id: 'linear', state: 'off' }, presentUser))
      .toEqual({ ok: true, result: { ok: true, state: 'off', previous: 'inherit', applyTiming: { t: 'restart_to_apply', restartBy } } });
    expect(readPendingCapabilityApplyV1(f.metadata()).mcp).toBe(true);
  });
  it('carries reason into the Agent approval, writes nothing before approval, and honors a persisted waiver', async () => {
    const f = fixture(), request = { sessionId: 's', kind: 'skill', id: 'lint', state: 'on', reason: 'Run the project lint rules' };
    const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: 's', serverId: 'home',
      actionRequestId: 'capability-change', actionCaller: { kind: 'host' } } as const;
    expect(await f.executor.execute('session.capabilities.set', request, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.writes()).toBe(0);
    expect(f.approvals[0]?.actionArgs).toEqual(request);
    expect(await f.executor.execute('session.capabilities.set', request, { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.capabilities.set': ['agent'] } }),
    })).toMatchObject({ ok: true, result: { ok: true } });
    expect(f.metadata()).not.toHaveProperty('reason');
  });
});
