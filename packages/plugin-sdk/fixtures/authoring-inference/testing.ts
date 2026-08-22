import {
  createAgentSessionRuntimeHarness,
  createPluginTestkit,
  type PluginTestServicesFixture,
} from '@happier-dev/plugin-sdk/testing';
import { definePlugin } from '../../src/definePlugin.js';
import type { PluginRegistrationValueByFamily } from '../../src/registration/valueByFamily.js';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { activate, manifest, voiceRuntime } from './index.js';
import { promptAssetAdapter } from './promptAsset.js';

const services = {
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    diagnostic() {},
  },
} satisfies PluginTestServicesFixture;

const actionOnlyManifest = {
  ...manifest,
  contributes: { actions: manifest.contributes.actions },
};

const sessionFactory: AgentRuntimeFactory = () => Object.freeze({
  sessions: Object.freeze({ open: async () => { throw new Error('not invoked'); } }),
});
const executionFactory: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: Object.freeze({ open: async () => { throw new Error('not invoked'); } }),
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      typeof error === 'object' && error !== null && 'code' in error && error.code === code,
      `expected error code ${code}`,
    );
    return;
  }
  throw new Error(`expected error code ${code}`);
}

function expectDefinitionFailure(create: () => unknown, pattern: RegExp): void {
  try {
    create();
  } catch (error) {
    assert(error instanceof Error && pattern.test(error.message), `expected definition failure ${pattern}`);
    return;
  }
  throw new Error(`expected definition failure ${pattern}`);
}

export async function exerciseTestkit(): Promise<void> {
  expectDefinitionFailure(() => definePlugin({
    id: 'example.missing-session-runner',
    version: '0.1.0',
    agents: {
      assistant: {
        declaration: {
          title: 'Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        },
        factory: sessionFactory,
      },
    },
  }), /distinct named runner leaf/u);

  // A hand-written `surfaces: ['externalSessions']` literal is now rejected by
  // the compiler, so this proves the other half of the same rule: a capability
  // list a JavaScript author — or any runtime projection — hands to
  // `definePlugin` carries no literal for the compiler to read, and the runtime
  // guard is what refuses the missing contribution.
  const projectedSurfaces: ('terminal' | 'externalSessions')[] = ['externalSessions'];
  expectDefinitionFailure(() => definePlugin({
    id: 'example.missing-external-sessions',
    version: '0.1.0',
    agents: {
      assistant: {
        declaration: {
          title: 'Assistant', runtime: { kind: 'custom' }, primary: 'executionRuns',
          capabilities: {
            executionRuns: { open: ['create'], checkpoint: false, stop: true },
            surfaces: projectedSurfaces,
          },
          surfaces: {
            externalSession: {
              sources: [{
                sourceKind: 'fixture',
                schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
                key: { segments: [{ kind: 'literal', value: 'fixture' }] },
              }],
            },
          },
        },
        factory: executionFactory,
      },
    },
  }), /requires an External Sessions contribution/u);

  const testkit = await createPluginTestkit({
    manifest,
    module: { activate },
    services,
  });
  try {
    const action: PluginRegistrationValueByFamily['actions'] | undefined =
      testkit.registration('actions', 'echo');
    if (!action) throw new Error('action registration missing');
    const promptAsset: PluginRegistrationValueByFamily['promptAssets'] | undefined =
      testkit.registration('promptAssets', 'external-skills');
    assert(
      promptAsset !== undefined
        && promptAsset !== promptAssetAdapter
        && Object.isFrozen(promptAsset)
        && Object.isFrozen(promptAsset.descriptor)
        && promptAsset.descriptor.id === promptAssetAdapter.descriptor.id,
      'Prompt Asset registration did not expose a frozen registration-time adapter snapshot',
    );
    const registeredVoiceRuntime: PluginRegistrationValueByFamily['voiceProviders'] | undefined =
      testkit.registration('voiceProviders', 'speech');
    assert(
      registeredVoiceRuntime !== undefined
        && registeredVoiceRuntime !== voiceRuntime
        && Object.isFrozen(registeredVoiceRuntime)
        && registeredVoiceRuntime.kind === 'speech'
        && typeof registeredVoiceRuntime.synthesize === 'function',
      'Voice Provider registration did not expose a frozen registration-time runtime snapshot',
    );
    await promptAsset.discover({} as never);
    await promptAsset.read({} as never);
    await promptAsset.writeDoc({} as never);
    await promptAsset.writeBundle({} as never);
    await promptAsset.delete({} as never);
    const result = await testkit.invokeAction('echo', { text: 'hello' });
    assert(
      typeof result === 'object' && result !== null && 'echoed' in result && result.echoed === 'hello',
      'action result was not validated',
    );
  } finally {
    await testkit.dispose();
  }

  await expectErrorCode(testkit.invokeAction('echo', { text: 'after-dispose' }), 'plugin_testkit_disposed');

  const missingService = await createPluginTestkit({
    manifest: actionOnlyManifest,
    module: {
      activate(api) {
        api.actions.register('echo', async (_input, context) => {
          await context.services.fs.readFile({ root: 'workspace', relativePath: 'README.md' });
        });
      },
    },
  });
  await expectErrorCode(
    missingService.invokeAction('echo', { text: 'missing-service' }),
    'plugin_test_service_unavailable',
  );
  await missingService.dispose();

  const cancellation = await createPluginTestkit({
    manifest: actionOnlyManifest,
    module: {
      activate(api) {
        api.actions.register('echo', async (_input, context) => {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          });
        });
      },
    },
  });
  const caller = new AbortController();
  const callerCancelled = cancellation.invokeAction('echo', { text: 'wait' }, { signal: caller.signal });
  await Promise.resolve();
  caller.abort(new Error('fixture caller stopped'));
  await expectErrorCode(callerCancelled, 'plugin_action_aborted');

  const disposedInvocation = cancellation.invokeAction('echo', { text: 'dispose' });
  await Promise.resolve();
  await cancellation.dispose();
  await expectErrorCode(disposedInvocation, 'plugin_action_generation_retired');

  let activationFailed = false;
  try {
    await createPluginTestkit({
      manifest: actionOnlyManifest,
      module: { activate() { throw new Error('fixture activation failed'); } },
    });
  } catch (error) {
    activationFailed = error instanceof Error && error.message === 'fixture activation failed';
  }
  assert(activationFailed, 'activation failure did not escape the testkit');

  let successfulCleanupCalls = 0;
  const successfulCleanup = await createPluginTestkit({
    manifest: actionOnlyManifest,
    module: {
      activate(api) {
        api.actions.register('echo', async () => undefined);
        return () => { successfulCleanupCalls += 1; };
      },
    },
  });
  await successfulCleanup.dispose();
  await successfulCleanup.dispose();
  assert(successfulCleanupCalls === 1, 'successful cleanup did not run exactly once');

  let failedActivationCleanupCalls = 0;
  let activationCleanupFailed = false;
  try {
    await createPluginTestkit({
      manifest: actionOnlyManifest,
      module: {
        activate() {
          return () => { failedActivationCleanupCalls += 1; };
        },
      },
    });
  } catch (error) {
    activationCleanupFailed = error instanceof Error && /missing registration/u.test(error.message);
  }
  assert(activationCleanupFailed, 'registration failure did not escape activation');
  assert(failedActivationCleanupCalls === 1, 'failed activation cleanup did not run exactly once');

  let cleanupFailureCalls = 0;
  const cleanupFailure = await createPluginTestkit({
    manifest: actionOnlyManifest,
    module: {
      activate(api) {
        api.actions.register('echo', async () => undefined);
        return () => {
          cleanupFailureCalls += 1;
          throw new Error('fixture cleanup failed');
        };
      },
    },
  });
  let cleanupFailed = false;
  try {
    await cleanupFailure.dispose();
  } catch (error) {
    cleanupFailed = error instanceof Error && error.message === 'fixture cleanup failed';
  }
  assert(cleanupFailed, 'cleanup failure did not escape the testkit');
  assert(cleanupFailureCalls === 1, 'failing cleanup did not run exactly once');

  const harness = createAgentSessionRuntimeHarness();
  harness.recordRuntimeEvent({
    kind: 'turn-start', sequence: 1, sessionId: 'session-1', turnId: 'turn-1',
    emittedAtMs: 1, startedBy: 'host',
  });
  harness.recordRuntimeEvent({ kind: 'turn-start', emittedAtMs: 2 });
  harness.recordRuntimeEvent({
    kind: 'turn-complete', sequence: 2, sessionId: 'session-1', turnId: 'turn-1', emittedAtMs: 3,
  });
  assert(harness.canonicalEvents().length === 2, 'valid runtime events were not retained');
  assert(harness.validationFailures().length === 1, 'invalid runtime event was not rejected');
  let invalidEventReported = false;
  try {
    harness.expectAllEventsValidated();
  } catch {
    invalidEventReported = true;
  }
  assert(invalidEventReported, 'invalid runtime event did not fail validation');
  harness.expectExactlyOneTerminalEvent({ turnId: 'turn-1' });
  harness.dispose();

  const disposedHarness = createAgentSessionRuntimeHarness();
  const pendingEvent = disposedHarness.until('turn-complete');
  disposedHarness.dispose();
  let harnessDisposalRejected = false;
  try {
    await pendingEvent;
  } catch {
    harnessDisposalRejected = true;
  }
  assert(harnessDisposalRejected, 'disposed runtime harness did not reject pending waiters');
}
