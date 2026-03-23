import { describe, expect, it } from 'vitest';

import type { McpServersSettingsV1 } from '@happier-dev/protocol';

import { normalizeMcpServersSettingsV1 } from './normalizeMcpServersSettingsV1';

describe('normalizeMcpServersSettingsV1', () => {
    it('drops bindings that reference missing servers', () => {
        const settings: McpServersSettingsV1 = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 's1',
                    name: 'foo',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            bindings: [
                { id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 },
                { id: 'b2', serverId: 'missing', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 },
            ],
        };

        const normalized = normalizeMcpServersSettingsV1(settings);
        expect(normalized.bindings.map((b) => b.id)).toEqual(['b1']);
    });
});

