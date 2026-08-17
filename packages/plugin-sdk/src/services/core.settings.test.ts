import { describe, expectTypeOf, it } from 'vitest';

import type { JsonValue } from '../identity.js';
import type {
    PluginSettingDescriptor,
    PluginSettingsChange,
    ScopedSettingsService,
    SettingsScopeRef,
    SettingsService,
} from './core.js';

describe('scoped Settings service contract', () => {
    it('requires one exact account or daemon scope before every Settings operation', () => {
        expectTypeOf<keyof SettingsService>().toEqualTypeOf<'forScope'>();
        expectTypeOf<SettingsScopeRef>().toEqualTypeOf<
            | Readonly<{ kind: 'account' }>
            | Readonly<{ kind: 'daemon' }>
        >();
        expectTypeOf<SettingsService['forScope']>().toEqualTypeOf<
            (scope: SettingsScopeRef) => ScopedSettingsService
        >();
        expectTypeOf<keyof ScopedSettingsService>().toEqualTypeOf<
            'snapshot' | 'get' | 'set' | 'reset' | 'describe' | 'watch'
        >();
        expectTypeOf<PluginSettingDescriptor['scope']>().toEqualTypeOf<'account' | 'daemon'>();
        expectTypeOf<ReturnType<ScopedSettingsService['snapshot']>>().toEqualTypeOf<Promise<Readonly<{
            scope: SettingsScopeRef;
            revision: string;
            values: Readonly<Record<string, JsonValue>>;
        }>>>();
        expectTypeOf<PluginSettingsChange>().toEqualTypeOf<Readonly<{
            scope: SettingsScopeRef;
            revision: string;
            changedIds: readonly string[];
            values: Readonly<Record<string, JsonValue>>;
        }>>();
        expectTypeOf<Parameters<ScopedSettingsService['watch']>>().toEqualTypeOf<[
            listener: (change: PluginSettingsChange) => void,
        ]>();
    });
});
