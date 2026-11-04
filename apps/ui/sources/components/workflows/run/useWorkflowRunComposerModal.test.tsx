import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';

import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import type { WorkflowRunComposerModalProps } from './useWorkflowRunComposerModal';

const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => viewport });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Radix owns the DOM boundary; modal custody, chrome and composer logic stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
const { Popover } = await import('@/components/ui/popover/Popover');
const { WorkflowRunComposer } = await import('./WorkflowRunComposer');
const { useWorkflowRunComposerModal } = await import('./useWorkflowRunComposerModal');

type PresenterParams = Parameters<typeof useWorkflowRunComposerModal>[0];
type ModalEntries = ReturnType<typeof useModal>['state']['modals'];
const retirePresenters: Array<() => Promise<void>> = [];

function ObserveModals({ observe }: Readonly<{ observe: (entries: ModalEntries) => void }>) {
    observe(useModal().state.modals);
    return null;
}

function Presenter({ params, mountAnchor }: Readonly<{ params: PresenterParams; mountAnchor: boolean }>) {
    const presentation = useWorkflowRunComposerModal(params);
    return <>
        {mountAnchor ? <View ref={params.anchorRef} testID="workflow-start-opener" /> : null}
        {presentation}
    </>;
}

async function present(params: PresenterParams, mountAnchor = false) {
    let entries: ModalEntries = [];
    const observe = (next: ModalEntries) => { entries = next; };
    const element = (next: PresenterParams, mounted = true) => <ModalProvider>
        <ObserveModals observe={observe} />
        {mounted ? <Presenter params={next} mountAnchor={mountAnchor} /> : null}
    </ModalProvider>;
    // Mount the real owner before opening, as the application shell does.
    const screen = await renderScreen(element({ ...params, open: false }), {
        createNodeMock: (node) => node.props.testID === 'workflow-start-opener'
            ? { getBoundingClientRect: () => ({ left: 900, top: 100, width: 120, height: 40 }), focus: () => {} }
            : null,
    });
    await screen.update(element(params));
    const unmountPresenter = () => screen.update(element(params, false));
    retirePresenters.push(unmountPresenter);
    return {
        screen,
        visible: () => entries.filter((entry) => 'visible' in entry && entry.visible === true),
        update: (next: PresenterParams) => screen.update(element(next)),
        unmountPresenter,
    };
}

function sheetProps(overrides: Partial<WorkflowRunComposerModalProps> = {}): WorkflowRunComposerModalProps {
    return {
        inputs: [],
        values: {},
        onChangeValues: () => {},
        onRun: () => {},
        onCancel: () => {},
        pending: false,
        ...overrides,
    };
}

describe('useWorkflowRunComposerModal', () => {
    let restorePopoverGlobals: (() => void) | undefined;
    beforeEach(() => {
        restorePopoverGlobals = withPopoverWebGlobals();
    });
    afterEach(async () => {
        for (const retire of retirePresenters.splice(0)) await retire();
        await standardCleanup();
        restorePopoverGlobals?.();
        await home.reset();
        viewport.width = 1440;
    });

    it('uses one canonical phone sheet rather than a button-sized anchored popup', async () => {
        viewport.width = 390;
        const anchorRef = React.createRef<React.ElementRef<typeof View>>();
        const mounted = await present({ open: true, props: sheetProps(), anchorRef }, true);
        expect(anchorRef.current).not.toBeNull();
        expect(mounted.visible()).toHaveLength(1);
        expect(mounted.visible()[0]).toMatchObject({
            focusReturnRef: anchorRef,
            chrome: { phonePresentation: 'sheet', scrollHost: 'bounded', bodyScroll: 'none' },
        });
        expect(mounted.screen.findByType(ModalCardFrame).props.presentation).toBe('sheet');
        expect(mounted.screen.findAllByType(Popover)).toHaveLength(0);
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull();
    });

    it('hosts a wide anchored start in the shared returning sheet chrome', async () => {
        const anchorRef = React.createRef<React.ElementRef<typeof View>>();
        const mounted = await present({
            open: true, props: sheetProps(), anchorRef,
        }, true);
        expect(anchorRef.current).not.toBeNull();
        expect(mounted.visible()).toHaveLength(1);
        expect(mounted.visible()[0]).toMatchObject({ focusReturnRef: anchorRef,
            chrome: { phonePresentation: 'sheet', scrollHost: 'bounded', bodyScroll: 'none',
                anchor: { kind: 'view', ref: anchorRef } } });
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull();
    });

    it('uses the canonical modal when the anchoring trigger is not on screen', async () => {
        const anchorRef = React.createRef<React.ElementRef<typeof View>>();
        const mounted = await present({
            open: true, props: sheetProps(), anchorRef,
        });
        expect(anchorRef.current).toBeNull();
        expect(mounted.visible()).toHaveLength(1);
        expect(mounted.screen.findAllByType(Popover)).toHaveLength(0);
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull();
    });

    it('presents through the canonical modal owner and updates in place instead of stacking', async () => {
        const mounted = await present({ open: true, props: sheetProps() });
        expect(mounted.visible()).toHaveLength(1);
        const id = mounted.visible()[0].id;
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        // A changed value must not open a second sheet over the first.
        await mounted.update({ open: true, props: sheetProps({ pending: true }) });
        expect(mounted.visible().map((entry) => entry.id)).toEqual([id]);
        expect(mounted.screen.findAllByType(WorkflowRunComposer)).toHaveLength(1);
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
    });

    it('presents nothing until the caller has both intent and a read definition', async () => {
        const mounted = await present({ open: false, props: sheetProps() });
        expect(mounted.visible()).toHaveLength(0);
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')).toBeNull();
        await mounted.update({ open: true, props: null });
        expect(mounted.visible()).toHaveLength(0);
        expect(mounted.screen.findHostByTestId('workflow-run-inputs-run')).toBeNull();
    });

    it('hides the sheet when the caller closes it and when the surface unmounts', async () => {
        const mounted = await present({ open: true, props: sheetProps() });
        expect(mounted.visible()).toHaveLength(1);
        const initialId = mounted.visible()[0].id;
        await mounted.update({ open: false, props: sheetProps() });
        expect(mounted.visible()).toHaveLength(0);
        // Reopening presents again rather than reusing a hidden id.
        await mounted.update({ open: true, props: sheetProps() });
        expect(mounted.visible()).toHaveLength(1);
        expect(mounted.visible()[0].id).not.toBe(initialId);
        await mounted.unmountPresenter();
        expect(mounted.visible()).toHaveLength(0);
    });
});
