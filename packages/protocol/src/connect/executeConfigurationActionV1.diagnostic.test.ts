import { describe, expect, it } from 'vitest';
import { createActionExecutorBoundaryFixture } from '../../../tests/src/testkit/actionExecutorBoundary.js';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { PluginDiagnosticDataV1Schema } from '../daemon/pluginContributionIntrospection.js';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from './executeConfigurationActionV1.js';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const account = { service, accountId: 'work' };

// The daemon RPC is the boundary: this is the public, redacted diagnostic
// emitted by projectConnectedAccountFailure (CAUSE-CARRY-HOST 68e3d5a7558).
const diagnostic = PluginDiagnosticDataV1Schema.parse({
    code: 'service_unavailable', severity: 'error', message: 'Install the declared provider dependency.',
    remediation: { kind: 'installDependency', dependencyId: 'provider-runtime' },
    details: { failureCause: { phase: 'connected_account.control', errorClass: 'PluginError',
        errorCode: 'provider_runtime_missing', httpStatus: null } },
});

function hostFor(response: unknown): ConnectedServiceConfigurationActionHostV1 {
    return {
        assertCurrent() {},
        async request() { throw new Error('unexpected_http'); },
        async mutatePurposeBindings() { throw new Error('unexpected_settings_write'); },
        async resolveAgent() { return null; },
        async resetQuota() { throw new Error('unexpected_quota_reset'); },
        async openBillingDestination() { throw new Error('unavailable_must_not_open_billing'); },
        async controlCommand() { return response; },
    };
}

function executorFor(response: unknown) {
    const host = hostFor(response);
    return createActionExecutor(createActionExecutorBoundaryFixture({
        presentUserActionConfirmation: async () => true,
        connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input),
    }));
}

describe('connected-account control Action failure diagnostics', () => {
    it.each([
        ['connectedServices.accounts.testConnection', { account }, 'service_unavailable'],
        ['connectedServices.billing.open', { account, machineId: 'machine-1' }, 'service_unavailable'],
        ['connectedServices.quota.refresh', { account, machineId: 'machine-1' }, 'service_unavailable'],
        ['connectedServices.configuration.get', { target: { kind: 'account', account } }, 'service_unavailable'],
        ['connectedServices.configuration.replace', { target: { kind: 'attempt', attemptId: 'attempt-1' },
            expectedRevision: null, values: {}, secretValues: {} }, 'outcome_unknown'],
    ] as const)('carries the daemon cause and remedy through %s to the public Action result', async (id, input, code) => {
        const result = await executorFor({ status: 'unavailable', code, diagnostic }).execute(id, input,
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: false, errorCode: code, error: diagnostic.message,
            details: { diagnostic } });
        expect(JSON.parse(JSON.stringify(result))).toMatchObject({ details: { diagnostic } });
    });

    it('keeps the daemon cause and remedy when preparing a credential revoke', async () => {
        expect(await prepareConnectedServiceRevokeInputV1(hostFor({ status: 'unavailable', code: 'service_unavailable', diagnostic }),
            { account, machineId: 'machine-1', cleanupGroupReferences: false }))
            .toMatchObject({ ok: false, errorCode: 'service_unavailable', error: diagnostic.message, details: { diagnostic } });
    });

    it.each([undefined, { message: 'untyped legacy diagnostic' }])('preserves a code-only daemon refusal without a typed diagnostic (%s)', async value => {
        expect(await executorFor({ status: 'unavailable', code: 'service_unavailable', ...(value === undefined ? {} : { diagnostic: value }) })
            .execute('connectedServices.accounts.testConnection', { account },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
            .toMatchObject({ ok: false, errorCode: 'service_unavailable', error: 'service_unavailable' });
    });
});
