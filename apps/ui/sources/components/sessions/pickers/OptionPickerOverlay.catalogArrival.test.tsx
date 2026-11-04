import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

// Imported once at collection, not inside the test: transforming the picker's import graph is not part
// of the behavior under test and, cold or under load, it alone outran the 60 s test timeout.
const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

const readCustomValue = (value: string) => value;

it('settles an asynchronously listed selected value in the catalog-arrival commit', async () => {
    let publishCatalog: (() => void) | undefined;
    let commitCount = 0;

    function Host() {
        const [options, setOptions] = React.useState<ReadonlyArray<{ value: string; label: string }>>([]);
        publishCatalog = () => setOptions([{ value: 'catalog-only-codex', label: 'Catalog only Codex' }]);
        return (
            <React.Profiler id="option-picker" onRender={() => { commitCount += 1; }}>
                <OptionPickerOverlay
                    title="Model"
                    options={options}
                    selectedValue="catalog-only-codex"
                    emptyText="Empty"
                    canEnterCustomValue
                    getCustomValue={readCustomValue}
                    onSelect={() => {}}
                />
            </React.Profiler>
        );
    }

    const screen = await renderScreen(<Host />);
    expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeTruthy();
    const commitsBeforeCatalogArrival = commitCount;

    await act(async () => {
        publishCatalog?.();
    });

    expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
    // One commit publishes the catalog and SelectionList may reconcile its changed
    // root scope once. The picker itself must not add a passive state-write commit.
    expect(commitCount - commitsBeforeCatalogArrival).toBeLessThanOrEqual(2);
});
