import { describe, expect, it } from 'vitest';
import { getSerializedActionSpecForSurface } from './actionCatalog.js';
import type { ActionId } from './actionIds.js';

const operands = [
  ['workflow.validate', ['definition', 'inputs', 'target']],
  ['workflow.run.list', ['runId', 'runIds', 'sourceArtifactId', 'originSessionId', 'targetSessionId', 'cursor']],
  ['workflow.run.summaries', ['sourceArtifactIds', 'recent', 'automationIds']],
  ['workflow.run.get', ['runId', 'includeUsage']],
  ['workflow.run.read_state.set', ['runId', 'revision', 'failedAt']],
  ['workflow.run.wait', ['runId', 'conditions', 'timeoutSeconds']],
  ['workflow.run.pause', ['runId', 'expectedRevision']],
  ['workflow.run.resume', ['runId', 'expectedRevision', 'mode']],
  ['workflow.run.cancel', ['runId', 'expectedRevision']],
  ['workflow.run.delete', ['runId', 'expectedRevision']],
  ['workflow.run.invocations.list', ['runId', 'parentRecordId', 'parentRecordIds', 'invocationId', 'memberOrdinal', 'includeContent']],
  ['workflow.run.invocations.get', ['runId', 'invocationId']],
  ['workflow.run.invocations.retry', ['runId', 'invocation', 'expectedRevision', 'causalInvocationIds', 'conversation', 'input']],
  ['workflow.run.invocations.publish_draft', ['runId', 'invocation', 'expectedContentRevision', 'value']],
  ['workflow.run.invocations.complete_review', ['runId', 'invocation', 'expectedContentRevision', 'mode', 'value', 'followUp']],
  ['workflow.definition.create', ['definitionId', 'definition', 'metadata']],
  ['workflow.definition.update', ['definitionId', 'expectedRevision', 'definition', 'metadata']],
  ['workflow.definition.edit', ['definitionId', 'expectedRevision', 'ops']],
  ['workflow.definition.delete', ['definitionId']],
  ['workflow.definition.import', ['json']],
  ['workflow.definition.export', ['definitionId', 'draft']],
  ['workflow.definition.capture', ['discussion', 'messageIds', 'choices']],
  ['workflow.trigger.remove', ['automationId', 'triggerId']],
  ['workflow.trigger.run_now', ['automationId', 'idempotencyKey']],
  ['settings.invoke', ['input']],
  ['machines.processes.list', ['scope', 'view', 'sessionId', 'query']],
  ['machines.processes.get', ['ref']],
  ['machines.processes.check', ['refs']],
  ['machines.processes.stop', ['targets']],
  ['machines.processes.kill', ['targets', 'tree']],
  ['machines.processes.startAgain', ['ref']],
  ['machines.processes.leftBehind.cleanUp', ['refs']],
  ['machines.storage.pile.set', ['add', 'remove', 'clear', 'acknowledgeDropped']],
  ['machines.storage.items.check', ['refs']],
  ['machines.storage.trash.move', ['items', 'notIncluded', 'goalBytes', 'emptyAfter', 'retry']],
  ['machines.storage.deleteNow', ['items']],
  ['machines.storage.trash.empty', ['volume', 'entryIds', 'batchId']],
  ['machines.storage.trash.restore', ['entryIds', 'batchId', 'beside']],
  ['machines.storage.worktrees.list', ['projectId', 'filter']],
  ['machines.storage.suggestions.list', ['group', 'quickestForVolume']],
  ['machines.storage.suggestions.decline', ['items']],
  ['machines.storage.scan.start', ['target', 'resume']],
  ['machines.storage.scan.get', ['scanId', 'view']],
  ['machines.storage.scan.cancel', ['scanId']],
  ['machines.storage.scan.skip', ['scanId', 'path']],
  ['machines.storage.protected.add', ['path']],
  ['machines.storage.protected.remove', ['path']],
  ['machines.cli.update', ['target']],
  ['updates.batch.start', ['groupId', 'itemIds']],
  ['plugins.scaffold', ['targetDir', 'id', 'name', 'machineId', 'ui', 'template']],
  ['plugins.uninstall', ['pluginId', 'machineId', 'managedResourceDispositions', 'deleteData']],
  ['plugins.enable', ['pluginId', 'machineId']],
  ['plugins.disable', ['pluginId', 'machineId', 'managedResourceDispositions']],
  ['plugins.rollback', ['pluginId', 'machineId']],
  ['plugins.trust.forget', ['pluginId', 'machineId']],
  ['plugins.update_policy.set', ['pluginId', 'machineId', 'policy']],
  ['plugins.dev.submit', ['projectRoot', 'sdkRegistryOrigin']],
  ['plugins.dev.unregister', ['projectRoot']],
  ['plugins.dev.install', ['projectRoot', 'sdkRegistryOrigin']],
  ['plugins.dev.typecheck', ['projectRoot', 'sdkRegistryOrigin']],
  ['plugins.dev.build', ['projectRoot', 'sdkRegistryOrigin']],
  ['plugins.dev.test', ['projectRoot', 'sdkRegistryOrigin']],
  ['plugins.doctor', ['locator']],
  ['plugins.pack', ['locator', 'outPath', 'sdkRegistryOrigin']],
  ['plugins.reload', ['pluginId']],
  ['plugins.change.status', ['pendingChangeId']],
  ['registries.sources.list', ['kind']],
  ['registries.items.list', ['kind', 'sourceIds', 'contributionFamily', 'query', 'cursor', 'refresh']],
  ['registries.items.read', ['kind', 'sourceId', 'itemId', 'version']],
  ['registries.updates.check', ['kind', 'keys', 'environments']],
  ['plugins.settings.list', ['pluginId', 'scope', 'target']],
  ['plugins.settings.get', ['pluginId', 'scope', 'target', 'localId', 'bindingServerIdentityId']],
  ['plugins.settings.set', ['pluginId', 'scope', 'target', 'localId', 'bindingServerIdentityId', 'value', 'expectedRevision']],
  ['plugins.settings.reset', ['pluginId', 'scope', 'target', 'localId', 'expectedRevision']],
  ['plugins.settings.secret.status', ['pluginId', 'localId', 'scope', 'target', 'secretDaemonTarget', 'canonicalOrigin']],
  ['plugins.settings.secret.bind', ['pluginId', 'localId', 'savedSecretId', 'expectedRevision']],
  ['plugins.settings.secret.unbind', ['pluginId', 'localId', 'expectedRevision']],
  ['plugins.settings.secret.delete', ['pluginId', 'localId', 'expectedRevision']],
  ['plugins.permissions.grants.list', ['pluginId', 'grantId', 'capability', 'targetScope', 'subject', 'includeRevoked', 'includeResolvedRequests', 'limit']],
  ['plugins.permissions.grants.revoke', ['grantId', 'reason']],
  ['plugins.sessionHooks.status.get', ['intent', 'agent', 'cursor', 'limit', 'installationId']],
  ['plugins.sessionHooks.install', ['agent', 'expectedPreviewId']],
  ['plugins.sessionHooks.disable', ['agent', 'installationId']],
  ['plugins.sessionHooks.enable', ['agent', 'installationId']],
  ['plugins.sessionHooks.uninstall', ['agent', 'installationId']],
] as const satisfies readonly (readonly [ActionId, readonly string[]])[];

describe('UI operation operands in public Action discovery', () => {
  it.each(operands)('elicits the declared operands for %s on Agent, MCP and CLI', (id, paths) => {
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      const definition = getSerializedActionSpecForSurface({ id, surface });
      if (id === 'plugins.permissions.grants.revoke' && surface === 'cli') {
        // Self-revocation needs the mounted plugin caller's host-stamped provenance.
        expect(definition).toBeNull();
        continue;
      }
      expect(definition, `${surface}: ${id}`).not.toBeNull();
      expect(definition?.inputHints?.fields.map(field => field.path), `${surface}: ${id}`)
        .toEqual(expect.arrayContaining([...paths]));
    }
  });
});
