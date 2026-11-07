import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { Modal } from '@/modal';
import type { CustomModalComponentType, CustomModalShowConfig } from '@/modal/types';

/** The Share control (or the ⋯ holding "Share…") the sheet hangs from on wide layouts. */
export type ShareSheetAnchor = PopoverAnchor;

/**
 * How every share sheet opens, decided once: on desktop and tablet the card hangs from the Share control
 * that opened it as an anchored popover (below it, staying in the window); on a phone it is a bottom sheet.
 * Without an anchor it stays a centred card. Each thing's sheet supplies only its body, title and subtitle.
 * Returns the modal id, so an opener that unmounts can close its sheet.
 */
export function presentShareSheet<C extends CustomModalComponentType<any>>(params: Readonly<{
    component: C;
    props: CustomModalShowConfig<C>['props'];
    title: string;
    subtitle?: React.ReactNode;
    testID: string;
    anchor?: ShareSheetAnchor;
}>): string {
    return Modal.show({
        component: params.component,
        props: params.props,
        chrome: createAnchoredSheetChrome(params),
        closeOnBackdrop: true,
    } as CustomModalShowConfig<C>);
}

