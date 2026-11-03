import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { logger } from '@/ui/logger';
import { once } from 'node:events';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome, writeDaemonStateFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import type { AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import type { RestartSessionRunnerRequestV1, RestartSessionRunnerResultV1 } from '@happier-dev/protocol';
import { RestartSessionRunnerRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { readCapabilitySelectionApplyV1, readPendingCapabilityApplyV1, resolveSelectionRestartMarkersForStartupV1, writeCapabilitySelectionApplyV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createCapabilitySelectionSynchronizer, type CapabilitySelectionSynchronizerInput } from './capabilitySelectionSynchronizer';
import type { SkillRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionCapabilityApplyChange, sessionCapabilityApplyNotice } from '../../../../ui/sources/components/sessions/capabilities/sessionCapabilityApplyNotice';

function fixture(results: RestartSessionRunnerResultV1[] = [{ ok: true, status: 'restarted', sessionId: 'session' }],
  options: Partial<Pick<CapabilitySelectionSynchronizerInput, 'agent' | 'skillsRunner' | 'skillsTransports' | 'initialSkillRules' | 'readSkillRules' | 'initialMcpRules' | 'readMcpRules' | 'subscribeAccountSettings'>> = {}, initialMetadata = createTestMetadata()) {
  let metadata = initialMetadata;
  let settled = false;
  let refusePublication = false;
  let refuseNextPublication = false;
  const requests: RestartSessionRunnerRequestV1[] = [];
  const sync = createCapabilitySelectionSynchronizer({
    session: { sessionId: 'session', getMetadataSnapshot: () => metadata,
      updateMetadataAsCurrentPublisher: async update => {
        if (refusePublication || refuseNextPublication) { refuseNextPublication = false; throw new Error('metadata transport unavailable'); }
        metadata = update(metadata);
      } },
    agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
    isStarted: () => true, isSettled: () => settled,
    ...options,
    requestRestart: async request => { requests.push(request); return results.shift() ?? { ok: true, status: 'restarted', sessionId: 'session' }; },
  });
  return { sync, requests, get metadata() { return metadata; }, settle: () => { settled = true; }, startTurn: () => { settled = false; },
    refusePublication: () => { refusePublication = true; },
    refuseNextPublication: () => { refuseNextPublication = true; },
    patch: (value: Partial<typeof metadata>) => { metadata = { ...metadata, ...value }; sync.syncFromMetadata(); },
    changeSkills: (selection: NonNullable<typeof metadata.skillSelectionV1>) => {
      metadata = writeSessionCapabilitySelectionToMetadataV1(metadata, { skills: selection }, { sessionActive: true }); sync.syncFromMetadata();
    },
    change: (id: string) => { metadata = writeSessionCapabilitySelectionToMetadataV1(metadata,
      { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [id] } }, { sessionActive: true }); sync.syncFromMetadata(); },
  };
}

describe('capability selection settled-turn apply', () => {
  it('keeps an equivalent skill-rule selection applied across reordered and retimestamped observations', async () => {
    const context = { machineId: 'machine', machinePlatform: 'posix' as const, directory: '/repo', projectKey: null, agentId: 'fixture' };
    const rules: SkillRuleV1[] = ['alpha', 'beta'].map(skillId => ({ id: skillId, skillId,
      target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }));
    const f = fixture(undefined, { initialSkillRules: { context, rules },
      readSkillRules: () => ({ context, rules: [...rules].reverse().map(rule => ({ ...rule, updatedAt: 2 })) }) });
    try {
      f.settle(); await f.sync.flushAfterSettledTurn('one');
      f.sync.syncFromMetadata(); await f.sync.flushAfterSettledTurn('two');
      expect(f.requests).toEqual([]);
      expect(readPendingCapabilityApplyV1(f.metadata).skills).toBe(false);
    } finally { await f.sync.dispose(); }
  });

  it.each([false, true])('uses positive skill launch evidence despite retained rule-pending metadata (changed: %s)', async changed => {
    const context = { machineId: 'machine', machinePlatform: 'posix' as const, directory: '/repo', projectKey: null, agentId: 'fixture' };
    const rules = (enabled: boolean): SkillRuleV1[] => [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' },
      enabled, createdAt: 1, updatedAt: enabled ? 1 : 2 }];
    const f = fixture(undefined, {
      initialSkillRules: { context, rules: rules(true) },
      readSkillRules: () => ({ context, rules: rules(!changed) }),
    }, createTestMetadata({ capabilitySelectionApplyV1: { skills: { source: 'rules', reason: 'next_turn' } } }));
    try {
      f.settle(); await f.sync.flushAfterSettledTurn('one');
      f.sync.syncFromMetadata(); await f.sync.flushAfterSettledTurn('two');
      expect(f.requests).toHaveLength(changed ? 1 : 0);
      if (!changed) expect(readPendingCapabilityApplyV1(f.metadata).skills).toBe(false);
    } finally { await f.sync.dispose(); }
  });

  it('records the changed capability basis before requesting runner replacement', async () => {
    const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const f = fixture();
    try {
      f.change('server'); f.settle();
      await f.sync.flushAfterSettledTurn();
      expect(log).toHaveBeenCalledWith('[CapabilitySelection] Requesting runner refresh', expect.objectContaining({
        sessionId: 'session', changes: { mcpSelection: true, skillsSelection: false, mcpRules: false, skillRules: false },
      }));
    } finally {
      await f.sync.dispose(); log.mockRestore();
    }
  });

  it.each([false, true])('diagnoses selected-set changes without treating an unknown baseline as empty (pending: %s)', async pending => {
    const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const context = { machineId: 'machine', machinePlatform: 'posix' as const, directory: '/repo', projectKey: null, agentId: 'fixture' };
    const rules = (ids: string[]): SkillRuleV1[] => ids.map(skillId => ({ id: `rule-${skillId}`, skillId,
      target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }));
    let current = { context, rules: rules(['beta', 'alpha']), catalog: { revision: 3, authority: 'active' as const } };
    const f = fixture(undefined, {
      ...(!pending ? { initialSkillRules: current } : {}), readSkillRules: () => current,
    }, createTestMetadata(pending ? { capabilitySelectionApplyV1: { skills: { source: 'rules', reason: 'next_turn' } } } : {}));
    try {
      current = { context, rules: rules(['gamma', 'beta']), catalog: { revision: 4, authority: 'active' } };
      f.settle(); await f.sync.flushAfterSettledTurn();
      expect(f.requests).toHaveLength(1);
      expect(log).toHaveBeenCalledWith('[CapabilitySelection] Requesting runner refresh', expect.objectContaining({
        ruleBaselines: expect.objectContaining({ skills: {
          source: pending ? 'pending' : 'launch', unknown: pending, observedAvailable: true,
          appliedCatalog: pending ? null : { revision: 3, authority: 'active' },
          observedCatalog: { revision: 4, authority: 'active' },
          addedIds: pending ? null : ['gamma'], removedIds: pending ? null : ['alpha'],
        } }),
      }));
    } finally { await f.sync.dispose(); log.mockRestore(); }
  });

  it('retires a pending restart HTTP observation on disposal without publishing a failure or resending', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-capability-restart-cancellation-' }, async ({ homeDir }) => {
      let started!: () => void;
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      let release: (() => void) | undefined;
      let requests = 0;
      const server = createServer((request, response) => {
        request.resume();
        if (request.url !== '/session-runners/restart') { response.writeHead(404).end(); return; }
        requests += 1;
        release = () => response.end(JSON.stringify({ ok: true, status: 'restarted', sessionId: 'session' }));
        started();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: process.pid, httpPort: address.port, controlToken: 'test-control',
      });
      let metadata = createTestMetadata();
      let retired = false;
      let latePublications = 0;
      const sync = createCapabilitySelectionSynchronizer({
        session: { sessionId: 'session', getMetadataSnapshot: () => metadata,
          updateMetadataAsCurrentPublisher: async update => { if (retired) latePublications += 1; metadata = update(metadata); } },
        agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
        isStarted: () => true, isSettled: () => true,
      });
      metadata = writeSessionCapabilitySelectionToMetadataV1(metadata, {
        mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['server'] },
      }, { sessionActive: true });
      const applying = sync.flushAfterSettledTurn();
      try {
        await Promise.race([requestStarted, applying.then(() => { throw new Error('Capability apply ended before restart HTTP admission'); })]);
        retired = true;
        await sync.dispose();
        const outcome = await Promise.race([applying.then(() => 'retired'), new Promise<null>(resolve => setTimeout(() => resolve(null), 150))]);
        release?.(); await applying;
        expect(outcome, 'Disposed synchronizer must stop observing the pending daemon request').toBe('retired');
        expect(latePublications).toBe(0);
        await sync.flushAfterSettledTurn('next');
        expect(requests).toBe(1);
      } finally {
        await sync.dispose(); release?.(); await applying;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  it.each(['retry', 'restore', 'include'] as const)('uses the captured MCP launch baseline through unavailable reads and busy settlement for %s', async scenario => {
    const context = { machineId: 'machine', machinePlatform: 'posix' as const, directory: '/repo', projectKey: 'project', agentId: 'codex' };
    const settings = (enabled: boolean) => ({ v: 1 as const, strictMode: false,
      servers: [{ id: 'inherited', name: 'inherited', transport: 'http' as const, remote: { url: 'https://example.com/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'rule', serverId: 'inherited', target: { t: 'project' as const, projectKey: 'project' }, enabled, createdAt: 1, updatedAt: 1 }] });
    let available = true;
    let current = settings(false); // Rule changed after launch, before loop construction.
    let wake = () => {};
    const f = fixture([{ ok: false, status: 'busy', sessionId: 'session', reasonCode: 'approval_pending' },
      { ok: true, status: 'restarted', sessionId: 'session' }], {
      initialMcpRules: { context, settings: settings(true), mcpPluginItems: [], selectedServerIds: ['inherited'] },
      readMcpRules: () => available ? { context, settings: current, mcpPluginItems: [] } : null,
      subscribeAccountSettings: listener => { wake = listener; return () => {}; },
    }, createTestMetadata(scenario === 'include' ? { mcpSelectionV1: { v: 1, managedServersEnabled: true,
      forceIncludeServerIds: ['inherited'], forceExcludeServerIds: [] } } : {}));
    await f.sync.flushBeforeTurn();
    if (scenario === 'include') {
      expect(readPendingCapabilityApplyV1(f.metadata).mcp).toBe(false);
      f.settle(); await f.sync.flushAfterSettledTurn();
      expect(f.requests).toEqual([]);
      await f.sync.dispose(); return;
    }
    expect(readPendingCapabilityApplyV1(f.metadata).mcp).toBe(true);
    expect(f.metadata.capabilitySelectionApplyV1?.mcp).toMatchObject({ reason: 'next_turn', source: 'rules' });
    expect(f.requests).toEqual([]);
    available = false; wake(); await f.sync.flushBeforeTurn();
    expect(readPendingCapabilityApplyV1(f.metadata).mcp).toBe(true);
    available = true; wake(); f.settle(); await f.sync.flushAfterSettledTurn('one');
    expect(f.requests).toHaveLength(1);
    expect(f.metadata.capabilitySelectionApplyV1?.mcp).toMatchObject({ reason: 'next_turn', source: 'rules' });
    if (scenario === 'restore') {
      current = settings(true); wake();
      await vi.waitFor(() => expect(readPendingCapabilityApplyV1(f.metadata).mcp).toBe(false));
      expect(f.metadata.capabilitySelectionApplyV1).toBeUndefined();
      expect(f.metadata.mcpSelectionV1).toBeUndefined();
      expect(f.requests).toHaveLength(1);
      await f.sync.dispose(); return;
    }
    wake(); await f.sync.flushBeforeTurn(); await f.sync.flushAfterSettledTurn('one');
    expect(f.requests).toHaveLength(1);
    await f.sync.flushAfterSettledTurn('two');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toEqual({ sessionId: 'session', mode: 'force_current_cli', reason: 'capability_selection_change' });
    await f.sync.dispose();
  });
  it.each(['supported', 'unsupported'] as const)('publishes rule-only pending metadata through the strict notice consumer with %s reload', async skillsLiveReload => {
    let enabled = true;
    let wake = () => {};
    const f = fixture(undefined, {
      agent: { vendorResume: 'supported', skillsLiveReload },
      readSkillRules: () => ({ context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' },
        rules: [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' }, enabled, createdAt: 1, updatedAt: 1 }] }),
      subscribeAccountSettings: listener => { wake = listener; return () => { wake = () => {}; }; },
    });
    const notice = () => {
      const created = createSessionOwnerMetadataV1({ metadata: f.metadata });
      if (!created.ok) throw new Error(`Owner metadata rejected: ${created.unsupportedFields.join(', ')}`);
      const ownerMetadata = SessionOwnerMetadataV1Schema.parse(created.ownerMetadata);
      const metadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata: f.metadata }), ownerMetadata });
      return sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(metadata),
        applyTiming: { mcp: { t: 'next_turn' }, skills: { t: skillsLiveReload === 'supported' ? 'applied_now' : 'next_turn' } },
        change: readSessionCapabilityApplyChange(metadata, () => null), machineOnline: true, machineName: 'QA', turnSettled: false });
    };
    try {
      enabled = false; wake();
      await vi.waitFor(() => expect(notice()?.key).toBe('pendingNextTurn'));
      expect(f.metadata.skillSelectionV1).toBeUndefined();
      expect(f.requests).toEqual([]);
      enabled = true; wake(); await f.sync.flushBeforeTurn();
      expect(notice()).toBeNull();
    } finally { await f.sync.dispose(); }
  });
  it('does not acknowledge a retained rule refusal merely by attaching to current rules', async () => {
    const retained = writeCapabilitySelectionApplyV1(createTestMetadata({ startedBy: 'terminal' }), {
      skills: { source: 'rules', reason: 'restart_to_apply', restartBy: 'terminal' },
    });
    const f = fixture(undefined, {
      readSkillRules: () => ({ context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' }, rules: [] }),
    }, resolveSelectionRestartMarkersForStartupV1({ current: retained, applied: 'preserved_process' }));
    f.settle(); await f.sync.flushAfterSettledTurn();
    expect(readPendingCapabilityApplyV1(f.metadata)).toEqual({ mcp: false, skills: true });
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ skills: { reason: 'restart_to_apply', restartBy: 'terminal' } });
    expect(f.requests).toEqual([]);
  });
  it('preserves a rule-only refusal when an MCP edit arrives during an unavailable rule read', async () => {
    let enabled = true;
    let available = true;
    let wake = () => {};
    const f = fixture(undefined, {
      readSkillRules: () => available ? { context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' },
        rules: [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' }, enabled, createdAt: 1, updatedAt: 1 }] } : null,
      subscribeAccountSettings: listener => { wake = listener; return () => { wake = () => {}; }; },
    });
    f.patch({ startedBy: 'terminal' });
    enabled = false; wake(); f.settle(); await f.sync.flushAfterSettledTurn();
    expect(readPendingCapabilityApplyV1(f.metadata).skills).toBe(true);
    available = false; wake(); f.change('server'); await f.sync.flushBeforeTurn();
    expect(readPendingCapabilityApplyV1(f.metadata)).toEqual({ mcp: true, skills: true });
    expect(f.metadata.capabilitySelectionApplyV1?.skills).toEqual({ source: 'rules', reason: 'restart_to_apply', restartBy: 'terminal' });
    expect(f.requests).toEqual([]);
  });
  it('does not retry a hard rule-apply refusal on an unchanged Account refresh', async () => {
    let enabled = true;
    let available = true;
    let wake = () => {};
    const f = fixture([{ ok: false, status: 'missing_resume_snapshot', sessionId: 'session', reasonCode: 'missing_resume_identity' }], {
      readSkillRules: () => available ? { context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' },
        rules: [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' }, enabled, createdAt: 1, updatedAt: 1 }] } : null,
      subscribeAccountSettings: listener => { wake = listener; return () => { wake = () => {}; }; },
    });
    enabled = false; wake(); f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(1);
    available = false; wake(); await f.sync.flushBeforeTurn();
    available = true; wake(); await f.sync.flushBeforeTurn();
    expect(f.requests).toHaveLength(1);
    expect(readPendingCapabilityApplyV1(f.metadata)).toEqual({ mcp: false, skills: true });
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ skills: { reason: 'missing_resume_snapshot' } });
  });
  it('keeps rule-only manual apply pending without inventing a Session override or retrying', async () => {
    let enabled = true;
    let wake = () => {};
    const f = fixture(undefined, {
      readSkillRules: () => ({ context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' },
        rules: [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' }, enabled, createdAt: 1, updatedAt: 1 }] }),
      subscribeAccountSettings: listener => { wake = listener; return () => { wake = () => {}; }; },
    });
    f.patch({ startedBy: 'terminal' });
    enabled = false; wake(); f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([]);
    expect(f.metadata.skillSelectionV1).toBeUndefined();
    expect(readPendingCapabilityApplyV1(f.metadata)).toEqual({ mcp: false, skills: true });
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ skills: { reason: 'restart_to_apply', restartBy: 'terminal' } });
    expect(f.metadata.capabilitySelectionApplyV1?.skills).toMatchObject({ source: 'rules' });
    await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([]);
    enabled = true; wake(); await f.sync.flushBeforeTurn();
    expect(readPendingCapabilityApplyV1(f.metadata)).toEqual({ mcp: false, skills: false });
    expect(f.metadata.capabilitySelectionApplyV1).toBeUndefined();
    expect(f.requests).toEqual([]);
  });
  it('restarts for effective rule changes at settlement while unrelated rules stay inert', async () => {
    let rules: SkillRuleV1[] = [{ id: 'rule', skillId: 'inherited', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }];
    let wake = () => {};
    const f = fixture(undefined, {
      readSkillRules: () => ({ context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' }, rules }),
      subscribeAccountSettings: listener => { wake = listener; return () => { wake = () => {}; }; },
    });
    rules = [...rules, { id: 'other', skillId: 'neighbour', target: { t: 'machine', machineId: 'other' }, enabled: true, createdAt: 1, updatedAt: 1 }];
    wake(); await f.sync.flushBeforeTurn(); expect(f.requests).toEqual([]);
    rules = rules.map(rule => ({ ...rule, enabled: false, updatedAt: 2 }));
    wake(); await f.sync.flushBeforeTurn(); expect(f.requests).toEqual([]);
    f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([{ sessionId: 'session', mode: 'force_current_cli', reason: 'capability_selection_change' }]);
  });
  it.each([
    [{ startedBy: 'terminal' }, 'terminal'],
    [{ terminal: { mode: 'windows_console' } }, 'user'],
  ] as const)('keeps known launch restriction %j pending without automatic daemon restart', async (metadata, restartBy) => {
    const f = fixture();
    f.patch(metadata); f.change('server'); f.settle();
    await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([]);
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ mcp: { reason: 'restart_to_apply', restartBy } });
    expect(f.metadata.mcpSelectionRestartRequiredV1).toBeDefined();
  });
  it.each(['applied', 'restart_required', 'input_arrives', 'advancing', 'ack_failed'] as const)('uses the real skill reapply owner after settlement and handles native %s', async nativeOutcome => {
    const restoreProjectHttp = installEmptyProjectAccountRowsHttpBoundary();
    const home = await mkdtemp(join(tmpdir(), 'happier-impl-p2c-u6-skills-'));
    await mkdir(join(home, 'project'));
    const { createSkillStore } = await import('@/prompts/skills/store/skillStore');
    const store = createSkillStore({ happyHomeDir: join(home, 'happier') });
    const artifact: AccountArtifact = {
      artifactId: 'library', ownerAccountId: 'account', access: 'owner',
      revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1,
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'sample', bundleSchemaId: 'skills.skill_md_v1' },
      body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
        { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: sample\ndescription: Useful\n---\nBody').toString('base64') },
      ] }),
    };
    let reloads = 0;
    let appliedItems: readonly unknown[] | null = null;
    let f: ReturnType<typeof fixture>;
    try {
      f = fixture(undefined, { agent: { vendorResume: 'supported', skillsLiveReload: 'supported' },
        skillsRunner: {
          readInput: () => ({ ownerKey: 'session', agentId: 'fixture', machineId: 'machine', directory: join(home, 'project'), home,
            credentials: { token: 'test', encryption: null }, sessionMetadata: f.metadata, agentHasActionChannel: true,
            contributes: { catalogEntriesById: { fixture: { skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' } } } },
            accountSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
              promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [
                { id: 'core-off', skillId: 'happier:happier', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1 },
              ] } } }], tombstones: [], diagnostics: [] } },
          }),
          runtime: { refreshSkills: async ({ skills }) => {
            reloads++;
            if (nativeOutcome === 'applied') expect(skills.items).toEqual([expect.objectContaining({ name: 'sample' })]);
            else expect(skills.items).toEqual([]);
            if (nativeOutcome === 'advancing' && reloads === 1) {
              f.changeSkills({ v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: ['second-change'], excludeNativeSkillNames: [] });
            }
            if (nativeOutcome === 'ack_failed') f.refuseNextPublication();
            if (nativeOutcome === 'input_arrives' && reloads === 1) f.startTurn();
            return nativeOutcome !== 'restart_required' && nativeOutcome !== 'input_arrives' ? { kind: 'applied' } : { kind: 'restart_required', reason: 'launch_path_unsupported' };
          } },
          onApplied: result => { appliedItems = result.delivery?.items ?? null; },
        },
        skillsTransports: { artifacts: { list: async () => ({ items: nativeOutcome === 'applied' ? [{ ...artifact, headerVersion: artifact.revision.headerVersion }] : [], coverage: 'complete' }), read: async () => artifact },
          ensureSessionDir: input => store.ensureSkillSessionDir(input) },
      });
      f.changeSkills({ v: 1, forceIncludeSkillIds: nativeOutcome === 'applied' ? ['library'] : [], forceExcludeSkillIds: nativeOutcome === 'applied' ? [] : ['library'], excludeNativeSkillNames: [] });
      await f.sync.flushAfterSettledTurn(); expect(reloads).toBe(0);
      f.settle(); await f.sync.flushAfterSettledTurn();
      if (nativeOutcome === 'advancing') await expect.poll(() => reloads).toBe(2);
      else expect(reloads).toBe(1);
      if (nativeOutcome === 'input_arrives') {
        expect(appliedItems).toBeNull();
        expect(f.requests).toEqual([]);
        f.settle(); await f.sync.flushAfterSettledTurn('next');
        expect(f.requests).toHaveLength(1);
      } else if (nativeOutcome === 'ack_failed') {
        expect(appliedItems).toEqual([]); expect(f.requests).toEqual([]);
        expect(f.metadata.skillSelectionRestartRequiredV1).toBeDefined();
        expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ skills: { reason: 'apply_failed' } });
        await f.sync.flushAfterSettledTurn(); expect(reloads).toBe(1);
      } else if (nativeOutcome !== 'restart_required') {
        if (nativeOutcome === 'advancing') await expect.poll(() => f.metadata.skillSelectionRestartRequiredV1).toBeUndefined();
        expect(appliedItems).toEqual(nativeOutcome === 'applied' ? [expect.objectContaining({ name: 'sample' })] : []); expect(f.requests).toEqual([]);
        expect(f.metadata.skillSelectionRestartRequiredV1).toBeUndefined();
      } else {
        expect(appliedItems).toBeNull(); expect(f.requests).toHaveLength(1);
        expect(f.metadata.skillSelectionRestartRequiredV1).toBeDefined();
      }
    } finally {
      restoreProjectHttp();
      await store.releaseSkillSessionDirs('session'); await store.collectSkillCache({ libraryDigests: [] });
      await rm(home, { recursive: true, force: true });
    }
  });
  it('coalesces MCP changes during a turn into one forced current-runner restart at settlement', async () => {
    const f = fixture();
    f.change('first'); f.change('second');
    await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([]);
    f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([{ sessionId: 'session', mode: 'force_current_cli', reason: 'capability_selection_change' }]);
    expect(RestartSessionRunnerRequestV1Schema.safeParse(f.requests[0]).success).toBe(true);
    await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(1);
  });

  it('retries a busy answer only at a later settled-turn boundary', async () => {
    const f = fixture([{ ok: false, status: 'busy', sessionId: 'session', reasonCode: 'turn_in_progress' }]);
    f.change('server'); f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(1);
    f.sync.syncFromMetadata(); await Promise.resolve();
    expect(f.requests).toHaveLength(1);
    await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(2);
  });

  it('does not retry busy when two host wake paths report the same settled turn', async () => {
    const f = fixture([{ ok: false, status: 'busy', sessionId: 'session', reasonCode: 'approval_pending' }]);
    f.change('server'); f.settle(); await f.sync.flushAfterSettledTurn('turn-one');
    await f.sync.flushAfterSettledTurn('turn-one');
    expect(f.requests).toHaveLength(1);
    await f.sync.flushAfterSettledTurn('turn-two');
    expect(f.requests).toHaveLength(2);
  });

  it('does not retry a missing resume snapshot and leaves the desired marker intact', async () => {
    const f = fixture([{ ok: false, status: 'missing_resume_snapshot', sessionId: 'session', reasonCode: 'missing_resume_identity' }]);
    f.change('server'); f.settle(); await f.sync.flushAfterSettledTurn();
    await f.sync.flushAfterSettledTurn(); f.sync.syncFromMetadata();
    expect(f.requests).toHaveLength(1);
    expect(f.metadata.mcpSelectionRestartRequiredV1).toBeDefined();
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ mcp: { reason: 'missing_resume_snapshot' } });
  });

  it('preserves pending policy without failing the settled turn when refusal status publication is unavailable', async () => {
    const f = fixture([{ ok: false, status: 'missing_resume_snapshot', sessionId: 'session', reasonCode: 'missing_resume_identity' }]);
    f.change('server'); f.settle(); f.refusePublication();
    await expect(f.sync.flushAfterSettledTurn()).resolves.toBeUndefined();
    await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(1);
    expect(f.metadata.mcpSelectionRestartRequiredV1).toBeDefined();
  });

  it.each(['windows_hosted_runner', 'not_daemon_started', 'not_remote_started'] as const)(
    'keeps %s saved for explicit restart without automatic attempts', async refused => {
      const f = fixture();
      f.patch({ sessionRunnerRuntimeV1: SessionRunnerRuntimeStateV1Schema.parse({
        v: 1, sessionId: 'session', observedAtMs: 1, versionState: 'current', statusSource: 'daemon_tracking',
        runner: { entrypointSource: 'launch_spec', startedBy: refused === 'not_daemon_started' ? 'local' : 'daemon', startingMode: 'remote' },
        daemon: { currentEntrypointSource: 'launch_spec' },
        plannedRestart: { supported: true, eligible: false, disabledReason: refused },
      }) });
      f.change('server'); f.settle(); await f.sync.flushAfterSettledTurn();
      await f.sync.flushAfterSettledTurn(); f.sync.syncFromMetadata();
      expect(f.requests).toEqual([]);
      expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ mcp: {
        reason: 'restart_to_apply', restartBy: refused === 'windows_hosted_runner' ? 'user' : 'terminal',
      } });
      const resumed = resolveSelectionRestartMarkersForStartupV1({ current: f.metadata, applied: {
        mcp: f.metadata.mcpSelectionV1!,
      } });
      expect(resumed.mcpSelectionRestartRequiredV1).toBeUndefined();
      expect(readCapabilitySelectionApplyV1(resumed)).toEqual({});
    });

  it('restarts a native skill toggle even when library skills support live reload', async () => {
    const f = fixture(undefined, { agent: { vendorResume: 'supported', skillsLiveReload: 'supported' },
      skillsRunner: { readInput: () => { throw new Error('native skills must not reapply'); }, runtime: {}, onApplied: () => {} } });
    f.changeSkills({ v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native'] });
    f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(1);
    expect(f.metadata.skillSelectionRestartRequiredV1).toBeDefined();
  });

  it('does not start a fresh conversation for an Agent without resume', async () => {
    const f = fixture(undefined, { agent: { vendorResume: 'unsupported', skillsLiveReload: 'unsupported' } });
    f.change('server'); f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toEqual([]);
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ mcp: { reason: 'new_sessions_only' } });
  });

  it('consumes the exact released 0.2 selection and applied marker patch at the same settled boundary', async () => {
    const f = fixture();
    // ../0.2 cd2bb4d853, UI sessionMcpSelectionPublish.ts: preserved applied baseline + desired policy.
    const appliedSelection = { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] };
    f.patch({ mcpSelectionV1: { ...appliedSelection, forceExcludeServerIds: ['linear'] },
      mcpSelectionRestartRequiredV1: { v: 1, appliedSelection } });
    await f.sync.flushAfterSettledTurn(); expect(f.requests).toEqual([]);
    f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests[0]).toMatchObject({ reason: 'capability_selection_change', mode: 'force_current_cli' });
  });

  it('detects desired policy saved without an active heartbeat marker and keeps refused apply visible after reconnect', async () => {
    const f = fixture([{ ok: false, status: 'missing_resume_snapshot', sessionId: 'session', reasonCode: 'missing_resume_identity' }]);
    f.patch({ mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['offline-edit'] } });
    expect(f.metadata.mcpSelectionRestartRequiredV1).toBeUndefined();
    f.settle(); await f.sync.flushAfterSettledTurn();
    expect(f.requests).toHaveLength(1);
    expect(readCapabilitySelectionApplyV1(f.metadata)).toEqual({ mcp: { reason: 'missing_resume_snapshot' } });
    expect(f.metadata.mcpSelectionRestartRequiredV1?.appliedSelection.forceExcludeServerIds).toEqual([]);
  });
});
