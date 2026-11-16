import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import { DOCKER_SANDBOXES_PLUGIN } from '@happier-dev/plugins-machine-docker-sandboxes';
import { PLUGIN as AGENT37_PLUGIN } from '@happier-dev/plugins-machine-agent37';
import { createPluginSurfaceActionFailureError, projectPluginActionFailure } from '@/components/plugins/surfaces/actionFailure';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from './resolveActionExecutionFailureMessage';

async function presentProviderFailure(operation: () => Promise<unknown>) {
    try { await operation(); } catch (error) {
        // The Action wire projection and plugin-surface reconstruction are the
        // real adapters, rather than a handwritten failed-Action envelope.
        const failure = readPluginActionError(error);
        if (!failure) throw new Error('Provider did not publish a typed Action failure');
        const surfaced = createPluginSurfaceActionFailureError(projectPluginActionFailure(failure));
        return { failure, message: resolveActionExecutionErrorMessage(surfaced, 'Provider unavailable') };
    }
    throw new Error('Expected provider failure');
}

async function dockerKit(run: ExecService['run']) {
    // Partial host process/dependency service fixtures are the canonical
    // testkit boundary; activation, declarations and invocation stay real.
    const services = { exec: { run }, managedServices: { dependencies: {
        status: async (): Promise<ManagedDependencyStatus> => ({ state: 'ready', id: 'docker-sandboxes-cli',
            version: '0.53.0', sourceId: 'system', executable: { kind: 'systemTool', id: 'sbx' } }),
    } } } as unknown as PluginTestServicesFixture;
    return createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services });
}

it('carries the real Docker template login refusal from sbx through the Action surface presenter', async () => {
    // Only the native process boundary is replaced. No Docker or Action owner
    // is mocked, and no sandbox is created by template discovery.
    const invocations: string[][] = [];
    const run: ExecService['run'] = async request => {
        invocations.push([...(request.args ?? [])]);
        return { termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
            stdout: new Uint8Array(), stderr: new TextEncoder().encode('not signed in to Docker; try: sbx login'),
            stdoutTruncated: false, stderrTruncated: false };
    };
    const kit = await dockerKit(run);
    try {
        const presented = await presentProviderFailure(() => kit.invokeAction('options', {}, { surface: 'plugin' }));
        expect(presented.failure).toMatchObject({ code: 'credential_unavailable', retryable: true });
        expect(presented.message).toBe('Sign in to Docker: run sbx login');
        expect(invocations).toEqual([['template', 'ls', '--quiet']]);
    } finally { await kit.dispose(); }
});

it('retains supplied Exec recovery through Docker discovery and the same Action surface presenter', async () => {
    // Exec is a genuine host/process boundary and publishes canonical typed
    // launch refusals; the provider must not replace that author payload.
    const run: ExecService['run'] = async () => { throw new PluginError({ code: 'managed_cli_unavailable',
        message: 'Allow the Docker CLI, then try again.', retryable: true, remediation: { kind: 'retry' } }); };
    const kit = await dockerKit(run);
    try {
        const presented = await presentProviderFailure(() => kit.invokeAction('options', {}, { surface: 'plugin' }));
        expect(presented.message).toBe(`Allow the Docker CLI, then try again. ${t('errors.tryAgain')}`);
        expect(presented.failure.data).toMatchObject({ remediation: { kind: 'retry' } });
    } finally { await kit.dispose(); }
});

it('presents a migrated Agent37 vendor authentication refusal through the same Action surface', async () => {
    const requests: string[] = [];
    // Only the vendor HTTP transport is replaced; native error classification,
    // typed catch/rethrow, Action projection and presentation remain real.
    // Connected-account materialization and HTTP are host service boundaries.
    const services = { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders',
        headers: { authorization: 'Bearer constructed-auth-refusal-fixture' } }) },
        http: { request: async (request: { url: string }) => {
            requests.push(request.url);
            return { status: 401, finalUrl: request.url, headers: {}, body: new TextEncoder().encode('{}') };
        } },
    } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: AGENT37_PLUGIN.manifest, module: AGENT37_PLUGIN, services });
    try {
        const presented = await presentProviderFailure(() => kit.invokeAction('check', {}, { surface: 'plugin' }));
        expect(presented.failure.code).toBe('credential_unavailable');
        expect(presented.message).toBe(t('session.startFailure.cause.credential_unavailable'));
        expect(requests).toEqual(['https://api.agent37.com/v1/instances']);
    } finally { await kit.dispose(); }
});
