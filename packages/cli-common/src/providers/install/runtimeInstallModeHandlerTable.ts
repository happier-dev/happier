import type { ProviderCliInstallMode } from '../install.js';
import { githubReleaseBinaryRuntimeInstallModeHandler } from './runtimeInstallModeHandlers/githubReleaseBinaryRuntimeInstallMode.js';
import { managedPackageRuntimeInstallModeHandler } from './runtimeInstallModeHandlers/managedPackageRuntimeInstallMode.js';
import { vendorRecipeRuntimeInstallModeHandler } from './runtimeInstallModeHandlers/vendorRecipeRuntimeInstallMode.js';
import type { RuntimeInstallModeHandlerEntry } from './runtimeInstallModeTypes.js';

export const runtimeInstallModeHandlerTable: Readonly<Record<ProviderCliInstallMode, RuntimeInstallModeHandlerEntry>> = {
    vendor_recipe: vendorRecipeRuntimeInstallModeHandler,
    managed_package: managedPackageRuntimeInstallModeHandler,
    github_release_binary: githubReleaseBinaryRuntimeInstallModeHandler,
};
