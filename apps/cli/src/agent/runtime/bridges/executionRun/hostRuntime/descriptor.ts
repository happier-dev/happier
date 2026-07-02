import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { ExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import {
    requireExecutionRunHostRuntime,
    type ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/packagedRuntime/isolation/types';
import { resolveBackendIsolationBundle } from '@/packagedRuntime/isolation/resolveBackendIsolationBundle';
import { cleanupExecutionRunIsolationBundle } from '../runtime/isolation';
import { createLazyExecutionRunHostRuntime } from './lazy';
import { withExecutionRunHostRuntimeCleanup } from './cleanup';
import { withExecutionRunPermissionResponder } from './permissionResponder';

function createExecutionRunHostRuntimeFromDescriptor(
    opts: CreateCliExecutionRunBackendParams,
    descriptor: ExecutionRunBackendDescriptor,
    permissionHandler: ReturnType<typeof createExecutionRunPermissionHandler>,
    bundle: BackendIsolationBundle | null,
): ExecutionRunHostRuntime {
    const base = requireExecutionRunHostRuntime(
        descriptor.factory({
            cwd: opts.cwd,
            backendId: opts.backendId,
            modelId: opts.modelId,
            permissionMode: opts.permissionMode,
            accountSettings: opts.accountSettings,
            permissionHandler,
            start: opts.start ?? null,
            ...(bundle ? { isolation: { env: bundle.env, settingsPath: bundle.settingsPath } } : {}),
        }),
        `Execution-run descriptor factory for '${opts.backendId}' must return ExecutionRunHostRuntime directly`,
    );
    return withExecutionRunPermissionResponder(base, permissionHandler);
}

export function createDescriptorExecutionRunHostRuntime(
    opts: CreateCliExecutionRunBackendParams,
    descriptor: ExecutionRunBackendDescriptor | null,
): ExecutionRunHostRuntime | null {
    if (!descriptor) {
        return null;
    }

    const permissionHandler = createExecutionRunPermissionHandler({
        backendId: opts.backendId,
        permissionMode: opts.permissionMode,
    });
    const retentionPolicy = String(opts.start?.retentionPolicy ?? '').trim();
    const shouldCleanupIsolation = retentionPolicy === 'ephemeral';
    const shouldIsolate = shouldCleanupIsolation || String(opts.runId ?? '').trim().length > 0;
    const intent = (() => {
        const raw = String(opts.start?.intent ?? '').trim();
        return raw.length > 0 ? raw : undefined;
    })();
    const isolationId = shouldIsolate
        ? (String(opts.runId ?? '').trim() || `run_${opts.backendId}_${Date.now()}`)
        : '';
    const isolationRequest: BackendIsolationRequest | null = shouldIsolate
        ? {
            backendId: opts.backendId,
            isolationId,
            scope: 'execution_run',
            ...(intent ? { intent } : {}),
            cwd: opts.cwd,
        }
        : null;
    if (shouldCleanupIsolation) {
        return createLazyExecutionRunHostRuntime({
            resolveRuntime: async () => {
                const baseBundle = isolationRequest ? resolveBackendIsolationBundle(isolationRequest) : null;
                let bundle = baseBundle;
                try {
                    if (baseBundle && descriptor.resolveIsolation && isolationRequest) {
                        bundle = descriptor.resolveIsolation(isolationRequest, baseBundle);
                    }

                    const runtime = createExecutionRunHostRuntimeFromDescriptor(
                        opts,
                        descriptor,
                        permissionHandler,
                        bundle,
                    );

                    if (!bundle?.cleanup) {
                        return runtime;
                    }

                    const cleanupBundle = bundle;
                    return withExecutionRunHostRuntimeCleanup(runtime, async () => {
                        await cleanupBundle.cleanup?.();
                    });
                } catch (error) {
                    await cleanupExecutionRunIsolationBundle(bundle);
                    throw error;
                }
            },
        });
    }

    const baseBundle = isolationRequest ? resolveBackendIsolationBundle(isolationRequest) : null;
    const bundle = baseBundle && descriptor.resolveIsolation && isolationRequest
        ? descriptor.resolveIsolation(isolationRequest, baseBundle)
        : baseBundle;
    return createExecutionRunHostRuntimeFromDescriptor(opts, descriptor, permissionHandler, bundle);
}
