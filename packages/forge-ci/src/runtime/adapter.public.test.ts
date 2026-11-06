import { describe, expect, it, vi } from 'vitest';
import { createForgeCiAdapterV1, type ForgeCiAdapterOptionsV1 } from '@happier-dev/forge-ci/runtime';
import { ForgeCiActionInputSchemasV1, ForgeCiActionResultSchemasV1, type ForgeCiActionInputByOperationV1, type ForgeCiOperationIdV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

const vectors = createForgeCiConformanceVectorsV1();
const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(operation => [operation, { pluginId: 'example.forge', localId: `ci/${operation}` }])) as Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef>>;

function adapter(invoke: ForgeCiAdapterOptionsV1['invoke'], bindings = actionRefs) {
    return createForgeCiAdapterV1({ actionRefs: bindings, invoke, activeRunPollIntervalMs: 3000 });
}

describe('public CI adapter', () => {
    it.each([
        { hostCode: 'unavailable', nativeCode: 'plugin_mounted_caller_unavailable', retryable: false, failureClass: 'unsupportedContract' },
        { hostCode: 'stale_surface', nativeCode: 'plugin_occurrence_stale', retryable: false, failureClass: 'unsupportedContract' },
        { hostCode: 'denied', nativeCode: 'plugin_action_not_allowed', retryable: false, failureClass: 'permission' },
        { hostCode: 'unavailable', nativeCode: 'project_requester_home_unavailable', retryable: true, failureClass: 'transient' },
    ])('preserves typed host refusal $nativeCode without inventing a provider outage', async ({ hostCode, nativeCode, retryable, failureClass }) => {
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockRejectedValue(new PluginError({
            code: hostCode, retryable, message: 'Host refusal with private context',
            diagnostics: [{ code: nativeCode, severity: 'error', details: { private: 'not a source failure detail' } }],
        }));
        expect(await adapter(invoke).readRun({ repository: vectors.github.repository, runId: '101' })).toEqual({
            kind: 'unavailable', failure: { class: failureClass, code: nativeCode },
        });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('does not promote an ordinary thrown code to a canonical host refusal', async () => {
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockRejectedValue(Object.assign(new Error('private transport message'), {
            code: 'denied', retryable: false, diagnostics: [{ code: 'invented_authority', severity: 'error' }],
        }));
        expect(await adapter(invoke).readRun({ repository: vectors.github.repository, runId: '101' })).toEqual({
            kind: 'unavailable', failure: { class: 'transient', code: 'ci_invocation_failed' },
        });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('projects optional native members before crossing the JSON Action transport', async () => {
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockResolvedValue({
            kind: 'unavailable', failure: { class: 'permission', code: 'denied' },
        });
        const input = {
            repository: vectors.github.repository,
            selection: { kind: 'attempt', attempt: { run: vectors.github.run.ref, attemptId: '2', number: undefined } },
            excerpt: { contextLines: 0, tailLines: 0, failedOnly: true },
            maxSerializedBytes: 4096,
        } satisfies ForgeCiActionInputByOperationV1['readFailureContext'];
        await adapter(invoke).readFailureContext(input);
        expect(invoke.mock.calls[0]?.[1]).toEqual({
            ...input,
            selection: { kind: 'attempt', attempt: { run: vectors.github.run.ref, attemptId: '2' } },
        });
        expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('selection.attempt.number');
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('binds qualified Actions and admits the returned unknown through the actual operation schema', async () => {
        // Invocation transport is the external host boundary; all CI schemas stay real.
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockResolvedValue({ kind: 'value', value: vectors.github.run, validator: 'etag' });
        const ci = adapter(invoke);
        const controller = new AbortController();
        const input = { repository: vectors.github.repository, runId: vectors.github.run.ref.runId, attempt: '2', validator: 'previous' };
        expect(await ci.readRun(input, { signal: controller.signal })).toEqual({ kind: 'value', value: vectors.github.run, validator: 'etag' });
        expect(invoke).toHaveBeenCalledWith(actionRefs.readRun, input, { signal: controller.signal });
        expect(ci.activeRunPollIntervalMs).toBe(3000);
        invoke.mockResolvedValueOnce({ kind: 'value', value: { ...vectors.github.run, ref: { ...vectors.github.run.ref, invented: true } }, validator: 'etag' });
        expect(await ci.readRun(input)).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract' } });
    });

    it('does not acquire transport for unsupported read, effect or receiver bindings', async () => {
        const invoke = vi.fn(async () => { throw new Error('unbound transport'); });
        const bindings = Object.fromEntries(Object.keys(actionRefs).map(operation => [operation, null])) as ForgeCiAdapterOptionsV1['actionRefs'];
        const ci = createForgeCiAdapterV1({ actionRefs: bindings, invoke, activeRunPollIntervalMs: 3000 });
        expect(await ci.readRun({ repository: vectors.github.repository, runId: '1' })).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract' } });
        expect(await ci.cancelRun({ repository: vectors.github.repository, runId: '1' })).toMatchObject({ kind: 'rejected', failure: { class: 'unsupportedContract' } });
        expect(await ci.downloadJobLog({ repository: vectors.github.repository, runId: '1', jobId: '2', destination: { destinationId: 'receiver' } })).toMatchObject({ success: false, status: 'failed', errorCode: 'unsupportedContract' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('keeps uncertain writes explicit and does not retry a rejected transport', async () => {
        const unknown = ForgeCiActionResultSchemasV1.cancelRun.parse({ kind: 'outcome_unknown', affected: { repository: vectors.github.repository, run: vectors.github.run.ref }, webUrl: 'https://github.com/example/project/actions/runs/101' });
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockResolvedValueOnce(unknown).mockRejectedValueOnce(new Error('transport lost'));
        const ci = adapter(invoke);
        const input = { repository: vectors.github.repository, runId: '101' };
        expect(await ci.cancelRun(input)).toEqual(unknown);
        expect(await ci.cancelRun(input)).toMatchObject({ kind: 'outcome_unknown', affected: { repository: vectors.github.repository, run: vectors.github.run.ref } });
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('retains exact workflow/ref and receiver uncertainty after a possible effect without guessing a run', async () => {
        // Host transport may lose the response after the provider has acted.
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockRejectedValue(new Error('response lost after effect'));
        const ci = adapter(invoke);
        const result = await ci.dispatchWorkflow({ repository: vectors.github.repository, workflowId: 'workflow-9', ref: 'refs/heads/topic', inputs: { enabled: false } });
        expect(result).toMatchObject({ kind: 'outcome_unknown', affected: { repository: vectors.github.repository, workflowId: 'workflow-9', ref: 'refs/heads/topic' } });
        expect(result).not.toHaveProperty('affected.run');
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(await ci.downloadArtifact({ repository: vectors.github.repository, runId: '101', artifactId: 'asset-1', destination: { destinationId: 'receiver' } })).toMatchObject({ success: false, status: 'unknown' });
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('preserves an authoritative refusal and treats a malformed possible-effect result as uncertain', async () => {
        const refused = { kind: 'rejected', failure: { class: 'permission', code: 'denied' } };
        const invoke = vi.fn<ForgeCiAdapterOptionsV1['invoke']>().mockResolvedValueOnce(refused).mockResolvedValueOnce({ kind: 'confirmed', receipt: {} });
        const ci = adapter(invoke);
        const input = { repository: vectors.github.repository, runId: '101', attempt: '3', jobId: 'job-4' };
        expect(await ci.rerunJob(input)).toEqual(refused);
        expect(await ci.rerunJob(input)).toMatchObject({ kind: 'outcome_unknown', affected: { jobId: 'job-4', selection: { kind: 'attempt', attempt: { run: vectors.github.run.ref, attemptId: '3' } } } });
        expect(invoke).toHaveBeenCalledTimes(2);
    });
});
