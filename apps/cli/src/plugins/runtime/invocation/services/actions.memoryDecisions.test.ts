import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { CoordinationMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { MemoryActionInputSchemasV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { createMemoryDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { memoryDecisionAuthoringFixture, memoryDecisionUiAuthoringFixture } from '../../../../../../../packages/plugin-sdk/fixtures/authoring-inference/actions';
import { createPluginInvocationActionsService } from './actions';

describe('external Memory author workflow through both SDK transports', () => {
  it.each(['daemon', 'ui'] as const)('%s saves, reads and corrects with strict provenance and cancellation', async transport => {
    const sourceMessageRef = CoordinationMessageRefV1Schema.parse({ kind: 'session',
      session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' });
    const rows = new Map<string, PromptLibraryStoredArtifact>();
    let sequence = 0;
    let writes = 0;
    let current = true;
    let sourceReadable = true;
    let onRead: ((signal?: AbortSignal) => Promise<void>) | undefined;
    // Artifact persistence is the genuine external boundary. Parsing, admission,
    // duplicate review, history, schemas and both SDK adapters remain real.
    const store: PromptLibraryArtifactStore = {
      read: async (id, options) => { await onRead?.(options?.signal); return rows.get(id) ?? null; },
      create: async input => {
        const artifactId = `memory-${++sequence}`;
        rows.set(artifactId, { id: artifactId, header: input.header, body: input.body,
          revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner' });
        return { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } };
      },
      update: async input => {
        input.signal?.throwIfAborted();
        if (input.memoryDecisionSource && !sourceReadable) throw Object.assign(new Error('source unavailable'), { code: 'memory_decision_source_unavailable' });
        const before = rows.get(input.artifactId)!;
        if (before.revision.headerVersion !== input.expectedRevision.headerVersion || before.revision.bodyVersion !== input.expectedRevision.bodyVersion)
          throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
        writes++;
        const revision = { headerVersion: before.revision.headerVersion + 1, bodyVersion: before.revision.bodyVersion + 1 };
        rows.set(input.artifactId, { ...before, header: input.header, body: input.body, revision });
        return { revision };
      },
    };
    const created = await createMemoryDocInLibrary({ store, request: { title: 'Memory', text: 'Seed note' },
      randomId: () => `fact-${++sequence}`, nowMs: () => 10, sourceSessionRef: null });
    const ref = { kind: 'doc' as const, artifactId: created.artifactId, serverId: 'home' };
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"memory.decision.save": Object.keys(ActionSurfaceSchema.shape), "memory.read": Object.keys(ActionSurfaceSchema.shape), "memory.update": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      memoryLibrary: { serverId: 'home', store, randomId: () => `fact-${++sequence}`, nowMs: () => 20,
        readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] },
          publicShares: { publicShares: [] } }) } });
    const service = createPluginInvocationActionsService({ seed: { plugin: { id: 'com.acme.memory', version: '1.0.0' },
      occurrenceId: 'memory-fixture', sourceCustody: { kind: 'development', registeredRootId: 'memory-root' },
      contribution: { id: 'save', qualifiedId: 'com.acme.memory/actions/save' }, surface: 'plugin',
      signal: new AbortController().signal, isOccurrenceCurrent: () => current }, actionExecutor: executor,
      invokeContributedAction: async () => { throw new Error('No contributed Actions in this fixture'); } });
    const ui = transport === 'ui' ? await createPluginUiTestkit({
      identity: { instanceId: 'memory-surface', mountNonce: 'memory-nonce' },
      authorPlugin: { id: 'com.acme.memory', version: '1.0.0' }, surface: null,
      surfaceContext: createSurfaceContextFixture(),
      adapter: { mount: async () => ({ snapshot: async () => ({ revision: 1, nodes: [] }),
        update: async () => {}, invoke: async () => {}, dispose: async () => {} }) },
      handlers: { executeAction: async ({ action, input, signal }) => {
        if (action !== 'memory.decision.save' && action !== 'memory.read' && action !== 'memory.update') throw new Error('Unexpected fixture Action');
        return StrictJsonValueSchema.parse(await service.execute(action, MemoryActionInputSchemasV1[action].parse(input), { signal }));
      } },
    }) : null;
    const execute = (action: 'memory.decision.save' | 'memory.read', value: unknown, options?: { signal?: AbortSignal }) => {
      // Adversarial JSON enters at the external transport boundary; the real host schemas decide admission.
      return ui ? ui.context.hostApi.executeAction(action, value as never, options) : service.execute(action, value as never, options);
    };
    const input = { ref, expectedRevision: rows.get(ref.artifactId)!.revision, text: 'Use PostgreSQL',
      reason: 'Transactional storage', sourceMessageRef };
    try {
      const result = ui ? await memoryDecisionUiAuthoringFixture(ui.context.hostApi, input, {})
        : await memoryDecisionAuthoringFixture(service, input, {});
      expect(result).toMatchObject({ saved: { ok: true }, corrected: { ok: true } });
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(rows.get(ref.artifactId)!.body!));
      const corrected = body.index.find(fact => fact.text === 'Use PostgreSQL after review');
      expect(corrected?.decision).toMatchObject({ reason: input.reason, sourceMessageRef, approvedBy: null });
      expect(body.topics.find(topic => topic.title === 'archive')?.facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: input.text, decision: expect.objectContaining({ approvedBy: null }) }),
      ]));
      const before = rows.get(ref.artifactId);
      const request = { ...input, text: 'Independent choice', expectedRevision: before!.revision };
      await expect(execute('memory.decision.save', { ...request, approvedBy: { accountId: 'forged', atMs: 1 } } as never))
        .rejects.toBeDefined();
      sourceReadable = false;
      await expect(execute('memory.decision.save', request)).rejects.toMatchObject({ code: 'memory_decision_source_unavailable' });
      expect(rows.get(ref.artifactId)).toBe(before);
      sourceReadable = true;
      let observedRead!: () => void;
      const reading = new Promise<void>(resolve => { observedRead = resolve; });
      onRead = signal => { observedRead(); return new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }); };
      const controller = new AbortController();
      const pending = execute('memory.decision.save', request, { signal: controller.signal });
      const rejected = expect(pending).rejects.toBeDefined();
      await reading;
      controller.abort();
      await rejected;
      expect(rows.get(ref.artifactId)).toBe(before);
      expect(writes).toBe(2);
      onRead = undefined;
      current = false;
      await expect(execute('memory.read', { ref })).rejects.toBeDefined();
    } finally { await ui?.dispose(); }
  });
});
