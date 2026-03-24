import * as React from 'react';

export type UiTextModuleMockOptions = Readonly<{
    TextTag?: string;
    TextInputTag?: string;
}>;

function createHostComponent(tagName: string) {
    return ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
        React.createElement(tagName, props, children ?? null);
}

export function createUiTextModuleMock(options: UiTextModuleMockOptions = {}) {
    const TextTag = options.TextTag ?? 'Text';
    const TextInputTag = options.TextInputTag ?? 'TextInput';
    return {
        TextSelectabilityScope: ({ children }: Readonly<{ selectable: boolean; children: React.ReactNode }>) => (
            <>{children}</>
        ),
        Text: createHostComponent(TextTag),
        TextInput: createHostComponent(TextInputTag),
    };
}

export function installUiTextModuleMock(options: UiTextModuleMockOptions = {}) {
    return () => createUiTextModuleMock(options);
}
