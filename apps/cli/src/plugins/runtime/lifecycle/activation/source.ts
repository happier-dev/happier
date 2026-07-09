import { dirname } from 'node:path';

import type { PluginApi, PluginDisposable } from '../../api/types';
import type { PluginActivationSource } from '../../activationSources';
import type { PluginDaemonModuleNamespace } from '../../types';
import { isRecord } from '../utils';
import type { ActivationTarget } from './targets';

/**
 * Resolution of "where does this plugin's activation code come from and how
 * do we invoke it": the daemon module's `activate` export, the activation
 * source descriptor (file-backed vs. bundled), and the on-disk plugin root
 * used for auto ACP-backend registration.
 */

export type ActivationExport = (
    api: PluginApi,
) => void | PluginDisposable | Promise<void | PluginDisposable>;

export function resolveActivationExport(moduleNamespace: PluginDaemonModuleNamespace): Readonly<
    | { status: 'found'; activate: ActivationExport }
    | { status: 'missing' }
    | { status: 'invalid' }
> {
    if (typeof moduleNamespace.activate === 'function') {
        return { status: 'found', activate: moduleNamespace.activate as ActivationExport };
    }

    if (typeof moduleNamespace.default === 'function') {
        return { status: 'found', activate: moduleNamespace.default as ActivationExport };
    }

    if (isRecord(moduleNamespace.default) && typeof moduleNamespace.default.activate === 'function') {
        return { status: 'found', activate: moduleNamespace.default.activate as ActivationExport };
    }

    if (
        moduleNamespace.activate !== undefined
        || (isRecord(moduleNamespace.default) && moduleNamespace.default.activate !== undefined)
    ) {
        return { status: 'invalid' };
    }

    return { status: 'missing' };
}

export function resolveActivationSource(
    target: ActivationTarget,
    resolver: ((target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null) | undefined,
): PluginActivationSource<PluginDaemonModuleNamespace> {
    const resolved = resolver?.(target) ?? null;
    if (resolved) {
        return resolved;
    }

    return {
        kind: 'file_backed',
        entryPath: target.daemonEntryPath,
        devEntryPath: target.devDaemonEntryPath,
        trustPolicy: target.sourceSpec?.trustPolicy,
    };
}

export function resolveAutoAcpPluginRoot(target: ActivationTarget, activationSource: PluginActivationSource<PluginDaemonModuleNamespace>): string | null {
    if (activationSource.kind !== 'file_backed') {
        return null;
    }
    if (target.sourceSpec?.kind === 'path' && target.sourceSpec.locator.trim().length > 0) {
        return target.sourceSpec.locator;
    }
    return dirname(dirname(target.manifestPath));
}
