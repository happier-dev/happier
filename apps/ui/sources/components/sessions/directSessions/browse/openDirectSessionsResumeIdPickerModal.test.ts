import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());

type CapturedConfig = Readonly<{
    chrome: Readonly<{
        kind: 'card';
        title?: string;
        subtitle?: string;
        testID?: string;
        layout?: 'fit' | 'fill';
        dimensions?: Readonly<{
            width: number;
            maxHeightRatio: number;
            size?: string;
        }>;
    }>;
    onRequestClose?: () => void;
    closeOnBackdrop?: boolean;
    props: Readonly<{
        lockScope: Readonly<{
            machineId: string;
            serverId?: string | null;
            providerId: string;
            source: unknown;
        }>;
        onResolve: (value: string | null) => void;
    }>;
}>;

function assertCapturedConfig(value: CapturedConfig | null): asserts value is CapturedConfig {
    if (value == null) {
        throw new Error('expected the modal config to be captured');
    }
}

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: unknown) => showMock(config),
        },
    }).module;
});

vi.mock('./DirectSessionsResumeIdPickerModal', () => ({
    DirectSessionsResumeIdPickerModal: () => null,
}));

describe('openDirectSessionsResumeIdPickerModal', () => {
    beforeEach(() => {
        showMock.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('opens the browse modal with fixed chrome and resolves the selected session id', async () => {
        let capturedConfig: CapturedConfig | null = null;
        showMock.mockImplementation((config: unknown) => {
            capturedConfig = config as CapturedConfig;
            return 'modal_1';
        });

        const { openDirectSessionsResumeIdPickerModal } = await import('./openDirectSessionsResumeIdPickerModal');

        const promise = openDirectSessionsResumeIdPickerModal({
            lockScope: {
                machineId: 'machine_1',
                serverId: 'server_1',
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
            },
            title: 'Browse Codex sessions',
        });

        await vi.waitFor(() => {
            expect(capturedConfig).not.toBeNull();
        });

        assertCapturedConfig(capturedConfig);
        const config = capturedConfig as CapturedConfig;

        expect(config.chrome).toEqual(expect.objectContaining({
            kind: 'card',
            title: 'Browse Codex sessions',
            testID: 'resume-id-browse-modal',
            layout: 'fill',
        }));
        expect(config.chrome.dimensions).toEqual({
            width: 560,
            maxHeightRatio: 0.92,
            size: 'md',
        });
        expect(config.closeOnBackdrop).toBe(true);
        expect(config.props.lockScope).toEqual({
            machineId: 'machine_1',
            serverId: 'server_1',
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
        });

        config.props.onResolve('session_123');

        await expect(promise).resolves.toBe('session_123');
    });
});
