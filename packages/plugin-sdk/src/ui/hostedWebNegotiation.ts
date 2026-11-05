import type { PluginUiHostApiWireEnvelopeV1 } from '@happier-dev/protocol/plugins/ui/client';

type NegotiationRequest = Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'negotiate' }>;
type NegotiationReply = Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'negotiated' }>;
type Listener = (message: unknown) => void;
type Negotiation = {
    listeners: Set<Listener>;
    reply?: NegotiationReply;
};

/** One document transport, with independent opening contracts for its SDK copies. */
export function createHostedWebNegotiation() {
    const unassigned = new Set<Listener>();
    const byRange = new Map<string, Negotiation>();
    const bySequence = new Map<number, Negotiation>();
    const byListener = new Map<Listener, Negotiation>();
    return {
        add(listener: Listener) { unassigned.add(listener); },
        remove(listener: Listener) {
            unassigned.delete(listener);
            byListener.delete(listener);
            for (const negotiation of byRange.values()) negotiation.listeners.delete(listener);
        },
        request(request: NegotiationRequest): boolean {
            const previous = byRange.get(request.apiRange);
            const negotiation: Negotiation = previous ?? { listeners: new Set<Listener>() };
            byRange.set(request.apiRange, negotiation);
            const attaching = [...unassigned];
            unassigned.clear();
            for (const listener of attaching) {
                negotiation.listeners.add(listener);
                byListener.set(listener, negotiation);
                if (negotiation.reply) listener(negotiation.reply);
            }
            return previous === undefined;
        },
        bindSequence(range: string, sequence: number) {
            const negotiation = byRange.get(range);
            if (!negotiation) throw new TypeError('A hosted negotiation must be registered before dispatch.');
            bySequence.set(sequence, negotiation);
        },
        isPending(sequence: number) { return bySequence.has(sequence); },
        versionFor(listener: Listener) { return byListener.get(listener)?.reply?.apiVersion; },
        deliver(reply: NegotiationReply, sequence: number | undefined): boolean {
            if (sequence === undefined) return false;
            const negotiation = bySequence.get(sequence);
            if (!negotiation || negotiation.reply) return false;
            bySequence.delete(sequence);
            negotiation.reply = reply;
            for (const listener of negotiation.listeners) listener(reply);
            return true;
        },
    };
}
