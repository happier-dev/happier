import * as React from 'react';

type CapturingListMockOptions = {
    componentName?: string;
    itemWrapperName?: string;
    renderItems?: boolean;
    /** Native viewport substitute; the captured data still contains the complete corpus. */
    renderItemLimit?: number;
};

type CapturingFlatListMockState = {
    props: any | null;
};

type CreateCapturingListMockOptions = CapturingListMockOptions & {
    componentName: string;
    itemWrapperName: string;
};

function renderListComponent(
    props: any,
    options: Pick<CreateCapturingListMockOptions, 'componentName' | 'itemWrapperName' | 'renderItems' | 'renderItemLimit'>,
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
        : Array.isArray(props.sections)
            ? props.sections.flatMap((section: { key?: string; data: readonly unknown[] }, sectionIndex: number) => [
                React.createElement(React.Fragment, { key: `section-${section.key ?? sectionIndex}` },
                    props.renderSectionHeader?.({ section }),
                    ...section.data.map((item: unknown, index: number) => React.createElement(
                        options.itemWrapperName,
                        { key: typeof props.keyExtractor === 'function' ? props.keyExtractor(item, index) : index },
                        props.renderItem?.({ item, index, section }) ?? null,
                    )),
                    props.renderSectionFooter?.({ section }),
                ),
            ])
        : Array.isArray(props.data)
            ? props.data.slice(0, options.renderItemLimit).map((item: any, index: number) => {
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

export function createCapturingFlatListMock(
    options: CapturingListMockOptions = {},
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
            renderItemLimit: options.renderItemLimit,
        });
    };

    return {
        module: { FlatList },
        state,
    };
}

/** The same OS rendering boundary for a grouped list; real grouping/selection stay above it. */
export function createCapturingSectionListMock(options: CapturingListMockOptions = {}) {
    const list = createCapturingFlatListMock({
        componentName: 'SectionList', itemWrapperName: 'SectionListItem', ...options,
    });
    return { module: { SectionList: list.module.FlatList }, state: list.state };
}
