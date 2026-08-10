import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const routerPushSpy = vi.fn();
const flashListCompatMockState = vi.hoisted(() => ({
    mappingKeyCalls: [] as Array<Readonly<{ index: number; itemKey: string | number | bigint }>>,
}));
const sessionStoreState = vi.hoisted(() => ({
    sessions: {} as Record<string, { id: string; metadata: unknown } | undefined>,
}));

vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => 'tablet',
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    useMappingHelper: () => ({
        getMappingKey: (itemKey: string | number | bigint, index: number) => {
            flashListCompatMockState.mappingKeyCalls.push({ itemKey, index });
            return index;
        },
    }),
}));

vi.hoisted(async () => {
    const { installProjectFileLinkPickerCommonModuleMocks } = await import('@/components/sessions/linkedFiles/projectPicker/projectFileLinkPickerTestHelpers');

    installProjectFileLinkPickerCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                useWindowDimensions: () => ({ width: 1400, height: 900 }),
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            const expoRouterMock = createExpoRouterMock({
                router: { push: routerPushSpy },
            });
            return expoRouterMock.module;
        },
        storage: async () => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                useLocalSetting: (key: string) => {
                    if (key === 'uiMultiPanePanelsEnabled') return true;
                    if (key === 'detailsPaneTabsBehavior') return 'preview';
                    return undefined;
                },
                useSessionReferenceTarget: (sessionId: string) => {
                    const session = sessionStoreState.sessions[sessionId];
                    return session
                        ? { present: true, metadata: session.metadata }
                        : { present: false, metadata: null };
                },
            });
        },
    });

    return null;
});

describe('StructuredReferencesRow', () => {
    beforeEach(() => {
        flashListCompatMockState.mappingKeyCalls = [];
        sessionStoreState.sessions = {};
        routerPushSpy.mockClear();
    });

    it('routes reference chip keys through the FlashList mapping helper', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="s1"
                    references={[
                        { kind: 'file', path: 'src/api.ts' },
                        { kind: 'file', path: 'src/ui.ts' },
                    ]}
                    fileOpenEnabled
                />
            </AppPaneProvider>,
        );

        expect(flashListCompatMockState.mappingKeyCalls).toEqual([
            { itemKey: 'file:src/api.ts', index: 0 },
            { itemKey: 'file:src/ui.ts', index: 1 },
        ]);
    });

    it('opens details tab when multi-pane is available', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        let observedState: any = null;
        const Probe = () => {
            const { state } = useAppPaneContext();
            observedState = state;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="s1"
                    references={[{ kind: 'file', path: 'src/api.ts' }]}
                    fileOpenEnabled
                />
                <Probe />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).not.toHaveBeenCalled();
        const scope = observedState?.scopes?.['session:s1'];
        expect(scope?.details?.isOpen).toBe(true);
        expect(scope?.details?.tabs?.[0]?.key).toBe('file:src/api.ts');
        expect(scope?.details?.activeTabKey).toBe('file:src/api.ts');
    });

    it('renders linked files as inert metadata when file opening is not granted', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="public-session"
                    references={[{ kind: 'file', path: 'src/api.ts' }]}
                    fileOpenEnabled={false}
                />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip?.type).toBe('View');
        expect(fileChip?.props.accessibilityRole).toBe('text');
        expect(fileChip?.props.onPress).toBeUndefined();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('navigates to a referenced session and renders its CURRENT title after a rename', async () => {
        sessionStoreState.sessions['other-session'] = {
            id: 'other-session',
            metadata: { name: 'Renamed after the reference was composed', path: '/w' },
        };
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="s1"
                    references={[{ kind: 'session', sessionId: 'other-session', label: 'Title at compose time' }]}
                    fileOpenEnabled
                />
            </AppPaneProvider>,
        );

        const chip = screen.findByTestId('transcript-session-reference:other-session');
        expect(chip?.type).toBe('Pressable');
        expect(screen.getTextContent()).toContain('Renamed after the reference was composed');
        expect(screen.getTextContent()).not.toContain('Title at compose time');

        await pressTestInstanceAsync(chip!, 'transcript-session-reference:other-session');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/other-session');
    });

    it('keeps the composed label when a present session has no resolved metadata', async () => {
        // `Session['metadata']` is `Metadata | null`, and `getSessionName` answers
        // `t('status.unknown')` for a null one — a non-null string that would otherwise beat the
        // label the reference carries precisely so it can still say what it pointed at.
        sessionStoreState.sessions['unnamed-session'] = { id: 'unnamed-session', metadata: null };
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="s1"
                    references={[{ kind: 'session', sessionId: 'unnamed-session', label: 'Release prep' }]}
                    fileOpenEnabled
                />
            </AppPaneProvider>,
        );

        const chip = screen.findByTestId('transcript-session-reference:unnamed-session');
        expect(chip?.type).toBe('Pressable');
        expect(screen.getTextContent()).toContain('Release prep');
        expect(screen.getTextContent()).not.toContain('status.unknown');
    });

    it('renders an unavailable session reference inert instead of as a dead link', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="s1"
                    references={[{ kind: 'session', sessionId: 'deleted-session', label: 'Deleted work' }]}
                    fileOpenEnabled
                />
            </AppPaneProvider>,
        );

        const chip = screen.findByTestId('transcript-session-reference:deleted-session');
        expect(chip?.type).toBe('View');
        expect(chip?.props.accessibilityRole).toBe('text');
        expect(chip?.props.onPress).toBeUndefined();
        const rendered = screen.getTextContent();
        expect(rendered).toContain('Deleted work');
        expect(rendered).toContain('message.sessionReferenceUnavailable');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
