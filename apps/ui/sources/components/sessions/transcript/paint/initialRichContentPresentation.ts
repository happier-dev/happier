import type {
    InitialPresentationProducerHandle,
    InitialPresentationReadinessBoundary,
} from '@/components/ui/presentation/InitialPresentationReadinessContext';

export type InitialRichContentPresentationPhase =
    | 'collecting'
    | 'waiting-producers'
    | 'waiting-renderer'
    | 'released';

export type InitialRichContentPresentationSnapshot = Readonly<{
    generation: string;
    pendingProducerCount: number;
    phase: InitialRichContentPresentationPhase;
    revision: number;
}>;

export type InitialRichContentPresentationController = Readonly<{
    boundary: InitialPresentationReadinessBoundary;
    closeDiscovery: () => void;
    getSnapshot: () => InitialRichContentPresentationSnapshot;
    releaseAfterRendererSettlement: (request: Readonly<{
        generation: string;
        revision: number;
    }>) => void;
    subscribe: (listener: () => void) => () => void;
}>;

export function createInitialRichContentPresentationController(params: Readonly<{
    enabled: boolean;
    generation: string;
}>): InitialRichContentPresentationController {
    const listeners = new Set<() => void>();
    const pendingProducers = new Set<symbol>();
    let discoveryClosed = !params.enabled;
    let revision = 0;
    let phase: InitialRichContentPresentationPhase = params.enabled ? 'collecting' : 'released';
    let snapshot: InitialRichContentPresentationSnapshot = {
        generation: params.generation,
        pendingProducerCount: 0,
        phase,
        revision,
    };

    const publish = (nextPhase: InitialRichContentPresentationPhase): void => {
        if (phase === 'released') return;
        phase = nextPhase;
        revision += 1;
        snapshot = {
            generation: params.generation,
            pendingProducerCount: pendingProducers.size,
            phase,
            revision,
        };
        for (const listener of listeners) listener();
    };

    const reconcile = (): void => {
        if (phase === 'released') return;
        if (!discoveryClosed) {
            publish('collecting');
            return;
        }
        publish(pendingProducers.size > 0 ? 'waiting-producers' : 'waiting-renderer');
    };

    const registerProducer = (_producerKey: string): InitialPresentationProducerHandle => {
        if (phase === 'released') {
            return { complete: () => {}, dispose: () => {} };
        }
        const token = Symbol();
        let active = true;
        pendingProducers.add(token);
        reconcile();
        const settle = () => {
            if (!active) return;
            active = false;
            if (!pendingProducers.delete(token)) return;
            reconcile();
        };
        return {
            complete: settle,
            dispose: settle,
        };
    };

    const boundary: InitialPresentationReadinessBoundary = {
        get presentationPending() {
            return phase !== 'released';
        },
        registerProducer,
    };

    return {
        boundary,
        closeDiscovery: () => {
            if (phase === 'released' || discoveryClosed) return;
            discoveryClosed = true;
            reconcile();
        },
        getSnapshot: () => snapshot,
        releaseAfterRendererSettlement: (request) => {
            if (
                phase !== 'waiting-renderer'
                || request.generation !== params.generation
                || request.revision !== revision
            ) return;
            phase = 'released';
            revision += 1;
            snapshot = {
                generation: params.generation,
                pendingProducerCount: 0,
                phase,
                revision,
            };
            for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
