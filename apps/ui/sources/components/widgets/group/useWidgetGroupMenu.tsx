import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetInputBindingsV1, WidgetLayoutGroupV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { useWidgetGroupInputsEditor } from './useWidgetGroupInputsEditor';
import { useWidgetGroupKeepFlows } from './useWidgetGroupKeepFlows';
import { describeWidgetGroup, type WidgetGroupMenuInput, type WidgetGroupOperations } from './widgetGroupMenu';

/** The full group menu and its flows, shared by titled headers and Customize on every host. */
export function useWidgetGroupMenu(input: Readonly<{
    group: WidgetLayoutGroupV1;
    childTitle: (instanceId: string) => string;
    candidates: readonly (WidgetCandidate | null)[];
    scope: WidgetSurfaceRefV1 | null;
    context: WidgetSurfaceContext;
    operations: WidgetGroupOperations;
    showWidth: boolean;
    /** Explicitly absent for read-only hosts. */
    rename: ((title: string | undefined) => void | Promise<void>) | undefined;
    setInputs: ((bindings: WidgetInputBindingsV1) => Promise<unknown>) | undefined;
    testID: string;
}>): Readonly<{
    menuInput: WidgetGroupMenuInput;
    anchorRef: React.RefObject<View | null>;
    renameField: React.ReactElement | null;
    /** The group's name write (an empty name makes it untitled); absent for read-only hosts. */
    commitName: ((next: string) => void | Promise<void>) | undefined;
    overlays: React.ReactNode;
}> {
    const { group, childTitle, scope, testID } = input;
    const name = describeWidgetGroup(group, childTitle);
    const rename = input.rename;
    const commitName = rename ? (next: string) => {
        const title = next.length > 0 ? next : undefined;
        if (title !== group.title) return rename(title);
    } : undefined;
    const renaming = useWidgetFrameRename({
        title: group.title ?? '',
        testID,
        ...(commitName ? { onRename: commitName } : {}),
    });
    const inputs = useWidgetGroupInputsEditor({
        group, candidates: input.candidates, title: name, scope, context: input.context,
        childTitle, setInputs: input.setInputs, testID,
    });
    const keep = useWidgetGroupKeepFlows({ group, name, scope, candidates: input.candidates, anchorRef: inputs.anchorRef, testID });
    return {
        menuInput: {
            group, childTitle, operations: input.operations, showWidth: input.showWidth,
            editInputs: inputs.editInputs, onRename: renaming.begin, onSave: keep.onSave, onAddTo: keep.onAddTo,
        },
        anchorRef: inputs.anchorRef,
        renameField: renaming.field,
        commitName,
        overlays: <>{inputs.popover}{keep.overlay}</>,
    };
}
