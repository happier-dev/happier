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
    return Object.fromEntries(
        componentNames.map((componentName) => [componentName, createPassThroughComponent(componentName)]),
    );
}
