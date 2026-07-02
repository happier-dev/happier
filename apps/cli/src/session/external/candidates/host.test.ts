import { describe, expect, it } from 'vitest';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import {
    createExternalSessionCandidateHostService,
    type ExternalSessionCandidateHostAdapter,
} from './host';

const source = {
    kind: 'codexHome',
    home: 'user',
    homePath: '/home/user/.codex',
} satisfies ExternalSessionsSource;

describe('external-session candidate host service', () => {
    it('delegates candidate listing through the matching provider adapter', async () => {
        const calls: unknown[] = [];
        const adapter: ExternalSessionCandidateHostAdapter = {
            providerId: 'codex',
            listViaChildHost: async (input) => {
                calls.push(input);
                return {
                    candidates: [{
                        remoteSessionId: 'codex-session-1',
                        title: 'Codex session',
                        createdAtMs: 1,
                        updatedAtMs: 2,
                        archived: false,
                        details: { cwd: '/repo/project' },
                    }],
                    nextCursor: 'next-cursor',
                    searchIncomplete: true,
                };
            },
        };
        const service = createExternalSessionCandidateHostService({ adapters: [adapter] });
        expect(Object.isFrozen(service)).toBe(true);

        await expect(service.listViaChildHost({
            providerId: 'codex',
            source,
            cursor: 'cursor-1',
            limit: 25,
            searchTerm: 'project',
            searchMode: 'full',
        })).resolves.toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'codex-session-1' })],
            nextCursor: 'next-cursor',
            searchIncomplete: true,
        });
        expect(calls).toEqual([{
            providerId: 'codex',
            source,
            cursor: 'cursor-1',
            limit: 25,
            searchTerm: 'project',
            searchMode: 'full',
        }]);
    });

    it('fails closed when no candidate adapter owns the provider', async () => {
        const service = createExternalSessionCandidateHostService({ adapters: [] });

        await expect(service.listViaChildHost({
            providerId: 'codex',
            source,
            limit: 10,
        })).rejects.toThrow(/candidate host adapter/i);
    });
});
