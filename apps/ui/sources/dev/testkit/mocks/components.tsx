import * as React from 'react';

type HostProps = Record<string, unknown> & {
    children?: React.ReactNode;
};

export function createPassThroughComponent(componentName: string) {
    return function PassThroughComponent(props: HostProps) {
        return React.createElement(componentName, props, props.children);
    };
}

export function createCapturingComponent(
    componentName: string,
    capture: (props: HostProps) => void,
) {
    return function CapturingComponent(props: HostProps) {
        capture(props);
        return React.createElement(componentName, props, props.children);
    };
}

export function createPassThroughModule(componentNames: readonly string[]) {
    const names = new Set(componentNames);
    if (names.has('ItemList')) {
        names.add('ItemListStatic');
    }
    if (names.has('ItemListStatic')) {
        names.add('ItemList');
    }

    return Object.fromEntries(
        Array.from(names).map((componentName) => [componentName, createPassThroughComponent(componentName)]),
    );
}
