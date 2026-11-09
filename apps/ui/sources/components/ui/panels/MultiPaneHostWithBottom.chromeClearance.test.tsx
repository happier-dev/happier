import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MultiPaneHostWithBottom, type BottomPanePresentation } from './MultiPaneHostWithBottom';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { renderScreen, standardCleanup } from '@/dev/testkit';

function ClearanceProbe(props: Readonly<{ testID: string }>) {
    const clearance = useFloatingChromeClearance();
    return <View testID={props.testID} accessibilityLabel={String(clearance)} />;
}

async function clearances(bottomPresentation: BottomPanePresentation, withBottomPane = true) {
    const screen = await renderScreen(<SessionCockpitBottomChromeHeightContext.Provider value={84}>
        <MultiPaneHostWithBottom
            main={<ClearanceProbe testID="main-probe" />}
            rightPane={null}
            detailsPane={null}
            layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
            rightDockWidthPx={360}
            detailsDockWidthPx={520}
            onCloseRight={() => {}}
            onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}}
            onCommitDetailsDockWidthPx={() => {}}
            bottomPane={withBottomPane ? <ClearanceProbe testID="bottom-probe" /> : null}
            bottomPresentation={bottomPresentation}
            bottomDockHeightPx={320}
            bottomDockMinHeightPx={200}
            bottomDockMaxHeightPx={600}
            onCloseBottom={() => {}}
            onCommitBottomDockHeightPx={() => {}}
        />
    </SessionCockpitBottomChromeHeightContext.Provider>);
    const read = (testID: string) => screen.findByTestId(testID)?.props.accessibilityLabel ?? null;
    return { main: read('main-probe'), bottom: read('bottom-probe') };
}

describe('MultiPaneHostWithBottom floating chrome clearance', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('gives the page bottom to a docked bottom pane, so the region above it clears no floating tab bar', async () => {
        expect(await clearances('docked')).toEqual({ main: '0', bottom: '84' });
    });

    it('keeps the bar clearance above an overlay bottom pane and when no bottom pane is open', async () => {
        expect(await clearances('overlay')).toEqual({ main: '84', bottom: '84' });
        expect(await clearances('docked', false)).toEqual({ main: '84', bottom: null });
    });
});
