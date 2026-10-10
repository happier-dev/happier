import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { SettingsPageSearchProvider } from '@/components/settings/shell/SettingsPageSearchContext';

import {
    renderScreen,
    type RenderScreenResult,
} from '../render/renderScreen';
import type { RenderWithAppProvidersOptions } from '../render/renderWithAppProviders';

export type SettingsViewHarness = RenderScreenResult & Readonly<{
    findRow: (testID: string) => ReactTestInstance | null;
    findRowByTitle: (title: string) => ReactTestInstance | null;
    listRows: (prefix: string) => ReactTestInstance[];
    findGroup: (title: string) => ReactTestInstance | null;
    pressRow: (testID: string) => void;
    pressRowByTitle: (title: string) => void;
}>;

function canPressNode(node: ReactTestInstance): boolean {
    return typeof node.props?.onPress === 'function' || typeof node.props?.onClick === 'function';
}

function findRowCandidateByTitle(
    screen: RenderScreenResult,
    title: string,
    interactiveOnly: boolean,
): ReactTestInstance | null {
    const matches = screen.findAll((node) => node.props?.title === title);
    const interactiveMatch = matches.find(canPressNode) ?? null;
    if (interactiveOnly) {
        return interactiveMatch;
    }
    return interactiveMatch ?? matches[0] ?? null;
}

export async function renderSettingsView(
    element: React.ReactElement,
    options: RenderWithAppProvidersOptions = {},
): Promise<SettingsViewHarness> {
    const CallerWrapper = options.wrapper;
    // The real Settings shell owns this query through leaf navigation and updates.
    function SettingsShellProviders({ children }: React.PropsWithChildren) {
        const content = React.createElement(SettingsPageSearchProvider, { children });
        return CallerWrapper ? React.createElement(CallerWrapper, null, content) : content;
    }
    const screen = await renderScreen(element, { ...options, wrapper: SettingsShellProviders });

    return {
        ...screen,
        findRow: (testID) => screen.findByTestId(testID),
        findRowByTitle: (title) => findRowCandidateByTitle(screen, title, false),
        listRows: (prefix) => screen.findAll((node) => (
            typeof node.props?.testID === 'string' && node.props.testID.startsWith(prefix)
        )),
        findGroup: (title) => screen.findAll((node) => node.props?.title === title)[0] ?? null,
        pressRow: (testID) => {
            screen.pressByTestId(testID);
        },
        pressRowByTitle: (title) => {
            const target = findRowCandidateByTitle(screen, title, true);
            if (!target) {
                throw new Error(`Unable to find settings row with title "${title}"`);
            }
            const handler = target.props.onPress ?? target.props.onClick;
            handler();
        },
    };
}
