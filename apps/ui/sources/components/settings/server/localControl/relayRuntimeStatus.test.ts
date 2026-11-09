import type { SystemTaskJsonObject, SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { describe, expect, it } from 'vitest';

import { readRelayRuntimeStatusData } from './relayRuntimeStatus';

function statusResult(data: SystemTaskJsonObject): SystemTaskResult {
    return {
        protocolVersion: 1,
        taskId: 'relay-status',
        ok: true,
        data,
    };
}

function statusData(overrides: SystemTaskJsonObject = {}): SystemTaskJsonObject {
    return {
        installed: false,
        dataPresent: false,
        relayUrl: 'http://127.0.0.1:43123',
        healthy: false,
        service: { active: null, enabled: null },
        ...overrides,
    };
}

describe('readRelayRuntimeStatusData', () => {
    it('fails closed when authoritative retained-data status is missing', () => {
        const { dataPresent: _omitted, ...withoutDataPresent } = statusData();

        expect(readRelayRuntimeStatusData(statusResult(withoutDataPresent))).toBeNull();
    });

    it('requires the runtime-owned loopback relayUrl instead of accepting a UI fallback', () => {
        expect(readRelayRuntimeStatusData(statusResult(statusData({ relayUrl: '' })))).toBeNull();

        expect(readRelayRuntimeStatusData(statusResult(statusData({
            relayUrl: 'https://home.example.test',
        })))).toBeNull();
    });

    it('rejects a Personal Home purpose whose canonical origin contradicts relayUrl', () => {
        expect(readRelayRuntimeStatusData(statusResult(statusData({
            purpose: {
                kind: 'personal-home',
                canonicalServerUrl: 'http://127.0.0.1:43124',
            },
        })))).toBeNull();
    });
});
