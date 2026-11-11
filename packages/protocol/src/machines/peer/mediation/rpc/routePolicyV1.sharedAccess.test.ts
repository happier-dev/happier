import { expect, it } from 'vitest';

import { MACHINE_RPC_ROUTE_POLICIES, resolveMachineRpcRoutePolicy } from './routePolicyV1.js';

// Owner-approved route corridor changes, compared with HEAD a207bc7a89a7.
// These expectations pin admission roles independently of the declaration refactor.
it.each([
  ['daemon.agents.install.start', 'manage'],
  ['daemon.agents.install.cancel', 'manage'],
  // O-MACH 2026-11-08: Manage means full Machine control, including plugin installers.
  ['action.invoke', 'manage'],
  ['daemon.plugins.npmRegistries.get', 'manage'],
  ['machines.guard.activity.undo', 'manage'],
  ['machines.guard.idleStop.keepRunning', 'use'],
  ['machines.guard.sessionCeiling.set', 'manage'],
  ['machines.resources.policy.set', 'manage'],
  ['daemon.localServices.actions.execute', 'manage'],
  ['daemon.machines.liveStream.relay.start', 'manage'],
  // O-MACH SEC 1108F O1: the no-op receipt shares openPreview's Use admission.
  ['daemon.localServices.actions.copyUrl', 'use'],
  ['daemon.localServices.actions.terminateDetected', 'manage'],
  ['daemon.workspaceSync.flush.v1', 'use'],
  ['daemon.browser.view.watch', 'use'],
  ['daemon.workspaceSync.pause.v1', 'use'],
  ['daemon.workspaceSync.resume.v1', 'use'],
  ['daemon.workspaceSync.terminate.v1', 'use'],
  ['daemon.workspaceSync.relationship.create.v1', 'use'],
  ['daemon.workspaceSync.conflict.resolve.v1', 'use'],
  ['daemon.workspaceSync.target.replacement.preflight.v1', 'manage'],
  ['daemon.workspaceSync.get.v1', 'use'],
  ['daemon.workspaceSync.list.v1', 'use'],
  ['daemon.workspaceSync.watch.v1', 'use'],
  ['daemon.workspaceSync.conflicts.list.v1', 'use'],
  ['daemon.workspaceSync.file.read.v1', 'use'],
  ['daemon.workspaceSync.relationships.list.v1', 'use'],
  ['daemon.workspaceSync.relationship.creation.observe.v1', 'use'],
  ['daemon.workspaceSync.conflict.inspect.v1', 'use'],
  ['bash', 'manage'],
  ['daemon.voiceInference.stt.stream.status', 'use'],
  ['session-compact', 'use'],
  ['ui.actions.child.execute.v1', 'use'],
  ['workflow.run.start', 'use'],
  ['daemon.deployments.child.v1', 'manage'],
  ['machines.managed.birth.get', 'manage'],
  ['machines.setup.adminAccess.inspect', 'use'],
  ['machines.reachability.configure', 'manage'],
  ['machines.setup.adminAccess.set', 'manage'],
  ['machines.command.run', 'manage'],
  ['machines.services.exec', 'manage'],
  ['machines.services.control', 'manage'],
  ['machines.services.list', 'use'],
  ['machines.services.discovery', 'use'],
  ['machines.services.detail', 'use'],
  ['machines.services.watch', 'manage'],
  ['machines.services.adopt', 'manage'],
  ['machines.services.unwatch', 'manage'],
  ['machines.reboot', 'manage'],
  ['machines.agentIsolation.status', 'use'],
  ['machines.agentIsolation.preview', 'manage'],
  ['machines.agentIsolation.set', 'manage'],
  ['machines.services.logs.read', 'use'],
  ['daemon.computer.personal.actions.execute', 'use'],
  ['daemon.machines.liveStream.source.admit', 'use'],
  ['daemon.machines.liveStream.personal.relay.start', 'use'],
] as const)('declares the approved shared Machine access for %s as %s', (method, role) => {
  expect(MACHINE_RPC_ROUTE_POLICIES.find(policy => policy.method === method)).toBeDefined();
  expect(resolveMachineRpcRoutePolicy(method).sharedMachineAccess).toBe(role);
});
