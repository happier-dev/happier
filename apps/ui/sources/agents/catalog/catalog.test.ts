import { describe, it, expect } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from './catalog';

describe('agents/catalog', () => {
    it('re-exports the UI-supported subset of shared agent ids', () => {
        expect(Array.from(SHARED_AGENT_IDS)).toEqual(expect.arrayContaining(Array.from(AGENT_IDS)));
        expect(AGENT_IDS.length).toBeLessThanOrEqual(SHARED_AGENT_IDS.length);
        expect(DEFAULT_AGENT_ID).toBe('claude');
    });

    it('composes core + ui + behavior for known agents', () => {
        for (const id of AGENT_IDS) {
            const core = getAgentCore(id);
            expect(core.id).toBe(id);
            expect(typeof core.displayNameKey).toBe('string');
            expect(typeof core.subtitleKey).toBe('string');
            expect(core.displayNameKey.startsWith('agentInput.')).toBe(true);
            expect(core.subtitleKey.length).toBeGreaterThan(0);
            expect(typeof core.cli.detectKey).toBe('string');
            expect(core.cli.detectKey.length).toBeGreaterThan(0);
            expect(typeof core.permissions.modeGroup).toBe('string');
            expect(typeof core.permissions.promptProtocol).toBe('string');
            expect(typeof core.availability.experimental).toBe('boolean');
        }
    });

    it('returns consistent core references for repeated lookups', () => {
        for (const id of AGENT_IDS) {
            expect(getAgentCore(id)).toBe(getAgentCore(id));
        }
    });

    it('writes vendor resume ids through the catalog metadata helper', async () => {
        const catalogModule = await import('./catalog') as typeof import('./catalog') & {
            writeAgentVendorResumeIdToMetadata?: (
                metadata: Record<string, unknown>,
                agentId: 'claude' | 'codex' | 'opencode',
                vendorResumeId: string,
            ) => Record<string, unknown>;
        };

        expect(catalogModule.writeAgentVendorResumeIdToMetadata).toBeTypeOf('function');
        expect(catalogModule.writeAgentVendorResumeIdToMetadata?.({ path: '/repo' }, 'codex', 'thread_123')).toEqual({
            path: '/repo',
            codexSessionId: 'thread_123',
        });
        expect(catalogModule.writeAgentVendorResumeIdToMetadata?.({ path: '/repo' }, 'opencode', 'op_ses_123')).toEqual({
            path: '/repo',
            opencodeSessionId: 'op_ses_123',
        });
    });
});
