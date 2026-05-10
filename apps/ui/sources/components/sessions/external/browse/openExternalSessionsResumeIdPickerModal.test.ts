import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());
const webPortalTarget = vi.hoisted(() => ({ tag: 'resume-browse-parent-modal-target' } as unknown as Element));

type CapturedConfig = Readonly<{
    webPortalTarget?: unknown;
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
            viewportMargin?: number | Readonly<{ horizontal?: number; vertical?: number }>;
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

vi.mock('./ExternalSessionsResumeIdPickerModal', () => ({
    ExternalSessionsResumeIdPickerModal: () => null,
}));

describe('openExternalSessionsResumeIdPickerModal', () => {
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

        const { openExternalSessionsResumeIdPickerModal } = await import('./openExternalSessionsResumeIdPickerModal');

        const promise = openExternalSessionsResumeIdPickerModal({
            lockScope: {
                machineId: 'machine_1',
                serverId: 'server_1',
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
            },
            title: 'Browse Codex sessions',
            webPortalTarget,
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
        }));
        expect(config.webPortalTarget).toBe(webPortalTarget);
        expect(config.chrome.dimensions).toEqual({
            width: 720,
            maxHeightRatio: 0.96,
            size: 'lg',
            viewportMargin: { horizontal: 12, vertical: 12 },
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
