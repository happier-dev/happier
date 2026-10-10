import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

const { PageHeader, NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
const { NavigationBackChromeProvider } = await import('@/components/ui/layout/NavigationBackChrome');

function BackArrow() {
    return React.createElement('BackArrow');
}

async function renderHeader(params: Readonly<{ chromeShowsTitle?: boolean; alwaysShowTitle?: boolean; description?: string }>) {
    const header = (
        <NavigationBackChromeProvider control={BackArrow}>
            <PageHeader
                testID="page-header"
                title="Providers"
                description={params.description}
                alwaysShowTitle={params.alwaysShowTitle}
            />
        </NavigationBackChromeProvider>
    );
    return renderScreen(params.chromeShowsTitle === undefined
        ? header
        : <NavigationTitleChromeProvider showsTitle={params.chromeShowsTitle}>{header}</NavigationTitleChromeProvider>);
}

function visibleTexts(screen: Awaited<ReturnType<typeof renderHeader>>): string[] {
    return screen.root
        .findAll((node: ReactTestInstance) => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map((node) => node.props.children as string);
}

function headings(screen: Awaited<ReturnType<typeof renderHeader>>): string[] {
    return screen.root
        .findAll((node: ReactTestInstance) => typeof node.type === 'string' && node.props.accessibilityRole === 'header')
        .map((node) => String(node.props.children));
}

describe('PageHeader title and navigation chrome (R2)', () => {
    it('keeps explicitly page-owned entity actions visible and usable beneath phone title chrome', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle>
            <PageHeader testID="entity-header" title="Notes" alwaysShowTitle actionsPlacement="page"
                actions={React.createElement('EntityAction', { testID: 'entity-action', onPress })} />
        </NavigationTitleChromeProvider>);
        expect(screen.findAllByType('EntityAction' as never)).toHaveLength(1);
        await screen.pressByTestIdAsync('entity-action');
        expect(onPress).toHaveBeenCalledOnce();
    });

    it('shows the title, its back arrow and the purpose when no navigation header shows the title', async () => {
        const screen = await renderHeader({ description: 'Where your models come from.' });
        expect(headings(screen)).toEqual(['Providers']);
        expect(visibleTexts(screen)).toContain('Where your models come from.');
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
    });

    it('shows only the purpose when the native header already shows the title', async () => {
        const screen = await renderHeader({ chromeShowsTitle: true, description: 'Where your models come from.' });
        expect(headings(screen)).toEqual([]);
        expect(visibleTexts(screen)).toEqual(['Where your models come from.']);
        // The native header owns back as well; the page does not add a second arrow.
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(0);
    });

    it('keeps the title of an entity page that asks for it even under a native title', async () => {
        const screen = await renderHeader({ chromeShowsTitle: true, alwaysShowTitle: true, description: 'Claude Code' });
        expect(headings(screen)).toEqual(['Providers']);
        // The entity's editable identity is not a second navigation header.
        const header = screen.findHostByTestId('page-header')!;
        await act(async () => header.props.onLayout?.({ nativeEvent: { layout: { width: 390, height: 100, x: 0, y: 0 } } }));
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(0);
    });

    it('leaves generic navigation identity intact for an inline entity title', async () => {
        const setTitle = vi.fn();
        await renderScreen(<NavigationTitleChromeProvider showsTitle publisher={{ setTitle, setBack: () => {} }}>
            <PageHeader title="Release" alwaysShowTitle titleEditor={{ value: 'Release', placeholder: 'Name',
                accessibilityLabel: 'Name', onChangeText: () => {} }} />
        </NavigationTitleChromeProvider>);
        expect(setTitle).not.toHaveBeenCalledWith(null);
    });
    it('keeps a deep-linked entity Back when title chrome has no navigation Back', async () => {
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle showsBack={false}>
            <NavigationBackChromeProvider control={BackArrow}><PageHeader testID="page-header" title="Release" alwaysShowTitle /></NavigationBackChromeProvider>
        </NavigationTitleChromeProvider>);
        await act(async () => screen.findHostByTestId('page-header')!.props.onLayout?.({ nativeEvent: { layout: { width: 390, height: 100, x: 0, y: 0 } } }));
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
    });

    it('renders nothing when the native header shows the title and the page has nothing else to say', async () => {
        const screen = await renderHeader({ chromeShowsTitle: true });
        expect(screen.root.findAll((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === 'page-header')).toHaveLength(0);
    });

    it('edits an entity name and description inline, in the page even under a native title', async () => {
        const onChangeTitle = vi.fn();
        const onChangeDescription = vi.fn();
        const onCommitTitle = vi.fn();
        function Harness() {
            const [title, setTitle] = React.useState('Release');
            return (
                <NavigationTitleChromeProvider showsTitle>
                    <PageHeader
                        testID="page-header"
                        title={title}
                        alwaysShowTitle
                        titleEditor={{
                            value: title,
                            placeholder: 'Untitled workflow',
                            accessibilityLabel: 'Workflow name',
                            onChangeText: (next) => { onChangeTitle(next); setTitle(next.trim()); },
                            onCommit: onCommitTitle,
                            testID: 'page-header-title-input',
                        }}
                        descriptionEditor={{
                            value: '',
                            placeholder: 'Add a description',
                            accessibilityLabel: 'Description',
                            onChangeText: onChangeDescription,
                            testID: 'page-header-description-input',
                        }}
                    />
                </NavigationTitleChromeProvider>
            );
        }
        const screen = await renderScreen(<Harness />);
        const titleInput = () => screen.root.findAll((node: ReactTestInstance) => node.props.testID === 'page-header-title-input' && typeof node.props.onChangeText === 'function')[0]!;
        const descriptionInput = screen.root.findAll((node: ReactTestInstance) => node.props.testID === 'page-header-description-input' && typeof node.props.onChangeText === 'function')[0]!;
        // Identity stays editable in the page, and is still the page heading.
        expect(titleInput().props.value).toBe('Release');
        expect(titleInput().props.placeholder).toBe('Untitled workflow');
        expect(descriptionInput.props.placeholder).toBe('Add a description');
        expect(descriptionInput.props.multiline).toBe(true);

        await act(async () => { titleInput().props.onFocus?.({ nativeEvent: {} }); });
        await act(async () => { titleInput().props.onChangeText('Release '); });
        // A normalized owner echo must not eat the space needed for the next word.
        expect(titleInput().props.value).toBe('Release ');
        await act(async () => { titleInput().props.onChangeText('Release 0.3'); });
        expect(titleInput().props.value).toBe('Release 0.3');
        // Escape restores the name held when editing began.
        await act(async () => {
            titleInput().props.onKeyPress?.({ nativeEvent: { key: 'Escape' }, preventDefault: () => {} });
        });
        expect(onChangeTitle).toHaveBeenLastCalledWith('Release');
        expect(titleInput().props.value).toBe('Release');
        await act(async () => { titleInput().props.onBlur(); });
        expect(onCommitTitle).toHaveBeenCalled();
        onCommitTitle.mockClear();
        await act(async () => { titleInput().props.onFocus(); });
        await act(async () => { titleInput().props.onChangeText('Release candidate '); });
        expect(titleInput().props.value).toBe('Release candidate ');
        await act(async () => { titleInput().props.onBlur(); });
        expect(titleInput().props.value).toBe('Release candidate');
        expect(onCommitTitle).toHaveBeenCalledOnce();
        onCommitTitle.mockClear();
        // Enter during composition belongs to the input method, not the commit action.
        const compositionPreventDefault = vi.fn();
        await act(async () => {
            titleInput().props.onKeyPress?.({ nativeEvent: { key: 'Enter', isComposing: true }, preventDefault: compositionPreventDefault });
        });
        expect(compositionPreventDefault).not.toHaveBeenCalled();
        expect(onCommitTitle).not.toHaveBeenCalled();
        // Enter commits rather than inserting a newline into a name.
        const preventDefault = vi.fn();
        await act(async () => {
            titleInput().props.onKeyPress?.({ nativeEvent: { key: 'Enter' }, preventDefault });
        });
        expect(preventDefault).toHaveBeenCalled();
        expect(onCommitTitle).toHaveBeenCalledOnce();
        expect(onChangeTitle).not.toHaveBeenCalledWith(expect.stringContaining('\n'));
    });
});
