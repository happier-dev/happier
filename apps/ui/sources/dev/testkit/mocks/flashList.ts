import * as React from 'react';

type CapturingFlashListMockOptions = {
    componentName?: string;
    itemWrapperName?: string;
    renderItems?: boolean;
    refHandle?: unknown;
};

type CapturingFlashListMockState = {
    props: any | null;
    refHandle: unknown;
};

type CapturingFlatListMockState = {
    props: any | null;
};

type CreateCapturingListMockOptions = CapturingFlashListMockOptions & {
    componentName: string;
    itemWrapperName: string;
};

function renderListComponent(
    props: any,
    options: Pick<CreateCapturingListMockOptions, 'componentName' | 'itemWrapperName' | 'renderItems'>,
) {
    const renderAuxiliaryComponent = (component: any) => {
        if (!component) return null;
        if (React.isValidElement(component)) return component;
        return React.createElement(component);
    };
    const header = renderAuxiliaryComponent(props.ListHeaderComponent);
    const footer = renderAuxiliaryComponent(props.ListFooterComponent);
    const items = options.renderItems === false
        ? []
        : Array.isArray(props.data)
            ? props.data.map((item: any, index: number) => {
                const key = typeof props.keyExtractor === 'function'
                    ? props.keyExtractor(item, index)
                    : item?.id ?? String(index);
                const child = typeof props.renderItem === 'function'
                    ? props.renderItem({ item, index })
                    : null;
                return React.createElement(options.itemWrapperName, { key }, child);
            })
            : [];

    return React.createElement(options.componentName, props, header, ...items, footer);
}

export function createCapturingFlashListMock(
    options: CapturingFlashListMockOptions = {},
): {
    module: {
        FlashList: React.ForwardRefExoticComponent<any>;
    };
    state: CapturingFlashListMockState;
} {
    const componentName = options.componentName ?? 'FlashList';
    const itemWrapperName = options.itemWrapperName ?? 'FlashListItem';
    const state: CapturingFlashListMockState = {
        props: null,
        refHandle: options.refHandle ?? {
            scrollToOffset: () => {},
            scrollToIndex: () => {},
        },
    };

    const FlashList = React.forwardRef<any, any>((props, ref) => {
        state.props = props;

        if (typeof ref === 'function') {
            ref(state.refHandle);
        } else if (ref && typeof ref === 'object') {
            ref.current = state.refHandle;
        }
        return renderListComponent(props, {
            componentName,
            itemWrapperName,
            renderItems: options.renderItems,
        });
    });

    return {
        module: { FlashList },
        state,
    };
}

export function createCapturingFlatListMock(
    options: CapturingFlashListMockOptions = {},
): {
    module: {
        FlatList: (props: any) => React.ReactElement;
    };
    state: CapturingFlatListMockState;
} {
    const componentName = options.componentName ?? 'FlatList';
    const itemWrapperName = options.itemWrapperName ?? 'FlatListItem';
    const state: CapturingFlatListMockState = {
        props: null,
    };

    const FlatList = (props: any) => {
        state.props = props;
        return renderListComponent(props, {
            componentName,
            itemWrapperName,
            renderItems: options.renderItems,
        });
    };

    return {
        module: { FlatList },
        state,
    };
}
