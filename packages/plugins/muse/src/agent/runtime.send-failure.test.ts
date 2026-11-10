// Failure frames are schema-derived; success identity/order is retained from Muse1.4.14.
// Only native stdio and authenticated Home transports are fixtures.
import { expect, it } from 'vitest';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

type Operations = ReturnType<typeof createNativeAgentSessionOperations>;
type DeliveryOutcome = Parameters<NonNullable<Parameters<NonNullable<Operations['setOnPromptDeliveryOutcome']>>[0]>>[0];

it.each(['refuse', 'eof', 'started-refuse', 'started-eof'] as const)(
  'preserves exact host input custody for native %s without retry', async turnFailure => {
    const fixture = await createAdmittedMuseSessionFixture({ native: { turnFailure } });
    const outcomes: DeliveryOutcome[] = [];
    let operations: Operations | undefined;
    try {
      const opened = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
      const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
      if (!capabilities) throw new Error('Admitted Muse Session declaration is unavailable');
      operations = createNativeAgentSessionOperations(opened, 'host-admitted-muse', undefined,
        opened.runtimeDescriptorV1?.agent.providerSessionId, undefined, undefined, undefined,
        { context: fixture.context, cwd: process.cwd(), connectedAccounts: [], capabilities,
          cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } },
        fixture.publications, [], undefined, undefined,
        async () => ({ status: 'admitted' }),
      );
      operations.setOnPromptDeliveryOutcome?.(outcome => outcomes.push(outcome));
      // A refused or disconnected RPC can reject this operation. Custody comes from
      // the real host's correlated native evidence, not from the thrown Error.
      await fixture.run(() => operations!.sendTurnPrompt('Reply with exactly PEBBLE. Do not use tools.', {
        localId: 'failure-input', turnId: 'failure-turn', userMessageSeq: 7,
      })).catch(() => undefined);
      const expected = turnFailure === 'refuse' ? 'input-rejected'
        : turnFailure.startsWith('started-') ? 'input-accepted' : 'input-custody-unknown';
      expect(outcomes).toMatchObject([{ type: expected, localId: 'failure-input' }]);
      expect(outcomes).toHaveLength(1);
      if (turnFailure === 'refuse') {
        expect(outcomes[0]).toMatchObject({ retryable: false, diagnostic: {
          code: 'provider_request_rejected', details: { method: 'turn/start', providerErrorCode: -32030 },
        } });
      }
      await operations.resetOrDisposeRuntime('session_closed'); operations = undefined;
      const audit = await fixture.readAudit();
      expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
      expect(audit.methods.filter(method => method === 'turn/interrupt' || method === 'turn/unqueue')).toEqual([]);
    } finally {
      await operations?.resetOrDisposeRuntime('session_closed');
      await fixture.dispose();
    }
  },
);
