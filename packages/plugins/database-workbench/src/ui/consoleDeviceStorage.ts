import type { DatabaseDescriptorV1 } from '@happier-dev/database-protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { ConsoleDeviceStorage, ConsoleState } from './consoleState.js';

function readConsoleState(value: unknown): ConsoleState | null {
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)
        || !('sql' in value) || typeof value.sql !== 'string'
        || !('history' in value) || !Array.isArray(value.history)) {
        throw new TypeError('Stored database console draft has an invalid shape');
    }
    const history: unknown[] = value.history;
    return { sql: value.sql, history: history.map(entry => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
            || !('sql' in entry) || typeof entry.sql !== 'string') {
            throw new TypeError('Stored database console history has an invalid shape');
        }
        return { sql: entry.sql };
    }) };
}

/** The host owns Home/Account/plugin scope; the descriptor adds Machine and database identity. */
export function createConsoleDeviceStorage(
    host: Pick<PluginUiHostApi, 'deviceState'>,
    descriptor: Pick<DatabaseDescriptorV1, 'target' | 'placement'>,
): ConsoleDeviceStorage {
    const key = createCanonicalJsonSigningInput(['database-console', descriptor.placement.machineId,
        projectNativeJsonValueForTransport(descriptor.target)]);
    return {
        async read() {
            const result = await host.deviceState({ operation: 'read', key });
            if (result.status === 'unavailable') throw new Error(`Device draft storage unavailable: ${result.reason}`);
            return readConsoleState(result.value);
        },
        async write(state) {
            const result = await host.deviceState({ operation: 'write', key,
                value: { sql: state.sql, history: state.history.map(({ sql }) => ({ sql })) } });
            if (result.status === 'unavailable') throw new Error(`Device draft storage unavailable: ${result.reason}`);
        },
    };
}
