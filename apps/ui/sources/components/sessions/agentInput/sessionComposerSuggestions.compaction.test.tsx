import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAgentSessionCompactionCapability } from '@happier-dev/agents';

import { renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { useSessionComposerSuggestions } from './useSessionComposerSuggestions';
import { resolveSessionComposerSuggestions } from './sessionComposerSuggestions';

describe('Session composer manual compaction suggestions', () => {
    afterEach(() => storage.setState({ sessions: {} }));

    it('reads only the live publication at query time for sibling composers without a descriptor input', async () => {
        const query = () => resolveSessionComposerSuggestions('s1', '/compact', {
            kinds: ['slashCommand'], signal: new AbortController().signal,
        });
        const publish = (metadata: unknown) => {
            // Storage boundary fixture supplies only the metadata this owner reads.
            storage.setState({ sessions: { s1: { metadata } } } as any);
        };
        publish({ flavor: 'claude', agentRuntimeCapabilitiesV1: { sessionCapabilities: {
            compaction: { events: true, manual: true },
        } } });
        expect((await query()).filter(row => row.text === '/compact')).toHaveLength(1);
        expect((await resolveSessionComposerSuggestions('s1', '/compact', {
            kinds: ['slashCommand'], signal: new AbortController().signal, compaction: null,
        })).some(row => row.text === '/compact')).toBe(false);
        publish({ flavor: 'claude' });
        expect((await query()).some(row => row.text === '/compact')).toBe(false);
        publish({ slashCommands: ['compact'] });
        expect((await query()).filter(row => row.text === '/compact')).toHaveLength(1);
    });

    it('updates the real slash results with the opened runtime publication and preserves Agent commands', async () => {
        storage.setState({ sessions: {} });
        const actionController = { listSlashCommands: () => [] };
        const readCompaction = (metadata: unknown) => evaluateAgentSessionCompactionCapability({
            agentId: 'claude', metadata, declaredCapability: null,
        });
        const options = {
            sessionId: 's1', kinds: ['slashCommand'] as const,
            composerReferenceHost: null, actionController, skillSource: null,
        };
        const hook = await renderHook(({ metadata }: { metadata: unknown }) => useSessionComposerSuggestions({
            ...options, compaction: readCompaction(metadata),
        }), { initialProps: { metadata: null as unknown } });
        try {
            const query = () => hook.getCurrent()['/']('/compact', new AbortController().signal, () => {});
            expect((await query()).some(row => row.text === '/compact')).toBe(false);
            await hook.rerender({ metadata: { agentRuntimeCapabilitiesV1: { sessionCapabilities: {
                compaction: { events: true, manual: true },
            } } } });
            expect((await query()).filter(row => row.text === '/compact')).toHaveLength(1);
            await hook.rerender({ metadata: { agentRuntimeCapabilitiesV1: { sessionCapabilities: {} } } });
            expect((await query()).some(row => row.text === '/compact')).toBe(false);
            // Storage boundary fixture supplies only the metadata this owner reads.
            storage.setState({ sessions: { s1: { metadata: { slashCommands: ['compact'] } } } } as any);
            expect((await query()).filter(row => row.text === '/compact')).toHaveLength(1);
        } finally {
            await hook.unmount();
        }
    });
});
