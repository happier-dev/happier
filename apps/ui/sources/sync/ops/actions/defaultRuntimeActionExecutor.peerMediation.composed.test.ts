import { describe, expect, it } from 'vitest';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDefaultRuntimeActionExecutor } from './defaultRuntimeActionExecutor';
import { createPeerMediationObservabilityDaemonRuntimeActionExecutor } from '../../../../../cli/src/daemon/peer/mediation/observability/runtimeActionExecutor';
import { createDaemonPeerMediationObservabilityStore } from '../../../../../cli/src/daemon/peer/mediation/observability/store';

function harness(enabled = true) {
    const store = createDaemonPeerMediationObservabilityStore({ nowMs: () => 1_000 });
    const daemon = createPeerMediationObservabilityDaemonRuntimeActionExecutor({
        store, accountId: 'owner', machineId: 'machine-a',
        featurePayload: { features: { machines: { enabled: true,
            peerMediation: { enabled: true, observability: { enabled } } } } },
    });
    const requests: RuntimeActionExecuteArgs[] = [];
    // Only the Machine transport boundary is replaced. UI family composition,
    // protocol dispatch/output parsing and the daemon read/scope gates stay real.
    const runtimeActionExecute = createDefaultRuntimeActionExecutor({}, undefined, async args => {
        requests.push(args);
        return await daemon(args);
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute }));
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a' } };
    return { executor, context, requests };
}

describe('UI peer-mediation runtime composition through protocol dispatch and the daemon boundary', () => {
    it('returns the owner snapshot with one Machine dispatch', async () => {
        const { executor, context, requests } = harness();
        expect(await executor.execute('peerMediation.observability.snapshot', { machineId: 'machine-a' }, context))
            .toMatchObject({ ok: true, result: { ok: true, snapshot: {
                scope: { kind: 'machine', accountId: 'owner', machineId: 'machine-a' },
            } } });
        expect(requests).toHaveLength(1);
    });

    it('preserves the daemon read-feature refusal', async () => {
        const { executor, context, requests } = harness(false);
        expect(await executor.execute('peerMediation.observability.snapshot', { machineId: 'machine-a' }, context))
            .toEqual({ ok: false, errorCode: 'runtime_action_disabled',
                error: 'runtime_action_disabled:peerMediation:peer_mediation_observability_read_unavailable' });
        expect(requests).toHaveLength(1);
    });

    it('preserves the daemon scope refusal for another Account and routes the remaining family members', async () => {
        const { executor, context, requests } = harness();
        expect(await executor.execute('peerMediation.observability.subscribe', {
            scope: { kind: 'machine', accountId: 'other-person', machineId: 'machine-a' },
        }, context)).toEqual({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:peerMediation:observability_scope_forbidden' });
        expect(await executor.execute('peerMediation.observability.unsubscribe', {}, context))
            .toEqual({ ok: true, result: { ok: true } });
        expect(requests).toHaveLength(2);
    });
});
