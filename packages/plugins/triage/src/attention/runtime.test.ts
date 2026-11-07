import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_PLUGIN } from '../manifest.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';

type Notice = Parameters<PluginInvocationContext['services']['notifications']['send']>[0];

describe('registered Triage attention producer', () => {
  it('uses provider cadence, stable notice identity across invocations, exact detail, and never resolves on failure', async () => {
    vi.useFakeTimers();
    const fixture = createTriageSourceV1Fixture();
    const { control, watchableCollections } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue({
      instanceTag: `a${'0'.repeat(42)}`, sourceQualifiedId: 'happier.example.source/example-forge',
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: fixture.configuredInstance,
    }));
    const notices: Notice[] = [];
    let reads = 0;
    let terminal = false;
    let failed = false;
    const kit = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN });
    const run = async () => {
      const controller = new AbortController();
      // Host admission/transport and persistent storage are the substituted boundaries.
      const context = { signal: controller.signal, surface: 'background',
        plugin: { id: 'happier.triage', version: '0.0.0' },
        services: {
          storage: { account: { collection: () => watchableCollections.sourceInstances } },
          targetedContributions: { observeForSelf: () => ({
            readCurrent: async () => ({ contributions: [{ descriptor: fixture.descriptor,
              contributor: { pluginId: fixture.configuredInstance.instance.source.pluginId,
                contributionId: fixture.configuredInstance.instance.source.localId },
              operations: { readAttention: { role: 'readAttention' } },
            }] }), dispose() {},
          }) },
          actions: { executeAdmittedTargetedOperation: async () => {
            reads += 1;
            return failed ? { kind: 'failed', failure: { class: 'transient', code: 'source_offline' } }
              : { kind: 'page', items: [{ localRef: fixture.getInput.localRef, reason: 'reviewRequested',
                type: 'decision', title: 'Review this pull request', resolved: terminal }], nextPage: false, pollIntervalMs: 90_000 };
          } },
          notifications: { send: async (notice: Notice) => { notices.push(notice); return { deliveries: [], replayed: false }; } },
          logger: { warn() {} },
        },
      } as unknown as BackgroundServiceContext;
      const runner = kit.registration('backgroundServices', 'attention');
      expect(runner).toBeTypeOf('function');
      if (!runner) throw new Error('Attention producer must be registered');
      const running = runner(context);
      await vi.advanceTimersByTimeAsync(0);
      return { controller, running };
    };
    let active: Awaited<ReturnType<typeof run>> | undefined;
    try {
      active = await run();
      expect(reads).toBe(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: 'decision', resolved: false,
        page: { pageId: 'triage', subPath: buildTriageEntryRouteSegmentV1(fixture.detailInput.observation.entryRef) } });
      await vi.advanceTimersByTimeAsync(89_999);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(2);
      active.controller.abort(); await active.running;
      active = await run();
      expect(notices.at(-1)?.itemId).toBe(notices[0]?.itemId);
      expect(notices.at(-1)?.clientRequestId).not.toBe(notices[0]?.clientRequestId);
      failed = true;
      await vi.advanceTimersByTimeAsync(90_000);
      const before = notices.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(notices).toHaveLength(before);
      expect(notices.every(notice => notice.resolved === false)).toBe(true);
      active.controller.abort(); await active.running;
      failed = false; terminal = true;
      active = await run();
      expect(notices.at(-1)).toMatchObject({ itemId: notices[0]?.itemId, resolved: true });
      active.controller.abort(); await active.running;
      const stoppedReads = reads;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(reads).toBe(stoppedReads);
    } finally {
      active?.controller.abort(); await active?.running;
      await kit.dispose(); vi.useRealTimers();
    }
  });
});
