import type { InstallProviderCliResult, ProviderCliInstallPlan } from '../install.js';
import {
    resolveProviderCliCommandForRuntime,
    type ProviderCliRuntimeDescriptor,
} from '../resolution.js';

type RuntimeInstallPreflightResult =
    | Readonly<{ kind: 'continue' }>
    | Readonly<{ kind: 'return'; result: InstallProviderCliResult }>;

export function runRuntimeInstallPreflight(params: Readonly<{
    runtimeSpec: ProviderCliRuntimeDescriptor;
    plan: ProviderCliInstallPlan;
    env: NodeJS.ProcessEnv;
    dryRun?: boolean;
    skipIfInstalled?: boolean;
    allowVendorRecipeExecution?: boolean;
}>): RuntimeInstallPreflightResult {
    const skipIfInstalled = params.skipIfInstalled !== false;
    const allowVendorRecipeExecution = params.allowVendorRecipeExecution === true;

    if (skipIfInstalled) {
        const existingResolution = resolveProviderCliCommandForRuntime(params.runtimeSpec, { processEnv: params.env });
        const alreadyInstalled =
            params.plan.installMode === 'vendor_recipe'
                ? Boolean(existingResolution)
                : existingResolution?.source === 'managed';
        if (alreadyInstalled) {
            return {
                kind: 'return',
                result: { ok: true, plan: params.plan, alreadyInstalled: true, logPath: null },
            };
        }
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
