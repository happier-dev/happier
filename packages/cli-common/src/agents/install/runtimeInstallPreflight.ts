import type { InstallAgentCliResult, AgentCliInstallIntent, AgentCliInstallPlan } from '../install.js';
import {
    readBackendCliSourcePreferenceForAgent,
    resolveAgentCliCommandForRuntime,
    type AgentCliCommandResolution,
    type AgentCliRuntimeDescriptor,
    type AgentCliSourcePolicy,
} from '../resolution.js';

type RuntimeInstallPreflightResult =
    | Readonly<{ kind: 'continue' }>
    | Readonly<{ kind: 'return'; result: InstallAgentCliResult }>;

function shouldTreatResolutionAsInstalled(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    plan: AgentCliInstallPlan;
    resolution: AgentCliCommandResolution | null;
    env: NodeJS.ProcessEnv;
    sourcePolicy: AgentCliSourcePolicy;
}>): boolean {
    const resolution = params.resolution;
    if (!resolution) return false;
    // Under the strict request-scoped policy only a current managed install can
    // satisfy the request, so a retry reuses it and nothing else stands in.
    if (params.sourcePolicy === 'managed_only') return resolution.source === 'managed';
    if (resolution.source === 'override' || resolution.source === 'managed') return true;
    if (params.plan.installMode === 'vendor_recipe') return true;

    const sourcePreference = readBackendCliSourcePreferenceForAgent(
        params.runtimeSpec.id,
        params.runtimeSpec.sourcePreferenceDefault,
        params.env,
    );
    return sourcePreference === 'system-first';
}

export function runRuntimeInstallPreflight(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    plan: AgentCliInstallPlan;
    env: NodeJS.ProcessEnv;
    dryRun?: boolean;
    skipIfInstalled?: boolean;
    intent?: AgentCliInstallIntent;
    allowVendorRecipeExecution?: boolean;
    sourcePolicy?: AgentCliSourcePolicy;
}>): RuntimeInstallPreflightResult {
    const skipIfInstalled = params.intent !== 'update' && params.skipIfInstalled !== false;
    const sourcePolicy = params.sourcePolicy ?? 'default';
    const allowVendorRecipeExecution = params.allowVendorRecipeExecution === true;

    if (skipIfInstalled) {
        const existingResolution = resolveAgentCliCommandForRuntime(params.runtimeSpec, {
            processEnv: params.env,
            sourcePolicy,
        });
        const alreadyInstalled = shouldTreatResolutionAsInstalled({
            runtimeSpec: params.runtimeSpec,
            plan: params.plan,
            resolution: existingResolution,
            env: params.env,
            sourcePolicy,
        });
        if (alreadyInstalled) {
            return {
                kind: 'return',
                result: { ok: true, plan: params.plan, alreadyInstalled: true, logPath: null },
            };
        }
    }

    if (sourcePolicy === 'managed_only' && params.plan.installMode === 'vendor_recipe') {
        return {
            kind: 'return',
            result: {
                ok: false,
                errorCode: 'vendor-recipe-disallowed',
                errorMessage:
                    `Vendor install recipes are not available for ${params.runtimeSpec.id} under the managed_only source policy. This request may install and launch only a managed install.`,
                plan: params.plan,
                logPath: null,
            },
        };
    }

    if (params.dryRun) {
        return {
            kind: 'return',
            result: { ok: true, plan: params.plan, alreadyInstalled: false, logPath: null },
        };
    }

    if (params.plan.installMode === 'vendor_recipe' && !allowVendorRecipeExecution) {
        return {
            kind: 'return',
            result: {
                ok: false,
                errorCode: 'vendor-recipe-disallowed',
                errorMessage:
                    'Vendor install recipes are disabled by default. Re-run with allowVendorRecipeExecution=true to execute the vendor-provided installer commands.',
                plan: params.plan,
                logPath: null,
            },
        };
    }

    return { kind: 'continue' };
}
