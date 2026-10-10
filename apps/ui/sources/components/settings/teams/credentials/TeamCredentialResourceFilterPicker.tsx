import * as React from 'react';
import type { TeamCredentialResourceListFilterV1 } from '@happier-dev/protocol/teams';

import { Item } from '@/components/ui/lists/Item';
import {
    SelectionList,
    resolvePopoverSelectionListHeightBehavior,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import { getPreferredLanguage, t } from '@/text';

const FILTERS: readonly TeamCredentialResourceListFilterV1[] = Object.freeze([
    'all',
    'needs_attention',
    'brokered',
    'direct',
    'external_api',
]);

function filterLabel(filter: TeamCredentialResourceListFilterV1): string {
    switch (filter) {
        case 'all':
            return t('common.all');
        case 'needs_attention':
            return t('teams.credentials.state.needsAttention');
        case 'brokered':
            return t('teams.credentials.delivery.brokered');
        case 'direct':
            return t('teams.credentials.delivery.direct');
        case 'external_api':
            return t('teams.credentials.externalApi.title');
    }
}

function FilterPickerContent(props: Readonly<{
    rootStep: SelectionListStep;
    selected: TeamCredentialResourceListFilterV1;
    onSelect: (filter: TeamCredentialResourceListFilterV1) => void;
    onClose: () => void;
}>) {
    return (
        <SelectionList
            testID="team-credentials-filter-picker"
            rootStep={props.rootStep}
            selectedOptionId={props.selected}
            listAccessibilityLabel={t('teams.credentials.title')}
            maxHeight={520}
            heightBehavior={resolvePopoverSelectionListHeightBehavior()}
            keyboardHintsEnabled
            onRequestClose={props.onClose}
            onSelect={(optionId) => {
                if (!FILTERS.includes(optionId as TeamCredentialResourceListFilterV1)) return;
                props.onSelect(optionId as TeamCredentialResourceListFilterV1);
                props.onClose();
            }}
        />
    );
}

/**
 * The administration query's one filter chooser.
 *
 * SelectionList owns search, keyboard movement, virtualization and platform
 * presentation. The chosen value is only an input to the Home-owned list
 * evaluator; this component never filters retained resource rows itself.
 */
export const TeamCredentialResourceFilterPicker = React.memo(function TeamCredentialResourceFilterPicker(props: Readonly<{
    value: TeamCredentialResourceListFilterV1;
    disabled?: boolean;
    onChange: (filter: TeamCredentialResourceListFilterV1) => void;
}>) {
    const modalIdRef = React.useRef<string | null>(null);
    const locale = getPreferredLanguage();
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'team-credential-resource-filters',
        inputPlaceholder: t('common.search'),
        sections: [{
            kind: 'static',
            id: 'filters',
            options: FILTERS.map((filter) => ({
                id: filter,
                testID: `team-credentials-filter:${filter}`,
                label: filterLabel(filter),
            })),
        }],
    }), [locale]);
    const close = React.useCallback(() => {
        if (modalIdRef.current === null) return;
        Modal.hide(modalIdRef.current);
        modalIdRef.current = null;
    }, []);
    const open = React.useCallback(() => {
        if (props.disabled) return;
        close();
        modalIdRef.current = Modal.show({
            component: FilterPickerContent,
            props: {
                rootStep,
                selected: props.value,
                onSelect: props.onChange,
            },
            chrome: {
                kind: 'card',
                title: t('teams.credentials.title'),
                testID: 'team-credentials-filter:modal',
                scrollHost: 'body',
                bodyScroll: 'none',
            },
            closeOnBackdrop: true,
        });
    }, [close, locale, props.disabled, props.onChange, props.value, rootStep]);

    React.useEffect(() => close, [close]);

    return (
        <Item
            testID="team-credentials-filter"
            title={filterLabel(props.value)}
            accessibilityLabel={`${t('teams.credentials.title')}, ${filterLabel(props.value)}`}
            disabled={props.disabled}
            onPress={open}
        />
    );
});
