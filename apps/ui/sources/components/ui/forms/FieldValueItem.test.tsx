import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const { useHappierFieldValueDraft } = await import('@happier-dev/plugin-ui/presentation');
const { FieldTextInput } = await import('./FieldTextInput');

afterEach(() => {
    standardCleanup();
});

async function renderField(props: Readonly<{
    value: string;
    kind?: 'text' | 'integer' | 'decimal';
    signed?: boolean;
    onCommit: (draft: string) => string | void;
}>) {
    const { FieldValueItem } = await import('./FieldValueItem');
    const Host = () => {
        const [value, setValue] = React.useState(props.value);
        return (
            <FieldValueItem
                title="Budget"
                value={value}
                kind={props.kind}
                signed={props.signed}
                fieldTestID="field"
                onCommit={(draft) => {
                    const shown = props.onCommit(draft);
                    setValue(typeof shown === 'string' ? shown : draft);
                    return shown;
                }}
            />
        );
    };
    return renderScreen(<Host />);
}

function field(screen: Awaited<ReturnType<typeof renderField>>) {
    return screen.findByTestId('field')!;
}

describe('FieldValueItem', () => {
    it('shows the acknowledged saved value when asynchronous acceptance follows the server update', async () => {
        let finish!: (accepted: boolean) => void;
        function Host({ value }: Readonly<{ value: string }>) {
            const field = useHappierFieldValueDraft({ value, onCommit: () => new Promise<boolean>(resolve => { finish = resolve; }) });
            return <FieldTextInput testID="acknowledged" accessibilityLabel="Limit" value={field.draft}
                onChangeText={field.change} onBlur={field.commit} />;
        }
        const screen = await renderScreen(<Host value="4" />);
        await act(async () => { screen.findByTestId('acknowledged')!.props.onChangeText('2'); });
        await act(async () => { screen.findByTestId('acknowledged')!.props.onBlur(); });
        await screen.update(<Host value="3" />);
        expect(screen.findByTestId('acknowledged')!.props.value).toBe('2');
        await act(async () => { finish(true); });
        expect(screen.findByTestId('acknowledged')!.props.value).toBe('3');

        await act(async () => { screen.findByTestId('acknowledged')!.props.onChangeText('5'); });
        await act(async () => { screen.findByTestId('acknowledged')!.props.onBlur(); });
        await act(async () => { screen.findByTestId('acknowledged')!.props.onChangeText('6'); });
        await act(async () => { finish(true); });
        expect(screen.findByTestId('acknowledged')!.props.value).toBe('6');
        await screen.update(<Host value="5" />);
        expect(screen.findByTestId('acknowledged')!.props.value).toBe('6');
    });
    it('lets a refused asynchronous settings Action retry the retained draft without duplicate submission', async () => {
        const { useHappierFieldValueDraft } = await import('@happier-dev/plugin-ui/presentation');
        const { FieldTextInput } = await import('./FieldTextInput');
        const attempts: string[] = [];
        let finish!: (accepted: boolean) => void;
        function Host({ value }: Readonly<{ value: string }>) {
            const field = useHappierFieldValueDraft({ value, onCommit: next => {
                attempts.push(next);
                return new Promise<boolean>(resolve => { finish = resolve; });
            } });
            return <FieldTextInput testID="retry" accessibilityLabel="Name" value={field.draft}
                onChangeText={field.change} onBlur={field.commit} onSubmitEditing={field.commit} />;
        }
        const screen = await renderScreen(<Host value="saved" />);
        await act(async () => { screen.findByTestId('retry')!.props.onChangeText('draft'); });
        await act(async () => { const props = screen.findByTestId('retry')!.props; props.onSubmitEditing(); props.onBlur(); });
        expect(attempts).toEqual(['draft']);
        await act(async () => { finish(false); });
        expect(screen.findByTestId('retry')!.props.value).toBe('draft');
        await act(async () => { screen.findByTestId('retry')!.props.onSubmitEditing(); });
        expect(attempts).toEqual(['draft', 'draft']);
        await act(async () => { finish(true); });
        await screen.update(<Host value="remote-after-acceptance" />);
        expect(screen.findByTestId('retry')!.props.value).toBe('remote-after-acceptance');
    });
    it('keeps a dirty draft across saved-value updates, cancels to the latest value, and submits only once before acknowledgement', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const saved: string[] = [];
        const render = (value: string) => <FieldValueItem title="Name" value={value} fieldTestID="draft"
            onCommit={next => { saved.push(next); }} />;
        const screen = await renderScreen(render('original'));
        await screen.update(render('remote-clean'));
        const input = () => screen.findByTestId('draft')!;
        expect(input().props.value).toBe('remote-clean');
        await act(async () => { input().props.onChangeText('mine'); });
        await screen.update(render('remote-dirty'));
        expect(input().props.value).toBe('mine');
        await act(async () => { input().props.onKeyPress({ nativeEvent: { key: 'Escape' } }); input().props.onBlur(); });
        expect(input().props.value).toBe('remote-dirty');
        expect(saved).toEqual([]);
        await act(async () => { input().props.onChangeText('submitted'); });
        await act(async () => { const props = input().props; props.onSubmitEditing(); props.onBlur(); });
        expect(saved).toEqual(['submitted']);
        await screen.update(render('submitted'));
        expect(input().props.value).toBe('submitted');
    });
    it('commits a controlled draft against its acknowledged value and stops after acknowledgement', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const saved: string[] = [];
        function Host() {
            const [value, setValue] = React.useState('old-command');
            const [committedValue, setCommittedValue] = React.useState('old-command');
            return <FieldValueItem title="Command" fieldTestID="controlled" value={value} committedValue={committedValue}
                onDraftChange={setValue} onCommit={next => { saved.push(next); setCommittedValue(next); }} />;
        }
        const screen = await renderScreen(<Host />);
        await act(async () => { screen.findByTestId('controlled')!.props.onChangeText('new-command'); });
        expect(saved).toEqual([]);
        await act(async () => { screen.findByTestId('controlled')!.props.onBlur(); });
        expect(saved).toEqual(['new-command']);
        await act(async () => { screen.findByTestId('controlled')!.props.onBlur(); });
        expect(saved).toEqual(['new-command']);
    });
    it('takes an explicit controlled reset while retaining a draft across baseline-only updates', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const saved: string[] = [];
        function Host({ acknowledged, discard = false }: Readonly<{ acknowledged: string; discard?: boolean }>) {
            const [value, setValue] = React.useState('old-command');
            return <FieldValueItem title="Command" fieldTestID="controlled-reset"
                value={discard ? acknowledged : value} committedValue={acknowledged}
                onDraftChange={setValue} onCommit={next => { saved.push(next); }} />;
        }
        const screen = await renderScreen(<Host acknowledged="old-command" />);
        const input = () => screen.findByTestId('controlled-reset')!;
        await act(async () => { input().props.onChangeText('local-command'); });
        await screen.update(<Host acknowledged="remote-command" />);
        expect(input().props.value).toBe('local-command');
        await screen.update(<Host acknowledged="remote-command" discard />);
        expect(input().props.value).toBe('remote-command');
        await act(async () => { input().props.onBlur(); });
        expect(saved).toEqual([]);
    });
    it('steps a numeric draft, keeps its units out of storage, and respects the owner bounds', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const saved: string[] = [];
        function Host() {
            const [value, setValue] = React.useState('2');
            return <FieldValueItem title="Messages" value={value} kind="integer" unit="messages"
                stepper={{ min: 1, max: 3, step: 1 }} fieldTestID="count"
                onCommit={(next) => { saved.push(next); setValue(next); return next; }} />;
        }
        const screen = await renderScreen(<Host />);
        await act(async () => { screen.findByTestId('count.increment')!.props.onPress(); });
        expect(saved).toEqual(['3']);
        expect(screen.findByTestId('count.increment')!.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('count.decrement')!.props.onPress(); });
        expect(saved).toEqual(['3', '2']);
        await act(async () => { screen.findByTestId('count')!.props.onChangeText('1'); });
        await act(async () => { screen.findByTestId('count')!.props.onBlur(); });
        await act(async () => { screen.findByTestId('count.decrement')!.props.onPress(); });
        expect(saved.at(-1)).toBe('1');
        expect(screen.findByTestId('count.decrement')!.props.disabled).toBe(true);
    });
    it('keeps stepping and typing through the same draft owner when the stepper is compact', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const saved: string[] = [];
        function Host() {
            const [value, setValue] = React.useState('5');
            return <FieldValueItem title="Pause after" value={value} kind="integer" compactStepper
                stepper={{ min: 1, step: 1 }} fieldTestID="pause"
                onCommit={(next) => { saved.push(next); setValue(next); return next; }} />;
        }
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('pause')!.props.value).toBe('5');
        await act(async () => { screen.findByTestId('pause.increment')!.props.onPress(); });
        await act(async () => { screen.findByTestId('pause')!.props.onChangeText('9'); });
        await act(async () => { screen.findByTestId('pause')!.props.onBlur(); });
        expect(saved).toEqual(['6', '9']);
    });
    it('commits the typed value when focus leaves the field, not on every keystroke', async () => {
        const onCommit = vi.fn();
        const screen = await renderField({ value: 'claude', onCommit });

        await act(async () => { field(screen).props.onChangeText('codex'); });
        expect(onCommit).not.toHaveBeenCalled();
        expect(field(screen).props.value).toBe('codex');

        await act(async () => { field(screen).props.onBlur(); });
        expect(onCommit).toHaveBeenCalledWith('codex');
    });

    it('does not commit an unchanged value', async () => {
        const onCommit = vi.fn();
        const screen = await renderField({ value: 'claude', onCommit });
        await act(async () => { field(screen).props.onSubmitEditing(); });
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('keeps whole numbers to digits and returns an empty number to the saved value', async () => {
        const onCommit = vi.fn();
        const screen = await renderField({ value: '250', kind: 'integer', onCommit });

        await act(async () => { field(screen).props.onChangeText('12a3'); });
        expect(field(screen).props.value).toBe('123');

        await act(async () => { field(screen).props.onChangeText(''); });
        await act(async () => { field(screen).props.onBlur(); });
        expect(onCommit).not.toHaveBeenCalled();
        expect(field(screen).props.value).toBe('250');
    });

    it('shows the value the owner settled on, even when it equals the saved one (a number moved back to its bound)', async () => {
        const screen = await renderField({ value: '50000', kind: 'integer', onCommit: () => '50000' });
        await act(async () => { field(screen).props.onChangeText('999999'); });
        await act(async () => { field(screen).props.onBlur(); });
        expect(field(screen).props.value).toBe('50000');
    });

    it('keeps a leading minus only on a signed number', async () => {
        const onCommit = vi.fn();
        const unsigned = await renderField({ value: '0', kind: 'decimal', onCommit });
        await act(async () => { field(unsigned).props.onChangeText('-2.5'); });
        expect(field(unsigned).props.value).toBe('2.5');
        standardCleanup();

        const signed = await renderField({ value: '0', kind: 'decimal', signed: true, onCommit });
        await act(async () => { field(signed).props.onChangeText('-2.-5'); });
        expect(field(signed).props.value).toBe('-2.5');
        await act(async () => { field(signed).props.onBlur(); });
        expect(onCommit).toHaveBeenCalledWith('-2.5');
    });

    // The row's description (a number's bounds, what the value means) is beside the field, not
    // attached to it, so a screen reader focused on the field would hear only its name.
    it('describes the field with the row subtitle for assistive technology', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const screen = await renderScreen(
            <FieldValueItem title="Budget" subtitle="Between 1024 and 200000" value="4" kind="integer" fieldTestID="field" onCommit={vi.fn()} />,
        );

        expect(screen.findByTestId('field')!.props.accessibilityLabel).toBe('Budget');
        expect(screen.findByTestId('field')!.props.accessibilityHint).toBe('Between 1024 and 200000');
    });

    it('reports each typed draft, as the field keeps it, before anything commits', async () => {
        const { FieldValueItem } = await import('./FieldValueItem');
        const onDraftChange = vi.fn();
        const onCommit = vi.fn();
        const screen = await renderScreen(
            <FieldValueItem title="Limit" value="4" kind="integer" fieldTestID="field" onCommit={onCommit} onDraftChange={onDraftChange} />,
        );

        await act(async () => { screen.findByTestId('field')!.props.onChangeText('1a2'); });
        expect(onDraftChange).toHaveBeenLastCalledWith('12');
        expect(onCommit).not.toHaveBeenCalled();
    });
});
