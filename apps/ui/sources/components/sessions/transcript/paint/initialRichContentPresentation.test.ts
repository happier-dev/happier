import { describe, expect, it, vi } from 'vitest';

import { createInitialRichContentPresentationController } from './initialRichContentPresentation';

describe('initial rich-content presentation controller', () => {
    it('joins producer terminality with a matching renderer settlement revision', () => {
        const controller = createInitialRichContentPresentationController({
            enabled: true,
            generation: 'session-a',
        });
        const mermaid = controller.boundary.registerProducer('mermaid');
        const pierre = controller.boundary.registerProducer('pierre');

        controller.closeDiscovery();
        expect(controller.getSnapshot()).toMatchObject({
            pendingProducerCount: 2,
            phase: 'waiting-producers',
        });

        mermaid.complete();
        pierre.complete();
        const rendererRequest = controller.getSnapshot();
        expect(rendererRequest.phase).toBe('waiting-renderer');

        controller.releaseAfterRendererSettlement({
            generation: rendererRequest.generation,
            revision: rendererRequest.revision,
        });
        expect(controller.getSnapshot().phase).toBe('released');
    });

    it('invalidates stale settlement callbacks when a producer registers late', () => {
        const controller = createInitialRichContentPresentationController({
            enabled: true,
            generation: 'session-a',
        });
        controller.closeDiscovery();
        const staleRequest = controller.getSnapshot();
        const lateProducer = controller.boundary.registerProducer('late-pierre');

        controller.releaseAfterRendererSettlement({
            generation: staleRequest.generation,
            revision: staleRequest.revision,
        });
        expect(controller.getSnapshot().phase).toBe('waiting-producers');

        lateProducer.complete();
        const currentRequest = controller.getSnapshot();
        controller.releaseAfterRendererSettlement({
            generation: currentRequest.generation,
            revision: currentRequest.revision,
        });
        expect(controller.getSnapshot().phase).toBe('released');
    });

    it('treats producer unmount as terminal and ignores stale generation callbacks', () => {
        const controller = createInitialRichContentPresentationController({
            enabled: true,
            generation: 'session-b',
        });
        const producer = controller.boundary.registerProducer('unmounted-mermaid');
        controller.closeDiscovery();
        producer.dispose();
        const request = controller.getSnapshot();

        controller.releaseAfterRendererSettlement({
            generation: 'session-a',
            revision: request.revision,
        });
        expect(controller.getSnapshot().phase).toBe('waiting-renderer');

        controller.releaseAfterRendererSettlement({
            generation: request.generation,
            revision: request.revision,
        });
        expect(controller.getSnapshot().phase).toBe('released');
    });

    it('never re-covers or re-registers work after release', () => {
        const controller = createInitialRichContentPresentationController({
            enabled: true,
            generation: 'session-a',
        });
        controller.closeDiscovery();
        const request = controller.getSnapshot();
        controller.releaseAfterRendererSettlement({
            generation: request.generation,
            revision: request.revision,
        });
        const listener = vi.fn();
        controller.subscribe(listener);

        const late = controller.boundary.registerProducer('post-release');
        late.complete();
        late.dispose();
        controller.closeDiscovery();

        expect(controller.getSnapshot().phase).toBe('released');
        expect(controller.boundary.presentationPending).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });
});
