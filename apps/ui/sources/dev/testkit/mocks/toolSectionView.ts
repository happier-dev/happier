import * as React from 'react';

import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type ToolSectionViewModule = typeof import('@/components/tools/shell/presentation/ToolSectionView');

type ToolSectionViewMockProps = Readonly<Record<string, unknown> & {
    children?: React.ReactNode;
}>;

type ToolSectionViewRenderMode = 'fragment' | 'host' | 'null';

export type CreateToolSectionViewModuleMockOptions = Readonly<
    Omit<MergeModuleMockOptions<ToolSectionViewModule>, 'overrides'> & {
        mode?: ToolSectionViewRenderMode;
        overrides?: Partial<ToolSectionViewModule>;
    }
>;

function createToolSectionViewMockComponent(mode: ToolSectionViewRenderMode) {
    return function ToolSectionViewMock(props: ToolSectionViewMockProps) {
        if (mode === 'null') {
            return null;
        }

        if (mode === 'host') {
            return React.createElement('ToolSectionView', props, props.children);
        }

        return React.createElement(React.Fragment, null, props.children);
    };
}

export async function createToolSectionViewModuleMock({
    importOriginal,
    mode = 'fragment',
    overrides,
}: CreateToolSectionViewModuleMockOptions): Promise<ToolSectionViewModule> {
    return mergeModuleMock<ToolSectionViewModule>({
        importOriginal,
        overrides: {
            ...overrides,
            ToolSectionView: createToolSectionViewMockComponent(mode) as ToolSectionViewModule['ToolSectionView'],
        },
    });
}

export function installToolSectionViewModuleMock(mode: ToolSectionViewRenderMode = 'fragment') {
    return async (importOriginal: <T>() => Promise<T>) =>
        createToolSectionViewModuleMock({
            importOriginal,
            mode,
        });
}
