import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('generated external Action clients accept shared targets without widening exact native recipients', t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'session-target-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, 'consumer.ts'), `
    import type { PluginActionInputById, PluginActionResultById, ActionSpec, PluginActionContributionV2 }
      from '${resolve('packages/plugin-sdk/src/actions/actionTypeMap.generated.js')}';
    import type { SessionTargetV1 } from '${resolve('packages/plugin-sdk/src/actions/dtos/pluginActionDtoSupport.generated.js')}';
    const workers: SessionTargetV1 = { selector: 'workers', of: 'manager', recursive: true };
    declare const genericTarget: SessionTargetV1;
    const genericSend: PluginActionInputById['session.message.send'] = {
      sessionId: genericTarget, message: 'Review the change', idempotencyKey: 'generic-request',
    };
    const send: PluginActionInputById['session.message.send'] = {
      sessionId: workers, message: 'Review the change', idempotencyKey: 'source-request',
    };
    const status: PluginActionInputById['session.status.get'] = { sessionId: { selector: 'manager' } };
    const stop: PluginActionInputById['session.stop'] = { sessionId: workers };
    const cancel: PluginActionInputById['session.turn.cancel'] = { sessionId: workers };
    const recent: PluginActionInputById['session.messages.recent.get'] = { sessionId: workers };
    const archive: PluginActionInputById['session.archive'] = { sessionId: { selector: 'self' } };
    const goal: PluginActionInputById['session.goal.set'] = { sessionId: { selector: 'manager' }, objective: 'Ship the fix' };
    const manager: PluginActionInputById['session.manager.set'] = {
      sessionId: { selector: 'self' }, managerSessionId: 'new-manager', expectedManagerSessionId: null,
    };
    const coordinator: PluginActionInputById['session.coordinator.enable'] = {
      sessionId: { selector: 'self' }, roleId: 'orchestrator', keep: 'none', ruleSuggestions: [],
    };
    const handoff: PluginActionInputById['session.handoff'] = { sessionId: { selector: 'self' } };
    const roleSet: PluginActionInputById['session.role.set'] = { sessionId: genericTarget, roleId: 'orchestrator' };
    const roleOverride: PluginActionInputById['session.roles.override.set'] = { sessionId: workers, roleId: 'orchestrator', workspaceWrites: 'deny' };
    const roleOverrideClear: PluginActionInputById['session.roles.override.clear'] = { sessionId: workers, roleId: 'orchestrator' };
    const roleAdd: PluginActionInputById['session.roles.add'] = { sessionId: workers, roleId: 'scout', role: {
      name: 'Scout', instructions: 'Read and report.', runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true,
    } };
    const roleRemove: PluginActionInputById['session.roles.remove'] = { sessionId: workers, roleId: 'scout' };
    const notes: PluginActionInputById['session.notes.set'] = { sessionId: { selector: 'manager' }, notes: 'Verify before reporting.' };
    const applyRoles: PluginActionInputById['session.roles.apply_to_reports'] = { sessionId: { selector: 'self' } };
    // @ts-expect-error Role identity is not a Session selector.
    const invalidRole: PluginActionInputById['session.roles.remove'] = { sessionId: workers, roleId: workers };
    // @ts-expect-error The manager CAS witness remains an exact identity, not an operational selector.
    const invalidManager: PluginActionInputById['session.manager.set'] = { sessionId: workers, managerSessionId: null, expectedManagerSessionId: workers };
    const inspect: PluginActionInputById['session.targets.resolve'] = {
      actionId: 'session.message.send', target: workers,
    };
    const inspectContributed: PluginActionInputById['session.targets.resolve'] = {
      actionId: 'com.example.worker/actions/inspect', target: workers,
    };
    const inspected: PluginActionResultById['session.targets.resolve'] = {
      coverage: 'complete', addresses: [{ serverId: 'home', sessionId: 'worker-a' }], error: null,
    };
    // @ts-expect-error Target inspection keeps the shared closed selector contract.
    const invalidInspect: PluginActionInputById['session.targets.resolve'] = { actionId: 'session.message.send', target: { selector: 'workers', widenAuthority: true } };
    const open: PluginActionInputById['session.open'] = {
      sessionId: { selector: 'self' },
      destination: { kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'commits' },
    };
    const oldSend: PluginActionInputById['session.message.send'] = {
      sessionId: 'old-id', message: 'Review the change', idempotencyKey: 'old-request',
    };
    declare const spec: ActionSpec;
    type InboxData = Extract<PluginActionResultById['inbox.get'], { status: 'ready' | 'partial' }>;
    declare const inboxResult: PluginActionResultById['inbox.get'];
    function narrowInbox(result: typeof inboxResult): InboxData | null {
      return result.status === 'ready' || result.status === 'partial' ? result : null;
    }
    declare const inbox: InboxData;
    const readyInbox: InboxData = { ...inbox, status: 'ready' };
    const partialInbox: InboxData = { ...inbox, status: 'partial', coverage: {
      discussions: 'unavailable', sources: [
        { source: 'notices', status: 'complete' },
        { source: 'live_items', status: 'unavailable', reason: 'requires_app_projection' },
        { source: 'action_operations', status: 'unavailable', reason: 'device_local' },
      ],
    } };
    const inboxType: 'decision' | 'approval' | 'blocked' | 'update' | 'mention' = inbox.items[0].type;
    const inboxView: 'needs_you' | 'updates' | 'mentions' = inbox.items[0].view;
    const inboxRead: boolean = inbox.items[0].read;
    const inboxPage: string = inbox.items[0].pageRoute;
    const inboxSource: { kind: string; id: string; serverId: string } = inbox.items[0].source;
    const inboxCoverage: 'complete' | 'partial' | 'unavailable' = inbox.coverage.discussions;
    const sourceCoverage: 'complete' | 'partial' | 'unavailable' | undefined = partialInbox.coverage.sources?.[0].status;
    const proposal = inbox.items[0].discussion;
    if (proposal) {
      const committed: { kind: 'discussion'; messageId: string; discussion: { serverId: string; discussionId: string } } = proposal.messageRef;
      const disposition: 'open' | 'accepted' | 'declined' | undefined = proposal.proposalDisposition?.state;
      void committed; void disposition;
    }
    // @ts-expect-error The canonical read does not invent a second request classification.
    const invalidInboxType: typeof inboxType = 'question';
    const declaration: { field: string; cardinality: 'one' | 'many' } | undefined = spec.sessionTarget;
    declare const contributed: PluginActionContributionV2;
    const contributedDeclaration: typeof declaration = contributed.sessionTarget;
    const fanout: PluginActionResultById['session.message.send'] = { kind: 'fanout', results: [{
      target: { serverId: 'home', sessionId: 'worker-a' },
      result: { ok: true, result: { status: 'accepted', localId: 'input-a' } },
    }] };
    // @ts-expect-error Fanout keeps the canonical send outcome at every successful leaf.
    const invalidFanout: PluginActionResultById['session.message.send'] = { kind: 'fanout', results: [{ target: { serverId: 'home', sessionId: 'worker-a' }, result: { ok: true, result: { status: 'invented' } } }] };
    // @ts-expect-error The base of a selector remains an exact Session reference.
    const nested: SessionTargetV1 = { selector: 'manager', of: { selector: 'self' } };
    // @ts-expect-error Unknown routing intent does not cross the external declaration boundary.
    const unknown: SessionTargetV1 = { selector: 'workers', widenAuthority: true };
    // @ts-expect-error An inside-Session recipient cannot become a Session selector.
    const wrongRecipient: PluginActionInputById['session.message.send'] = { sessionId: workers, message: 'Review', idempotencyKey: 'wrong', recipient: { selector: 'manager' } };
    void send; void genericSend; void status; void inspect; void inspectContributed; void inspected; void invalidInspect; void open; void oldSend; void declaration; void contributedDeclaration; void fanout; void invalidFanout;
    void stop; void cancel; void recent; void archive; void goal; void manager; void coordinator; void handoff; void invalidManager;
    void roleSet; void roleOverride; void roleOverrideClear; void roleAdd; void roleRemove; void notes; void applyRoles; void invalidRole;
    void nested; void unknown; void wrongRecipient;
    void inboxType; void inboxView; void inboxRead; void inboxPage; void inboxSource; void inboxCoverage; void invalidInboxType;
    void narrowInbox; void readyInbox; void partialInbox; void sourceCoverage;
  `);
  // Attribute compiler admission to the SDK package that owns this fixture.
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: resolve('packages/plugin-sdk') });
  const compiled = spawnSync(invocation.command, [...invocation.argsPrefix, '--ignoreConfig', '--strict', '--skipLibCheck',
    '--noEmit', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node',
    resolve(root, 'consumer.ts')], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});
