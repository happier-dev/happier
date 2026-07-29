import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen, standardCleanup } from '@/dev/testkit';

const modalMock = vi.hoisted(() => {
    const show = vi.fn<(config: unknown) => string>((config) => {
        void config;
        return 'modal-id';
    });
    const hide = vi.fn();
    return {
        spies: { show, hide },
        module: {
            Modal: {
                show,
                hide,
                update: vi.fn(),
                hideAll: vi.fn(),
                alert: vi.fn(),
                alertAsync: vi.fn(),
                prompt: vi.fn(),
                confirm: vi.fn(),
            },
            useOptionalModal: () => ({
                state: { modals: [] },
                showModal: show,
                hideModal: hide,
                hideAllModals: vi.fn(),
                updateCustomModalProps: vi.fn(),
            }),
            ModalProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
        },
    };
});

vi.mock('@/modal', () => modalMock.module);

vi.mock('@/components/ui/motion', async () => {
    return {
        SlideTransitionSwitch: ({ children }: { children?: React.ReactNode }) => children ?? null,
    };
});

type MotionPreviewModule = Readonly<{
    MotionPreviewDevSection: React.ComponentType;
}>;

function isMotionPreviewModule(value: unknown): value is MotionPreviewModule {
    return (
        typeof value === 'object'
        && value !== null
        && typeof (value as { MotionPreviewDevSection?: unknown }).MotionPreviewDevSection === 'function'
    );
}

async function loadMotionPreviewModule(): Promise<MotionPreviewModule | null> {
    const modulePath = './MotionPreviewDevSection';
    const loaded: unknown = await import(modulePath).catch(() => null);
    return isMotionPreviewModule(loaded) ? loaded : null;
}

function resetMocks() {
    modalMock.spies.show.mockClear();
    modalMock.spies.hide.mockClear();
}

describe('MotionPreviewDevSection', () => {
    beforeEach(() => {
        resetMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the slide-variants entry row with a stable testID', async () => {
        const mod = await loadMotionPreviewModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const screen = await renderScreen(<mod.MotionPreviewDevSection />);
        expect(screen.findByTestId('dev-motion-preview-slide-variants')).toBeTruthy();
    });

    it('opens the variants preview modal when the entry row is pressed', async () => {
        const mod = await loadMotionPreviewModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const screen = await renderScreen(<mod.MotionPreviewDevSection />);

        pressTestInstance(
            screen.findByTestId('dev-motion-preview-slide-variants'),
            'slide variants preview',
        );

        expect(modalMock.spies.show).toHaveBeenCalledTimes(1);
        const config = modalMock.spies.show.mock.calls[0]?.[0] as Readonly<{
            component?: unknown;
            props?: Record<string, unknown>;
        }> | undefined;
        expect(config).toBeTruthy();
        expect(typeof (config?.props as { onClose?: unknown } | undefined)?.onClose).toBe('function');
    });

    it('advances and reverses the carousel preview from Continue and Back', async () => {
        const mod = await loadMotionPreviewModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const screen = await renderScreen(<mod.MotionPreviewDevSection />);
        pressTestInstance(
            screen.findByTestId('dev-motion-preview-slide-variants'),
            'open preview',
        );

        const config = modalMock.spies.show.mock.calls[0]?.[0] as Readonly<{
            component?: React.ComponentType<{ onClose: () => void }>;
            props?: Record<string, unknown>;
        }> | undefined;
        const ModalBody = config?.component;
        expect(ModalBody).toBeTruthy();
        if (!ModalBody) return;

        const modalScreen = await renderScreen(<ModalBody onClose={() => {}} />);

        const continueButton = modalScreen.findByTestId('dev-motion-preview-carousel-continue');
        expect(continueButton).toBeTruthy();
        const backButton = modalScreen.findByTestId('dev-motion-preview-carousel-back');
        expect(backButton).toBeTruthy();

        act(() => {
            pressTestInstance(continueButton, 'carousel continue');
        });
        expect(modalScreen.findByTestId('dev-motion-preview-carousel-title')?.props.children).toBe('Card 2');

        act(() => {
            pressTestInstance(backButton, 'carousel back');
        });
        expect(modalScreen.findByTestId('dev-motion-preview-carousel-title')?.props.children).toBe('Card 1');
    });
});
