import { describe, expect, it, vi } from 'vitest';

import {
    readTriageAgentExecutionTargetV1,
    TRIAGE_AGENTS_BACKENDS_LIST_ACTION_ID_V1,
} from './agentTarget.js';

function hostReturning(result: unknown) {
    return { executeAction: vi.fn(async () => result) };
}

const CLAUDE = {
    targetKey: 'backend:claude',
    label: 'Claude Code',
    enabled: true,
    agentId: 'claude',
    identity: { pluginId: 'happier.claude', localId: 'claude' },
};

describe('the profile’s preferred agent, resolved through the host inventory', () => {
    /**
     * The whole point of the resolution: Triage never parses the backend-target
     * key. It hands the profile's stored key to the inventory that minted it and
     * takes back the identity that inventory resolved.
     */
    it('resolves the stored target key to the identity the inventory published', async () => {
        const host = hostReturning({ items: [{ ...CLAUDE, targetKey: 'backend:other' }, CLAUDE] });

        const resolved = await readTriageAgentExecutionTargetV1(host, 'backend:claude');

        expect(host.executeAction).toHaveBeenCalledWith(
            TRIAGE_AGENTS_BACKENDS_LIST_ACTION_ID_V1,
            {},
            undefined,
        );
        expect(resolved).toEqual({
            status: 'resolved',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
        });
    });

    /**
     * The key is compared exactly. Matching on a prefix, a label or an
     * `agentId` would be Triage inventing the grammar the key belongs to, and a
     * near-miss resolves a DIFFERENT agent rather than none.
     */
    it('matches the key exactly rather than by label or agent id', async () => {
        const host = hostReturning({ items: [CLAUDE] });

        await expect(readTriageAgentExecutionTargetV1(host, 'claude'))
            .resolves.toEqual({ status: 'unresolved' });
        await expect(readTriageAgentExecutionTargetV1(host, 'Claude Code'))
            .resolves.toEqual({ status: 'unresolved' });
    });

    /**
     * A disabled backend is not a place to start a Session unattended. The
     * reader is taken to the New Session surface instead, where the same
     * catalogue states why it is not offered.
     */
    it('does not resolve a disabled backend', async () => {
        const host = hostReturning({ items: [{ ...CLAUDE, enabled: false }] });

        await expect(readTriageAgentExecutionTargetV1(host, 'backend:claude'))
            .resolves.toEqual({ status: 'unresolved' });
    });

    /**
     * A configured ACP row is selectable by `backendId` and need not carry a
     * contribution identity. The start wire admits only the identity shape, so a
     * row without one resolves nothing rather than a fabricated target.
     */
    it('does not resolve a row that published no contribution identity', async () => {
        const host = hostReturning({ items: [{ targetKey: 'backend:acp', label: 'ACP', enabled: true }] });

        await expect(readTriageAgentExecutionTargetV1(host, 'backend:acp'))
            .resolves.toEqual({ status: 'unresolved' });
    });

    /**
     * "The catalogue says no" and "the catalogue never answered" are different
     * things: only the second one is worth retrying, and neither may be
     * reported as a resolved agent.
     */
    it('separates a catalogue that refused from one that answered', async () => {
        const rejecting = { executeAction: vi.fn(async () => { throw new Error('no'); }) };

        await expect(readTriageAgentExecutionTargetV1(rejecting, 'backend:claude'))
            .resolves.toEqual({ status: 'unavailable' });
        await expect(readTriageAgentExecutionTargetV1(hostReturning({ rows: [] }), 'backend:claude'))
            .resolves.toEqual({ status: 'unavailable' });
        await expect(readTriageAgentExecutionTargetV1(hostReturning({ items: [] }), 'backend:claude'))
            .resolves.toEqual({ status: 'unresolved' });
    });
});
