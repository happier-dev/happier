import { PluginError } from '../errors.js';

type AccountSettingsReader = Readonly<{
    snapshot: (...args: never[]) => unknown;
    get: (...args: never[]) => unknown;
    describe: (...args: never[]) => unknown;
    watch: (...args: never[]) => unknown;
}>;

/** Projects the existing Settings reader without leaking daemon or mutation capabilities. */
export function createPluginAccountActionSettingsService<TService extends AccountSettingsReader>(
    source: Readonly<{ forScope(scope: Readonly<{ kind: 'account' }>): TService }>,
): Readonly<{ forScope(scope: Readonly<{ kind: 'account' }>): Pick<TService, keyof AccountSettingsReader> }> {
    return Object.freeze({ forScope(scope: Readonly<{ kind: 'account' }>) {
        if (scope?.kind !== 'account') throw new PluginError({ code: 'plugin_settings_scope_unavailable' });
        const service = source.forScope(scope);
        return Object.freeze({
            snapshot: service.snapshot.bind(service),
            get: service.get.bind(service),
            describe: service.describe.bind(service),
            watch: service.watch.bind(service),
        }) as Pick<TService, keyof AccountSettingsReader>;
    } });
}
