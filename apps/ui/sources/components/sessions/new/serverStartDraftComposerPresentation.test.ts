import { describe, expect, it, vi } from 'vitest';

const modal = vi.hoisted(() => ({
    show: vi.fn((_config: unknown) => 'server-start-draft-modal'),
    hide: vi.fn(),
}));

vi.mock('@/modal', () => ({ Modal: modal }));

import { presentSessionServerStartDraftComposer } from './serverStartDraftComposerPresentation';

const target = { serverId: 'server-1', machineId: 'machine-1' } as const;
const draft = {
    executionTarget: target,
    directory: '/workspace',
    agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    },
} as const;

type PresentedProps = Readonly<{
    onResolve: (value: unknown | null) => void;
}>;

function presentedConfig(): Readonly<{
    props: PresentedProps;
    onRequestClose: () => void;
    onHostUnmount: () => void;
}> {
    const config = modal.show.mock.calls.at(-1)?.[0];
    if (!config || typeof config !== 'object') throw new Error('expected Session composer modal');
    const record = config as Readonly<Record<string, unknown>>;
    if (!record.props || typeof record.props !== 'object') throw new Error('expected Session composer props');
    if (typeof record.onRequestClose !== 'function' || typeof record.onHostUnmount !== 'function') {
        throw new Error('expected Session composer lifecycle callbacks');
    }
    return {
        props: record.props as PresentedProps,
        onRequestClose: record.onRequestClose as () => void,
        onHostUnmount: record.onHostUnmount as () => void,
    };
}

describe('Session server-start draft composer presentation', () => {
    it('presents the Session-owned modal and resolves only its draft', async () => {
        const presentation = presentSessionServerStartDraftComposer({
            seed: { directory: '/workspace', agentId: 'claude' },
            target,
        });
        const shown = presentedConfig();

        expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({
            closeOnBackdrop: true,
            props: expect.objectContaining({
                seed: { directory: '/workspace', agentId: 'claude' },
                target,
            }),
        }));
        shown.props.onResolve(draft);

        await expect(presentation.result).resolves.toEqual(draft);
        expect(modal.hide).toHaveBeenCalledWith('server-start-draft-modal');
    });

    it('maps dismissal and host retirement to cancellation without a draft', async () => {
        const first = presentSessionServerStartDraftComposer({ seed: {}, target });
        presentedConfig().onRequestClose();
        await expect(first.result).resolves.toBeNull();

        const second = presentSessionServerStartDraftComposer({ seed: {}, target });
        presentedConfig().onHostUnmount();
        await expect(second.result).resolves.toBeNull();
    });
});
