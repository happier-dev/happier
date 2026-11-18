import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { SessionLifecycleWhen } from './sessionTriggerForm';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { SessionLifecycleFilterFields } = await import('./SessionLifecycleFilterFields');
afterEach(standardCleanup);

it('restores an empty Sentence snapshot after an invalid operand without leaving stale controls', async () => {
    let restore = () => {};
    let current: SessionLifecycleWhen = { kind: 'turnEnds' };
    function Habit() {
        const [when, setWhen] = React.useState<SessionLifecycleWhen>(current);
        current = when;
        restore = () => setWhen({ kind: 'turnEnds' });
        return <SessionLifecycleFilterFields when={when} onChange={setWhen} />;
    }
    const screen = await renderScreen(<Habit />);
    await screen.pressByTestIdAsync('automation-event-filter-add-clause');
    await act(async () => screen.findByTestId('automation-event-filter-clause-draft-0-value')?.props.onChangeText(''));
    expect(current).toMatchObject({ filterInvalid: true });
    await act(async () => restore());
    expect(current).not.toHaveProperty('filterInvalid');
    expect(screen.findByTestId('automation-event-filter-clause-draft-0-value')).toBeNull();
});
