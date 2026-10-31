import { describe, expect, it, vi } from 'vitest';

import type { SessionProviderInputOutcomeProducer } from '@/api/session/sessionClient';

import { createCodexAppServerProviderInputOutcomeBridge } from './codexAppServerProviderInputOutcome';

describe('createCodexAppServerProviderInputOutcomeBridge', () => {
    it('publishes exact provider acceptance with the Queue localId and Codex turn identity', () => {
        const observe = vi.fn();
        const bindProviderInputOutcomeProducer = vi.fn(
            (_producer: SessionProviderInputOutcomeProducer) => observe,
        );
        const bridge = createCodexAppServerProviderInputOutcomeBridge({
            bindProviderInputOutcomeProducer,
        }, {
            isCurrentRuntimeMode: () => true,
        });

        expect(bridge.observeAccepted({
            localIds: ['local-1'],
            providerTurnId: ' turn-1 ',
            appliedModelId: 'gpt-5.6-sol',
        })).toBe(true);
        expect(observe).toHaveBeenCalledWith({
            kind: 'accepted',
            localId: 'local-1',
            providerTurnId: 'turn-1',
            appliedModelId: 'gpt-5.6-sol',
            delivery: { kind: 'primary_turn' },
        });
        expect(bridge.observeAcceptedLocalInput({ localIds: ['local-command'], delivery: { kind: 'command' } })).toBe(true);
        expect(observe).toHaveBeenLastCalledWith({
            kind: 'accepted',
            localId: 'local-command',
            delivery: { kind: 'command' },
        });

        expect(bridge.observeAccepted({
            localIds: ['   '],
            providerTurnId: 'turn-2',
        })).toBe(false);

        const producer = bindProviderInputOutcomeProducer.mock.calls[0]?.[0];
        expect(producer).toMatchObject({ providerId: 'codex', mode: 'appServer' });
        expect(producer?.matchesCurrentSession({
            metadata: { flavor: 'codex' } as never,
        })).toBe(true);
        expect(producer?.matchesCurrentSession({
            metadata: { flavor: 'claude' } as never,
        })).toBe(false);
    });

    it('fails closed without one exact localId or provider turn identity', () => {
        const observe = vi.fn();
        const bridge = createCodexAppServerProviderInputOutcomeBridge({
            bindProviderInputOutcomeProducer: () => observe,
        }, { isCurrentRuntimeMode: () => true });

        expect(bridge.observeAccepted({
            localIds: ['local-1', 'local-2'],
            providerTurnId: 'turn-1',
        })).toBe(false);
        expect(bridge.observeAccepted({
            localIds: [''],
            providerTurnId: 'turn-1',
        })).toBe(false);
        expect(bridge.observeAccepted({
            localIds: ['   '],
            providerTurnId: 'turn-1',
        })).toBe(false);
        expect(bridge.observeAccepted({
            localIds: ['local-1'],
            providerTurnId: '   ',
        })).toBe(false);
        expect(bridge.observeAcceptedLocalInput({ localIds: [] })).toBe(false);
        expect(bridge.observeAcceptedLocalInput({ localIds: ['a', 'b'] })).toBe(false);
        expect(bridge.observeAcceptedLocalInput({ localIds: ['   '] })).toBe(false);
        expect(observe).not.toHaveBeenCalled();
    });
});
