import { describe, expect, it } from 'vitest';
import {
    PluginUiSelectedActionInputCarrierV1Schema,
    PluginUiTargetedContributionOperationV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import { createSelectedActionInputCustody } from './selectedActionInputCustody';

function runtimeCarrier() {
    const operation = {
        point: { pointId: 'review', protocol: { id: 'review', version: 1 } },
        contributor: { pluginId: 'acme.github', contributionId: 'github', occurrenceId: 'github:75',
            sourceCustody: { kind: 'development', registeredRootId: 'runtime-github-root' } },
        role: 'prepareReviewWorkspace',
        action: { pluginId: 'acme.github', localId: 'prepare-review' },
    };
    return PluginUiSelectedActionInputCarrierV1Schema.parse({
        operation,
        result: { kind: 'submitted', action: operation.action, input: { repository: 'acme/project' },
            selection: {
                target: { pluginId: 'acme.triage', sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
                point: operation.point,
                contributor: { pluginId: operation.contributor.pluginId, contributionId: operation.contributor.contributionId,
                    sourceCustody: operation.contributor.sourceCustody },
            },
            connectedAccount: { kind: 'none' },
            presentation: { connectedAccountLabel: null, machineDisplayName: null },
        },
    });
}

describe('selected Action input custody', () => {
    it.each([false, true])('resolves and consumes the requested identity while retaining the runtime operation (mapped=%s)', mapped => {
        const carrier = runtimeCarrier();
        const requestOperation = mapped ? PluginUiTargetedContributionOperationV1Schema.parse({
            ...carrier.operation,
            contributor: { ...carrier.operation.contributor, occurrenceId: 'github-account-release',
                sourceCustody: { kind: 'account_release', pluginId: 'acme.github', version: '1.0.0',
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}` } },
        }) : carrier.operation;
        const custody = createSelectedActionInputCustody();
        custody.retain(carrier.operation, carrier.result, undefined, requestOperation);
        const requestCarrier = { operation: requestOperation, result: carrier.result };

        expect(custody.resolve(requestCarrier)?.carrier).toEqual(carrier);
        expect(custody.settle(carrier.result.action, undefined, false)).toMatchObject({ ok: true, selected: { carrier } });
        expect(custody.resolve({ ...requestCarrier, result: { ...carrier.result, input: { repository: 'other/project' } } })).toBeUndefined();
        expect(custody.resolve({ ...requestCarrier, operation: { ...requestOperation, contributor: {
            ...requestOperation.contributor, sourceCustody: { kind: 'development', registeredRootId: 'unissued-root' },
        } } })).toBeUndefined();

        expect(custody.settle(carrier.result.action, undefined, true)).toMatchObject({ ok: true, selected: { carrier } });
        expect(custody.resolve(requestCarrier)).toBeUndefined();
        expect(custody.settle(carrier.result.action, undefined, false)).toEqual({ ok: false, reason: 'selected_action_input_inactive' });
    });

    it('snapshots the original request custody before author-owned objects can change', () => {
        const carrier = runtimeCarrier();
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'original-request-root' };
        const requestOperation = { ...carrier.operation, contributor: { ...carrier.operation.contributor,
            occurrenceId: 'original-occurrence', sourceCustody } };
        const originalRequest = PluginUiTargetedContributionOperationV1Schema.parse(requestOperation);
        const custody = createSelectedActionInputCustody();
        custody.retain(carrier.operation, carrier.result, undefined, requestOperation);
        sourceCustody.registeredRootId = 'changed-request-root';

        expect(custody.resolve({ operation: originalRequest, result: carrier.result })?.carrier).toEqual(carrier);
        expect(custody.resolve({ operation: requestOperation, result: carrier.result })).toBeUndefined();
    });
});
